import argparse
import json
import logging
import os
import shlex
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import datasets
from tqdm import tqdm

DATASET_MAPPING = {
    "swebench-verified": "princeton-nlp/SWE-Bench_Verified",
    "swebench-multilingual": "SWE-bench/SWE-bench_Multilingual",
    "swebench-pro": "ScaleAI/SWE-bench_Pro",
}

WRITE_LOCK = threading.Lock()


class DockerEnvironment:
    def __init__(self, *, logger: logging.Logger | None = None, **kwargs):
        """This class executes bash commands in a Docker container using direct docker commands."""
        self.forward_env = []
        self.logger = logger or logging.getLogger("[agent.docker_env]")
        self.container_id = None
        self.image = kwargs.get("image")
        self.name_prefix = kwargs.get("name_prefix", "fastcontext")
        self.instance_id = kwargs.get("instance_id")
        self.cwd = kwargs.get("cwd", "/workspace")
        self.mount_items = kwargs.get("mount_items", [])
        self._start_container(self.image, self.instance_id, self.cwd, mount_items=self.mount_items)

    def _start_container(self, image: str, instance_id: str, cwd: str, mount_items: list[tuple[str, str]]) -> str:
        """Start the Docker container and return the container ID."""
        container_name = f"{self.name_prefix}-{instance_id}"
        cmd = [
            "docker",
            "run",
            "-d",
            "--name",
            container_name,
        ]
        # add mounts
        for local_path, container_path in mount_items:
            mode = "rw"
            mount_str = f"{local_path}:{container_path}:{mode}"
            cmd.extend(["-v", mount_str])

        # rest of the command
        cmd.extend(
            [
                "-w",
                cwd,
                "--rm",
                image,
                "sleep",
                "1800",  # keep the container running for 30 minutes
            ]
        )

        self.logger.info(f"Starting container with command: {shlex.join(cmd)}")
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=900,  # docker pull might take a while
            check=True,
        )
        self.logger.info(f"Started container {container_name} with ID {result.stdout.strip()}")
        self.container_id = result.stdout.strip()

    def execute(self, command: str, cwd: str, *, timeout: int = 60) -> dict[str, Any]:
        """Execute a command in the Docker container and return the result."""
        assert self.container_id, "Container not started"

        cmd = ["docker", "exec", "-w", cwd]
        for key in self.forward_env:
            if (value := os.getenv(key)) is not None:
                cmd.extend(["-e", f"{key}={value}"])
        cmd.extend([self.container_id, "bash", "-lc", command])

        result = subprocess.run(
            cmd,
            text=True,
            timeout=timeout,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        return {"returncode": result.returncode, "output": result.stdout}

    def cleanup(self):
        if self.container_id is not None:
            cmd = f"(timeout 60 docker stop {self.container_id} || docker rm -f {self.container_id}) >/dev/null 2>&1 &"
            subprocess.Popen(cmd, shell=True)

    def __del__(self):
        self.cleanup()

    def copy_to_container(self, src: str, dest: str):
        """Copy a file or directory to the Docker container."""
        cmd = ["docker", "cp", src, f"{self.container_id}:{dest}"]
        self.logger.info(f"Copying to container with command: {shlex.join(cmd)}")
        result = subprocess.run(
            cmd,
            text=True,
            timeout=60,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        self.logger.info(f"Copied {src} to container {self.container_id}:{dest}")
        return {"returncode": result.returncode, "output": result.stdout}

    def get_traj(self, traj_file: str) -> dict[str, Any]:
        return self.execute(f"cat {traj_file}", cwd=self.cwd)


def get_swebench_docker_image_name(instance_id: str) -> str:
    name = instance_id.replace("__", "_1776_")
    # e.g.,
    # instance_id: apache__druid-13704 -> apache_1776_druid-13704
    # swebench/sweb.eval.x86_64.apache_1776_druid-13704
    # ref: https://hub.docker.com/r/swebench/sweb.eval.x86_64.apache_1776_druid-13704
    image_name = f"docker.io/swebench/sweb.eval.x86_64.{name}:latest".lower()
    return image_name


def run_agent_in_docker(uid: str, experiment: str, sample: dict, local_mount_dir: str, prediction_file: str):
    task_start_time = time.time()
    instance_id = sample["instance_id"]
    image_name = sample.get("docker_image") or get_swebench_docker_image_name(instance_id)
    arguments = sample["subagent"]["tool_calls"][0]["arguments"]
    if isinstance(arguments, str):
        arguments = json.loads(arguments)
    prompt = arguments["prompt"]
    query = f"<query>{prompt}</query>"
    # os make dir for query file if not exists
    queries_dir = os.path.join(".", experiment, "queries")
    os.makedirs(queries_dir, exist_ok=True)
    query_file = os.path.join(queries_dir, f"query_{uid}.txt")
    with open(query_file, "w", encoding="utf-8") as f:
        f.write(query)

    # if existing traj file for this instance, skip
    local_traj_dir = os.path.join(local_mount_dir, experiment, sample["instance_id"], "traj.jsonl")
    if os.path.exists(local_traj_dir):
        print(f"Traj file already exists for instance_id={sample['instance_id']}, skipping...")
        return

    agent_workdir = "/workspace"
    traj_dir = "/workspace/traj/"
    instance_container = DockerEnvironment(
        name_prefix=experiment,
        image=image_name,
        instance_id=instance_id,
        mount_items=[(local_mount_dir, traj_dir)],
    )

    instance_container.copy_to_container("../../dist/fastcontext-0.1.0-py3-none-any.whl", agent_workdir)
    instance_container.copy_to_container("run.sh", agent_workdir)
    instance_container.copy_to_container(query_file, agent_workdir)
    traj_file = os.path.join(traj_dir, experiment, instance_id, "traj.jsonl")
    full_log = instance_container.execute(
        f"bash run.sh {agent_workdir}/query_{uid}.txt {traj_file}", agent_workdir, timeout=3600
    )
    if full_log["returncode"] != 0:
        print(f"Error executing command in container for instance_id={instance_id}")
        print(f"returncode={full_log['returncode']}")
        print(f"output=\n{full_log['output']}")
    # input("Press Enter to continue...")  # for debugging, can be removed later
    traj = instance_container.get_traj(traj_file)

    time_cost = time.time() - task_start_time

    output = {
        "instance_id": instance_id,
        "time_cost": time_cost,
        "traj": traj,
        "output": full_log["output"],
        "returncode": full_log["returncode"],
    }
    with WRITE_LOCK, open(prediction_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(output) + "\n")


def run(
    experiment: str,
    prediction_file: str,
    local_mount_dir: str,
    samples: list,
    num_threads: int = 1,
):
    n_job_fail = 0
    with ThreadPoolExecutor(max_workers=num_threads) as exe:
        future_to_index = {
            exe.submit(
                run_agent_in_docker,
                uid=str(i),
                experiment=experiment,
                sample=sample,
                local_mount_dir=local_mount_dir,
                prediction_file=prediction_file,
            ): i
            for i, sample in enumerate(samples)
        }
        with tqdm(total=len(samples), desc="Running Jobs") as pbar:
            for future in as_completed(future_to_index):
                try:
                    future.result(timeout=30 * 60)  # 30 minutes per task
                    pbar.set_postfix_str(f"✓ benchmark_{future_to_index[future]}")
                except Exception as e:
                    pbar.set_postfix_str(f"✗ benchmark_{future_to_index[future]}: {e}")
                    n_job_fail += 1
                    print(f"Job failed: {e}")
                pbar.update(1)
    print(f"All Jobs processed, failed jobs: {n_job_fail}")
    return n_job_fail


def load_jsonlines(fpath: str):
    samples = []
    with open(fpath, "r", encoding="utf-8") as fr:
        for line in fr:
            samples.append(json.loads(line.strip()))
    return samples


def load_benchmark_data(bench: str):
    if bench in DATASET_MAPPING:
        bench = DATASET_MAPPING.get(bench)

    if bench.endswith(".jsonl"):
        assert os.path.exists(bench), f"Dataset file {bench} does not exist."
        samples = load_jsonlines(bench)
    else:
        samples = datasets.load_dataset(bench, split="test")

    return samples


def check_samples_query(samples: list[dict]):
    n_valid = 0
    for sample in samples:
        arguments = sample["subagent"]["tool_calls"][0]["arguments"]
        if isinstance(arguments, str):
            arguments = json.loads(arguments)
        prompt = arguments["prompt"]
        if len(prompt) > 3:
            n_valid += 1
    print(f"Valid queries: {n_valid}/{len(samples)}")
    assert n_valid == len(samples), f"got some invalid queries: {len(samples) - n_valid}"


def main(
    bench: str,
    experiment: str,
    prediction_file: str,
    local_mount_dir: str,
    num_threads: int = 1,
    run_head: int = None,
    iid: str = None,
):
    # create prediction_file if not exists
    if not os.path.exists(prediction_file):
        with open(prediction_file, "w", encoding="utf-8") as f:
            pass

    samples = load_benchmark_data(bench)
    print(f"Loaded {len(samples)} samples from {bench}")
    check_samples_query(samples)
    if run_head is not None:
        samples = samples[:run_head]
        print(f"Running head {run_head} samples")
    if iid is not None:
        samples = [s for s in samples if s["instance_id"] == iid]
    print("samples[0] =", samples[0])
    # input("Press Enter to start running the benchmark...")
    start_time = time.time()
    run(
        experiment=experiment,
        prediction_file=prediction_file,
        local_mount_dir=local_mount_dir,
        samples=samples,
        num_threads=num_threads,
    )
    time_cost = time.time() - start_time
    print(f"Finished processing {len(samples)} samples in {time_cost:.2f} seconds")

    with open(prediction_file, "r", encoding="utf-8") as f:
        returncodes = [json.loads(line.strip())["returncode"] for line in f]
        n_run_failed = sum(1 for code in returncodes if int(code) != 0)
    print(f"Number of samples with non-zero return code (failed): {n_run_failed}/{len(samples)}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bench", type=str, default="swebench-multilingual")
    parser.add_argument("--experiment", type=str, default="test")
    parser.add_argument("--num-threads", type=int, default=1)
    parser.add_argument("--run-head", type=int, default=None)
    parser.add_argument("--prediction-file", type=str, default="./predictions.jsonl")
    parser.add_argument("--local-mount-dir", type=str, default="/jumbo/workspace/fastcontext/")
    parser.add_argument("--iid", type=str, default=None)
    args = parser.parse_args()
    main(
        args.bench,
        args.experiment,
        args.prediction_file,
        args.local_mount_dir,
        args.num_threads,
        args.run_head,
        args.iid,
    )
