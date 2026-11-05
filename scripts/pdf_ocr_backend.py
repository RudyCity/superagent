#!/usr/bin/env python3
"""Offline-only OCR worker: pinned PP-OCRv6 (RapidOCR/ONNX), or Tesseract.

Contract: one bounded JSON request via stdin, one JSON reply via stdout. Models
must be pre-provisioned by pdf_ocr_models.py; worker NEVER downloads weights.
This script is a child process of a workspace-scoped TypeScript PDF tool.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from importlib.metadata import version
from io import StringIO

from pdf_ocr_models import MODEL_BASE, TIERS, LANGS, verify, load_registry, digest


def err(code: str, message: str):
    return {"status": "failed", "code": code, "message": message}


def require_images(value: object) -> list[Path]:
    if not isinstance(value, list) or not 1 <= len(value) <= 20:
        raise ValueError("images must contain between 1 and 20 pages.")
    pages = []
    for entry in value:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            raise ValueError("Invalid image descriptor.")
        path = Path(entry["path"]).resolve(strict=True)
        if path.suffix.lower() != ".png" or path.stat().st_size > 35 * 1024 * 1024:
            raise ValueError("Only bounded local PNG inputs are permitted.")
        if not path.is_file() or path.is_symlink():
            raise ValueError("Expected a regular non-symlink PNG.")
        pages.append(path)
    return pages


def load_rapid(tier: str):
    from rapidocr import RapidOCR, EngineType, ModelType, OCRVersion
    root = MODEL_BASE / tier
    enum = {"tiny": ModelType.TINY, "small": ModelType.SMALL, "medium": ModelType.MEDIUM}[tier]
    model_dict = root / ("ppocrv6_tiny_dict.txt" if tier == "tiny" else "ppocrv6_dict.txt")
    # Explicit local paths: no model-path resolver or silent runtime downloads.
    opts = {
        "Global.use_cls": False,
        "Global.log_level": "error",
        "Det.engine_type": EngineType.ONNXRUNTIME,
        "Rec.engine_type": EngineType.ONNXRUNTIME,
        "Det.model_type": enum,
        "Rec.model_type": enum,
        "Det.ocr_version": OCRVersion.PPOCRV6,
        "Rec.ocr_version": OCRVersion.PPOCRV6,
        "Det.lang_type": "ch",
        "Rec.lang_type": "ch",
        "Det.model_path": str(root / f"PP-OCRv6_det_{tier}.onnx"),
        "Rec.model_path": str(root / f"PP-OCRv6_rec_{tier}.onnx"),
        "Rec.rec_keys_path": str(model_dict),
    }
    # RapidOCR 3.9.2 always builds a Cls model even when Global.use_cls false.
    # Supply a pre-bundled verified package model to prevent network lookup.
    import rapidocr
    cls_path = Path(rapidocr.__file__).parent / "models" / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
    if not cls_path.is_file():
        raise ValueError("Local orientation classifier not provisioned; offline OCR refused.")
    opts["Cls.model_path"] = str(cls_path)
    return RapidOCR(params=opts)


def use_rapid(engine, path: Path):
    result = engine(str(path))
    txts = list(result.txts or [])
    boxes = result.boxes
    scores = result.scores or []
    lines = []
    for i, txt in enumerate(txts):
        box = boxes[i].tolist() if boxes is not None else []
        score = float(scores[i]) if i < len(scores) else None
        lines.append({"text": txt, "confidence": score, "quad": box})
    return {"text": "\n".join(txts), "lines": lines, "lineCount": len(lines)}


def tesseract(path: Path, language: str) -> dict:
    root = MODEL_BASE / "tessdata"
    if not all((root / f"{lang}.traineddata").is_file() for lang in LANGS):
        raise ValueError("Tesseract language data must be provisioned offline.")
    lang = "ind+eng" if language in ("id", "ind", "auto") else "eng"
    proc = subprocess.run(
        ["tesseract", str(path), "stdout", "--tessdata-dir", str(root),
         "-l", lang, "--psm", "6", "-c", "tessedit_create_tsv=1"],
        capture_output=True, encoding="utf-8", errors="replace", timeout=30, shell=False,
    )
    if proc.returncode:
        raise ValueError("Installed Tesseract engine failed (no OCR result trusted).")
    lines = {}
    for row in proc.stdout.splitlines()[1:]:
        fields = row.split("\t", 11)
        if len(fields) != 12 or fields[0] != "5":
            continue
        try:
            txt = fields[11].strip()
            if not txt:
                continue
            conf = max(0, min(100, float(fields[10]))) / 100
            left, top, width, height = [int(fields[i]) for i in (6, 7, 8, 9)]
            k = tuple(fields[i] for i in (1, 2, 3, 4))
        except (ValueError, IndexError):
            continue
        item = lines.setdefault(k, {"words": [], "confidence": [], "left": left,
                                    "top": top, "right": left + width, "bottom": top + height})
        item["words"].append(txt)
        item["confidence"].append(conf)
        item["left"] = min(item["left"], left)
        item["top"] = min(item["top"], top)
        item["right"] = max(item["right"], left + width)
        item["bottom"] = max(item["bottom"], top + height)
    collected = []
    for item in lines.values():
        collected.append({
            "text": " ".join(item["words"]),
            "confidence": sum(item["confidence"]) / len(item["confidence"]),
            "quad": [
                [item["left"], item["top"]], [item["right"], item["top"]],
                [item["right"], item["bottom"]], [item["left"], item["bottom"]],
            ],
        })
    return {"text": "\n".join(item["text"] for item in collected),
            "lines": collected, "lineCount": len(collected)}


def main(request: dict) -> dict:
    if not isinstance(request, dict):
        return err("invalid_input", "Expected object request.")
    tier = request.get("engine", "small")
    if tier not in (*TIERS, "tesseract"):
        return err("invalid_engine", "Select one of tiny, small, medium, tesseract.")
    lang = request.get("language", "auto")
    if lang not in ("auto", "id", "en"):
        return err("invalid_language", "Only auto, id and en are supported.")
    images = require_images(request.get("images"))
    max_chars = request.get("maxChars", 100000)
    if type(max_chars) is not int or not 1 <= max_chars <= 200000:
        return err("invalid_input", "maxChars must be 1..200000.")
    import psutil
    proc = psutil.Process(os.getpid())
    start = time.perf_counter()
    if tier in TIERS:
        attest = verify((tier,))
        registry = load_registry()
        output_engine = "rapidocr-onnx-PP-OCRv6-" + tier
    else:
        verify(())  # verify Tesseract language packs below
        registry = load_registry()
        if any(f"tesseract_{name}" not in registry["artifacts"] for name in LANGS):
            raise ValueError("Missing/invalid Tesseract language model registry.")
        for name in LANGS:
            rec = registry["artifacts"][f"tesseract_{name}"]
            if digest(Path(rec["path"])) != rec["sha256"]:
                raise ValueError("Tesseract language data hash mismatch.")
        output_engine = "tesseract-eng-ind"
    model_hashes = {
        name: info["sha256"]
        for name, info in registry["artifacts"].items()
        if (name.endswith(f"_{tier}") if tier in TIERS else name.startswith("tesseract_"))
    }
    worker = load_rapid(tier) if tier in TIERS else None
    loading_seconds = time.perf_counter() - start
    result_pages = []
    peak_rss = proc.memory_info().rss
    for idx, file in enumerate(images):
        page_start = time.perf_counter()
        output = use_rapid(worker, file) if worker is not None else tesseract(file, lang)
        elapsed = time.perf_counter() - page_start
        peak_rss = max(peak_rss, proc.memory_info().rss)
        result_pages.append({
            "page": idx + 1,
            "text": output["text"][:max_chars],
            "truncated": len(output["text"]) > max_chars,
            "lines": output["lines"][:5000],
            "lineCount": output["lineCount"],
            "elapsedSeconds": round(elapsed, 5),
            "imageSha256": digest(file),
        })
    combined = "\n\n".join(item["text"] for item in result_pages)
    return {
        "status": "verified",
        "engine": output_engine,
        "requestedLanguage": lang,
        "modelHashes": model_hashes,
        "runtimeVersions": {
            "python": ".".join(map(str, sys.version_info[:3])),
            "rapidocr": version("rapidocr") if tier in TIERS else None,
            "onnxruntime": version("onnxruntime") if tier in TIERS else None,
        },
        "text": combined[:max_chars], "truncated": len(combined) > max_chars,
        "pages": result_pages, "pageCount": len(result_pages),
        "coldStartSeconds": round(loading_seconds, 5),
        "wallSeconds": round(time.perf_counter() - start, 5),
        "observedRssBytes": peak_rss,
        "rssMeasurement": "Max RSS sampled after model initialization and after each page; not OS-verified peak during each kernel.",
        "ocrPerformed": True,
        "warning": "Pretrained OCR output is probabilistic, not human-verified. Verify text and bounding boxes for consequential tasks.",
    }


if __name__ == "__main__":
    try:
        raw = sys.stdin.buffer.read(32 * 1024 + 1)
        if len(raw) > 32 * 1024:
            raise ValueError("OCR request exceeded 32 KiB.")
        request = json.loads(raw.decode("utf-8"))
        print(json.dumps(main(request), ensure_ascii=False))
    except Exception as e:
        # No paths, PII or OCR content in error messages.
        print(json.dumps(err("ocr_backend_failed", "OCR engine failed or files/model hashes are invalid. Check local setup and approved models.")))
