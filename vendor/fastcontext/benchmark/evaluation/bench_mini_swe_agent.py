#!/usr/bin/env python3
"""
bench_mini_swe_agent.py — End-to-end SWE-bench benchmark for mini-swe-agent + fastcontext.

Runs mini-swe-agent (with fastcontext as a code search tool) on SWE-bench instances
inside Docker containers. Produces:
  1. Trajectories (mini-swe-agent native format) in the logs directory
  2. Patches (model_patch) in SWE-bench predictions format (preds.json)
"""

import argparse
import concurrent.futures
import json
import logging
import os
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path

# Add third_party/mini-swe-agent to sys.path so we can import minisweagent
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "third_party" / "mini-swe-agent" / "src"))

os.environ["MSWEA_SILENT_STARTUP"] = "1"
os.environ["MSWEA_COST_TRACKING"] = "ignore_errors"

import datasets  # noqa: E402
import yaml  # noqa: E402
from tqdm import tqdm  # noqa: E402

from minisweagent.agents.default import DefaultAgent  # noqa: E402
from minisweagent.environments.docker import DockerEnvironment  # noqa: E402
from minisweagent.models import get_model  # noqa: E402
from minisweagent.utils.serialize import recursive_merge  # noqa: E402

logger = logging.getLogger("bench_mini_swe_agent")

DATASET_MAPPING = {
    "swebench-verified": "princeton-nlp/SWE-Bench_Verified",
    "swebench-lite": "princeton-nlp/SWE-Bench_Lite",
    "swebench-multilingual": "SWE-bench/SWE-bench_Multilingual",
}

WRITE_LOCK = threading.Lock()

# Paths
FASTCONTEXT_WHEEL = REPO_ROOT / "dist" / "fastcontext-0.1.0-py3-none-any.whl"


def resolve_repo_path(path: str | Path) -> Path:
    """Resolve a CLI path relative to the repository root."""
    path = Path(path)
    return path if path.is_absolute() else REPO_ROOT / path


def default_agent_config_for_bench(bench: str) -> Path:
    """Choose a bundled mini-swe-agent prompt config for the benchmark family."""
    if "pro" in bench.lower():
        return REPO_ROOT / "prompts" / "gpt-pro-fc.yaml"
    return REPO_ROOT / "prompts" / "gpt-multi-fc.yaml"


def load_env_config(config_path: str) -> dict[str, str]:
    """Load KEY=VALUE config from a .env file."""
    env_vars = {}
    with open(config_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                env_vars[key.strip()] = value.strip()
    return env_vars


def get_docker_image_name(instance: dict) -> str:
    """Get the SWE-bench Docker image name for an instance."""
    if image := instance.get("docker_image") or instance.get("image_name"):
        return image
    iid = instance["instance_id"]
    name = iid.replace("__", "_1776_")
    return f"docker.io/swebench/sweb.eval.x86_64.{name}:latest".lower()


def build_agent_config(
    base_config: dict,
    main_model_name: str,
    main_model_kwargs: dict | None = None,
    main_model_class: str | None = None,
) -> dict:
    """Build the final agent config by merging base config with model overrides."""
    overrides = {"model": {"model_name": main_model_name}}
    if main_model_kwargs:
        overrides["model"]["model_kwargs"] = main_model_kwargs
    if main_model_class:
        overrides["model"]["model_class"] = main_model_class
    return recursive_merge(base_config, overrides)


def setup_fastcontext_in_container(env: DockerEnvironment, fastcontext_env_vars: dict[str, str]):
    """Copy the FastContext wheel into the container and install its CLI."""
    container_id = env.container_id
    staging = "/tmp/fastcontext_setup"

    # Create staging dir
    env.execute({"command": f"mkdir -p {staging}"}, timeout=10)

    # Copy wheel
    subprocess.run(
        ["docker", "cp", str(FASTCONTEXT_WHEEL), f"{container_id}:{staging}/fastcontext-0.1.0-py3-none-any.whl"],
        check=True, capture_output=True, timeout=60,
    )

    install_cmd = f"""
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ripgrep
curl -LsSf https://astral.sh/uv/install.sh | sh
source "$HOME/.local/bin/env"
uv tool install {staging}/fastcontext-0.1.0-py3-none-any.whl --with requests
ln -sf "$HOME/.local/bin/fastcontext" /usr/local/bin/fastcontext || true
fastcontext --help >/dev/null
""".strip()
    result = env.execute({"command": install_cmd}, timeout=300)
    if result["returncode"] != 0:
        raise RuntimeError(f"fastcontext setup failed: {result['output']}")

    logger.info(f"fastcontext installed in container {container_id}")


def extract_fastcontext_trajectories(env: DockerEnvironment, dest_dir: Path):
    """Copy fastcontext ATIF trajectory files from container before cleanup.

    fastcontext writes trajectories to /testbed/.fastcontext/trajectory_<timestamp>.jsonl
    inside the container. This function extracts them to the host for analysis.
    """
    container_id = env.container_id
    if not container_id:
        return
    dest_dir.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            ["docker", "cp", f"{container_id}:/testbed/.fastcontext/.", str(dest_dir)],
            capture_output=True, timeout=30,
        )
        if result.returncode == 0:
            # Count extracted files
            traj_files = list(dest_dir.glob("trajectory_*.json*"))
            logger.info(f"Extracted {len(traj_files)} fastcontext trajectory file(s) to {dest_dir}")
        else:
            logger.debug("No fastcontext trajectories found in container (dir may not exist)")
    except Exception as e:
        logger.warning(f"Failed to extract fastcontext trajectories: {e}")


