#!/usr/bin/env python3
"""Real four-way OCR inference benchmark on identical synthetic raster PDFs.

Not a human-gold natural-scan benchmark. Does NOT train models.
Each candidate runs in a fresh isolated Python worker process; models are
offline, hash-pinned, and evaluated on the *same* rendered PNGs.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import psutil

REPO = Path(__file__).resolve().parent.parent
OCR_PY = Path.home() / ".superagent-r" / "venvs" / "pdf-ocr-rapid" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
WORKER = REPO / "scripts" / "pdf_ocr_backend.py"
BASELINE = REPO / "scripts" / "bench-pdf-ocr-real.py"
ENGINES = ("tiny", "small", "medium", "tesseract")
SEED = 41020261104


def fixture_module():
    spec = importlib.util.spec_from_file_location("superagent_pdf_ocr_fixture", BASELINE)
    if not spec or not spec.loader:
        raise ValueError("Missing established deterministic OCR benchmark fixture.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalize(text: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", text.casefold()))


def distance(a, b):
    if len(a) < len(b):
        a, b = b, a
    row = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        new = [i]
        for j, y in enumerate(b, 1):
            new.append(min(row[j] + 1, new[-1] + 1, row[j - 1] + int(x != y)))
        row = new
    return row[-1]


def monitored_worker(request: dict) -> tuple[str, int, float, int, int]:
    """Measure worker+children RSS at ~10ms intervals from outside inference.

    This is a process-tree sampled peak, NOT kernel high-water mark, GPU/VRAM,
    or a substitute for an isolated physical 4vCPU/8GB hardware run.
    """
    started = time.perf_counter()
    child = subprocess.Popen(
        [str(OCR_PY), str(WORKER)], cwd=REPO, text=True,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    stop = threading.Event()
    peak = 0
    samples = 0

    def watch() -> None:
        nonlocal peak, samples
        try:
            leader = psutil.Process(child.pid)
        except psutil.Error:
            return
        while not stop.is_set():
            total = 0
            for member in [leader, *leader.children(recursive=True)]:
                try:
                    total += member.memory_info().rss
                except psutil.Error:
                    pass
            peak = max(peak, total)
            samples += 1
            stop.wait(0.01)

    thread = threading.Thread(target=watch, name="pdf-ocr-rss-monitor", daemon=True)
    thread.start()
    try:
        stdout, _stderr = child.communicate(json.dumps(request), timeout=130)
    except subprocess.TimeoutExpired as exc:
        child.kill()
        child.communicate()
        raise RuntimeError("A pretrained OCR worker exceeded the 130-second benchmark timeout") from exc
    finally:
        stop.set()
        thread.join(timeout=2)
    return stdout, child.returncode, time.perf_counter()-started, peak, samples


def perf_samples(engine: str, fixtures: list[dict]) -> dict:
    req = {"engine": engine, "language": "auto",
           "images": [{"path": row["png"]} for row in fixtures],
           "maxChars": 100000}
    stdout, code, elapsed, sampled_peak, rss_samples = monitored_worker(req)
    if code != 0:
        raise RuntimeError(f"Worker {engine} terminated abnormally with exit code {code}")
    try:
        data = json.loads(stdout.strip())
    except ValueError as exc:
        raise RuntimeError(f"Worker {engine} did not return valid JSON") from exc
    if data.get("status") != "verified" or len(data.get("pages", [])) != len(fixtures):
        raise RuntimeError(f"Worker {engine} did not verify every fixture: {data.get('code')}")
    samples = []
    for expected, actual in zip(fixtures, data["pages"]):
        gold = normalize(expected["gold"])
        pred = normalize(actual["text"])
        cer = distance(gold, pred) / max(1, len(gold))
        wer = distance(gold.split(), pred.split()) / max(1, len(gold.split()))
        samples.append({
            "id": expected["id"],
            "language": expected["lang"],
            "condition": expected["condition"],
            "gold": expected["gold"],
            "recognized": actual["text"],
            "cer": round(cer, 4),
            "wer": round(wer, 4),
            "runtimeSeconds": actual["elapsedSeconds"],
            "boxCount": actual["lineCount"],
            "pngSha256": expected["pngSha256"],
            "pdfSha256": expected["pdfSha256"],
        })
    lat = [sample["runtimeSeconds"] for sample in samples]
    by_lang = {}
    for lang in ("id", "en"):
        scoped = [sample for sample in samples if sample["language"] == lang]
        by_lang[lang] = {
            "count": len(scoped),
            "CER": round(statistics.mean(r["cer"] for r in scoped), 4),
            "WER": round(statistics.mean(r["wer"] for r in scoped), 4),
        }
    return {
        "engine": data.get("engine"),
        "modelHashes": data.get("modelHashes"),
        "workerRuntime": data.get("runtimeVersions"),
        "pagesProcessed": len(samples),
        "macroCER": round(statistics.mean(x["cer"] for x in samples), 4),
        "macroWER": round(statistics.mean(x["wer"] for x in samples), 4),
        "byLanguage": by_lang,
        "coldLoadSeconds": data.get("coldStartSeconds"),
        "workerWallSeconds": data.get("wallSeconds"),
        "observedRssMiB": round(sampled_peak / 1024**2, 2),
        "observedRssCaveat": "Externally sampled peak RSS of worker+child processes every 10ms; misses shorter spikes and GPU/driver allocations.",
        "workerEndOfPageRssMiB": round(float(data["observedRssBytes"]) / 1024**2, 2),
        "rssSamples": rss_samples,
        "monitorVersion": psutil.__version__,
        "endToEndProcessSeconds": round(elapsed, 4),
        "pageP50Seconds": round(statistics.median(lat), 4),
        "pageP95Seconds": round(sorted(lat)[-1] if len(lat) == 1 else
                                sorted(lat)[max(0, int((len(lat) - 1) * .95))], 4),
        "samples": samples,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", required=True)
    parser.add_argument("--markdown", required=True)
    parser.add_argument("--engines", default="tiny,small,medium,tesseract")
    parser.add_argument("--count", type=int, default=12)
    args = parser.parse_args()
    engines = tuple(x.strip() for x in args.engines.split(","))
    if not engines or len(set(engines)) != len(engines) or any(e not in ENGINES for e in engines):
        parser.error("Invalid or duplicated engines.")
    baseline = fixture_module()
    if not 1 <= args.count <= len(baseline.SAMPLES):
        parser.error("count must be within the frozen fixture list.")
    output = Path(args.json).resolve()
    markdown = Path(args.markdown).resolve()
    if not output.is_relative_to(REPO) or not markdown.is_relative_to(REPO):
        raise ValueError("Benchmark reports must be stored in the SuperAgent repository.")
    if output.exists() or markdown.exists():
        raise ValueError("Refusing to overwrite benchmark evidence.")
    font = next((font for font in
                 ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf",
                  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf") if Path(font).is_file()), None)
    if not font:
        raise ValueError("No local licensed font for synthetic fixtures.")
    fixtures = []
    with tempfile.TemporaryDirectory(prefix="superagent-ocr-v6-comparison-") as temp:
        root = Path(temp)
        for idx, (lang, gold) in enumerate(baseline.SAMPLES[:args.count]):
            name = "fixture-%02d" % (idx + 1)
            pdf = root / (name + ".pdf")
            baseline.fixture(gold, idx, pdf, font)
            render = subprocess.run([
                "bun", str(REPO / "scripts" / "pdf-cli.ts"), "render",
                pdf.name, name + "-rendered", "1", "2",
            ], cwd=root, capture_output=True, encoding="utf-8", timeout=30)
            if render.returncode != 0:
                raise RuntimeError("Actual SuperAgent PDF renderer failed.")
            meta = json.loads(render.stdout.strip())
            png = Path(meta["images"][0]["path"])
            if not png.is_file():
                raise RuntimeError("Renderer failed to publish PNG.")
            fixtures.append({
                "id": name, "lang": lang, "gold": gold,
                "condition": ["clean", "blur_skew", "noise_small_font"][idx % 3],
                "pdfSha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
                "pngSha256": hashlib.sha256(png.read_bytes()).hexdigest(),
                "png": str(png),
            })
        scored = {}
        for engine in engines:
            print("Running real OCR engine:", engine, flush=True)
            scored[engine] = perf_samples(engine, fixtures)
        # Strip temporary absolute paths from report; expose only hashes.
        report = {
            "status": "completed", "date": "2026-11-05",
            "benchmark": "real pinned OCR inference on identical synthetic scanned PDFs",
            "NOT_CERTIFIED": "No natural-document independent human-gold; results must not be called production OCR accuracy.",
            "modelTraining": False, "samples": args.count, "seed": SEED,
            "operatingSystem": platform.platform(),
            "cpu": platform.processor(),
            "logicalCores": os.cpu_count(),
            "comparisonFairness": "one rendered PNG per PDF reused for all engines, same gold and normalization",
            "metrics": "macroscopic per-page CER/WER, process-level timings; external 10ms worker+children RSS polling, no independent bbox gold or guaranteed OS kernel peak",
            "results": scored,
        }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    rows = ["# Real four-way OCR inference, synthetic PDF scans",
            "", f"Date: 2026-11-05; samples: {args.count}; no model training.",
            "", "| Engine | CER | WER | page p50 (s) | p95 (s) | observed RSS (MiB) |",
            "|---|---:|---:|---:|---:|---:|"]
    for engine, value in scored.items():
        rows.append(f"| {engine} | {value['macroCER']:.2%} | {value['macroWER']:.2%} | "
                    f"{value['pageP50Seconds']:.3f} | {value['pageP95Seconds']:.3f} | "
                    f"{value['observedRssMiB']:.2f} |")
    rows.extend([
        "", "## Scope and caveats",
        "- All real pretrained OCR engines ran against actual PDF-rendered fixture images; no mock.",
        "- Peak RSS is sampled independently every ~10ms across worker+child processes using psutil; not an OS kernel high-water mark. Results depend on this machine.",
        "- Synthetic fixtures are NOT representative real ID/EN scans or independent human-gold.",
        "- Confidence/bbox IoU, real documents, installed T-Line E2E and production MCP activation remain separate gates.",
        "- No OCR model was trained, fine-tuned, quantized or distilled.",
        "- Per-sample outputs, model hashes and timestamps are in the JSON companion.",
    ])
    markdown.write_text("\n".join(rows) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "completed",
        "json": str(output), "markdown": str(markdown), "count": args.count,
        "summary": {tier: {"cer": v["macroCER"], "wer": v["macroWER"],
                          "rssMiB": v["observedRssMiB"]} for tier, v in scored.items()},
    }, ensure_ascii=False))

if __name__ == "__main__":
    main()