def process_instance(
    instance: dict,
    config: dict,
    logs_dir: Path,
    output_path: Path,
    fastcontext_env_vars: dict[str, str],
    no_fastcontext: bool = False,
) -> dict:
    """Process a single SWE-bench instance end-to-end."""
    instance_id = instance["instance_id"]
    task = instance["problem_statement"]
    image_name = get_docker_image_name(instance)

    instance_log_dir = logs_dir / instance_id
    instance_log_dir.mkdir(parents=True, exist_ok=True)

    env = None
    agent = None
    exit_status = None
    submission = ""
    extra_info = {}
    start_time = time.time()

    try:
        # Create Docker environment with fastcontext env vars injected
        env_config = config.get("environment", {}).copy()
        env_config["image"] = image_name
        env_config.pop("environment_class", None)
        # Inject FASTCONTEXT_* env vars so they're available in every docker exec call
        docker_env = env_config.get("env", {}).copy()
        docker_env.update(fastcontext_env_vars)
        env_config["env"] = docker_env
        env = DockerEnvironment(**env_config)

        # Install fastcontext in the container (skip in baseline mode)
        if not no_fastcontext:
            setup_fastcontext_in_container(env, fastcontext_env_vars)

        # Create model and agent
        model = get_model(config=config.get("model", {}))
        traj_path = instance_log_dir / f"{instance_id}.traj.json"

        agent = DefaultAgent(
            model,
            env,
            output_path=traj_path,
            **config.get("agent", {}),
        )

        # Run the agent
        info = agent.run(task)
        exit_status = info.get("exit_status", "unknown")
        submission = info.get("submission", "")

    except Exception as e:
        logger.error(f"Error processing {instance_id}: {e}", exc_info=True)
        exit_status = type(e).__name__
        extra_info = {"traceback": traceback.format_exc(), "exception_str": str(e)}

    finally:
        elapsed = time.time() - start_time

        # Save trajectory
        if agent is not None:
            traj_path = instance_log_dir / f"{instance_id}.traj.json"
            agent.save(
                traj_path,
                {
                    "info": {
                        "exit_status": exit_status,
                        "submission": submission,
                        **extra_info,
                    },
                    "instance_id": instance_id,
                    "elapsed_seconds": elapsed,
                },
            )

        # Extract fastcontext trajectories before container cleanup
        if env is not None and not no_fastcontext:
            fastcontext_traj_dest = instance_log_dir / "fastcontext_trajs"
            extract_fastcontext_trajectories(env, fastcontext_traj_dest)

        # Update predictions file (SWE-bench format)
        pred_entry = {
            "model_name_or_path": config.get("model", {}).get("model_name", "unknown"),
            "instance_id": instance_id,
            "model_patch": submission,
        }
        with WRITE_LOCK:
            preds = {}
            if output_path.exists():
                preds = json.loads(output_path.read_text(encoding="utf-8"))
            preds[instance_id] = pred_entry
            output_path.write_text(json.dumps(preds, indent=2), encoding="utf-8")

        # Cleanup
        if env is not None:
            env.cleanup()

    return {
        "instance_id": instance_id,
        "exit_status": exit_status,
        "elapsed": elapsed,
        "has_patch": bool(submission),
    }


def load_benchmark_data(bench: str) -> list[dict]:
    """Load benchmark dataset."""
    bench_resolved = DATASET_MAPPING.get(bench, bench)
    if bench_resolved.endswith(".jsonl"):
        assert os.path.exists(bench_resolved), f"Dataset file {bench_resolved} does not exist."
        with open(bench_resolved, encoding="utf-8") as f:
            return [json.loads(line) for line in f if line.strip()]
    else:
        return list(datasets.load_dataset(bench_resolved, split="test"))


def main():
    parser = argparse.ArgumentParser(description="Benchmark mini-swe-agent + fastcontext on SWE-bench")
    parser.add_argument("--bench", type=str, default="swebench-multilingual",
                        help="Benchmark dataset name or path to JSONL file")
    parser.add_argument("--experiment", type=str, default="mini-swe-agent-fastcontext",
                        help="Experiment name")
    parser.add_argument("--config", type=str, default=None,
                        help="Path to model config .env file (main agent + fastcontext)")
    parser.add_argument("--agent-config", type=str, default=None,
                        help="Path to mini-swe-agent YAML config. Defaults to a bundled prompts/*.yaml config")
    parser.add_argument("--baseline-agent-config", type=str, default=None,
                        help="Path to mini-swe-agent YAML config used with --no-fastcontext")
    parser.add_argument("--logs-dir", type=str, default="logs",
                        help="Directory to save agent trajectories")
    parser.add_argument("--output", "-o", type=str, default="preds.json",
                        help="Path to predictions output file")
    parser.add_argument("--workers", "-w", type=int, default=1,
                        help="Number of parallel workers")
    parser.add_argument("--run-head", type=int, default=None,
                        help="Only run first N instances")
    parser.add_argument("--filter", type=str, default="",
                        help="Filter instance IDs by regex")
    parser.add_argument("--redo-existing", action="store_true",
                        help="Re-run instances that already have predictions")
    parser.add_argument("--no-fastcontext", action="store_true",
                        help="Baseline mode: skip fastcontext installation, use vanilla config")
    args = parser.parse_args()

    logs_base = Path(args.logs_dir)
    logs_base.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler(str(logs_base / "bench.log")),
        ],
    )

    # Load mini-swe-agent prompt/config YAML.
    if args.no_fastcontext:
        if not args.baseline_agent_config:
            logger.error("--baseline-agent-config is required when using --no-fastcontext")
            sys.exit(1)
        config_path = resolve_repo_path(args.baseline_agent_config)
    else:
        config_path = resolve_repo_path(args.agent_config) if args.agent_config else default_agent_config_for_bench(args.bench)
    if not config_path.exists():
        logger.error(f"mini-swe-agent config not found: {config_path}")
        sys.exit(1)
    logger.info(f"mini-swe-agent config: {config_path}")
    base_config = yaml.safe_load(config_path.read_text(encoding="utf-8"))

    # Load model config from .env file
    env_config = {}
    if args.config:
        env_config = load_env_config(args.config)

    # Set main agent env vars (litellm reads from os.environ for API keys)
    for key in ["AZURE_API_KEY", "AZURE_API_BASE", "AZURE_API_VERSION",
                 "OPENAI_API_KEY", "OPENAI_API_BASE",
                 "ANTHROPIC_API_KEY"]:
        if value := env_config.get(key):
            os.environ[key] = value

    # Split config into main agent vs fastcontext
    main_model_name = env_config.get("MAIN_MODEL", "")
    if not main_model_name:
        logger.error("MAIN_MODEL is required in config file")
        sys.exit(1)

    main_model_kwargs = {}
    if temp := env_config.get("MAIN_TEMPERATURE"):
        main_model_kwargs["temperature"] = float(temp)
    if env_config.get("MAIN_DROP_PARAMS", "true").lower() == "true":
        main_model_kwargs["drop_params"] = True
    # Pass Azure credentials directly in model_kwargs for litellm
    if api_key := env_config.get("AZURE_API_KEY"):
        main_model_kwargs["api_key"] = api_key
    if api_base := env_config.get("AZURE_API_BASE"):
        main_model_kwargs["api_base"] = api_base
    if api_version := env_config.get("AZURE_API_VERSION"):
        main_model_kwargs["api_version"] = api_version
    # Also support OpenAI/Anthropic direct keys
    if api_key := env_config.get("OPENAI_API_KEY"):
        main_model_kwargs["api_key"] = api_key
    if api_key := env_config.get("ANTHROPIC_API_KEY"):
        main_model_kwargs["api_key"] = api_key

    # Build fastcontext env vars (FASTCONTEXT_* prefix)
    fastcontext_env_vars = {}
    for key, value in env_config.items():
        if key.startswith("FASTCONTEXT_"):
            fastcontext_env_vars[key] = value

    # Build final config
    main_model_class = env_config.get("MAIN_MODEL_CLASS", None)
    config = build_agent_config(base_config, main_model_name, main_model_kwargs, main_model_class)

    # Load dataset
    samples = load_benchmark_data(args.bench)
    logger.info(f"Loaded {len(samples)} instances from {args.bench}")

    if args.filter:
        import re
        samples = [s for s in samples if re.match(args.filter, s["instance_id"])]
        logger.info(f"After filter: {len(samples)} instances")

    if args.run_head is not None:
        samples = samples[:args.run_head]
        logger.info(f"Running first {args.run_head} instances")

    # Resume: skip completed instances
    output_path = Path(args.output)
    if not args.redo_existing and output_path.exists():
        existing = json.loads(output_path.read_text(encoding="utf-8"))
        completed_ids = {iid for iid, pred in existing.items() if pred.get("model_patch")}
        before = len(samples)
        samples = [s for s in samples if s["instance_id"] not in completed_ids]
        logger.info(f"Resuming: {before - len(samples)} completed, {len(samples)} remaining")

    if not samples:
        logger.info("All instances already completed.")
        return

    logs_dir = Path(args.logs_dir) / args.experiment
    logs_dir.mkdir(parents=True, exist_ok=True)

    # Check fastcontext wheel exists (skip in baseline mode)
    if not args.no_fastcontext and not FASTCONTEXT_WHEEL.exists():
        logger.error(f"fastcontext wheel not found at {FASTCONTEXT_WHEEL}. Run: cd {REPO_ROOT} && uv build")
        sys.exit(1)

    logger.info(f"Starting {len(samples)} instances with {args.workers} workers")
    logger.info(f"Main model: {main_model_name}")
    logger.info(f"fastcontext: {'disabled (baseline)' if args.no_fastcontext else fastcontext_env_vars.get('FASTCONTEXT_MODEL', 'N/A')}")
    logger.info(f"Logs: {logs_dir}")
    logger.info(f"Output: {output_path}")

    n_success = 0
    n_fail = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        future_to_id = {
            executor.submit(
                process_instance,
                instance=sample,
                config=config,
                logs_dir=logs_dir,
                output_path=output_path,
                fastcontext_env_vars=fastcontext_env_vars,
                no_fastcontext=args.no_fastcontext,
            ): sample["instance_id"]
            for sample in samples
        }

        with tqdm(total=len(samples), desc="Running") as pbar:
            for future in concurrent.futures.as_completed(future_to_id):
                instance_id = future_to_id[future]
                try:
                    result = future.result(timeout=3600)
                    status = result["exit_status"]
                    has_patch = result["has_patch"]
                    elapsed = result["elapsed"]
                    if status == "Submitted" and has_patch:
                        n_success += 1
                        pbar.set_postfix_str(f"✓ {instance_id} ({elapsed:.0f}s)")
                    else:
                        n_fail += 1
                        pbar.set_postfix_str(f"✗ {instance_id}: {status}")
                except Exception as e:
                    n_fail += 1
                    pbar.set_postfix_str(f"✗ {instance_id}: {e}")
                    logger.error(f"Uncaught error for {instance_id}: {e}", exc_info=True)
                pbar.update(1)

    logger.info(f"Done. Success: {n_success}, Failed: {n_fail}, Total: {n_success + n_fail}")


if __name__ == "__main__":
    main()
