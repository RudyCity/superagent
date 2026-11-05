#!/usr/bin/env python3
"""Offline pretrained OCR evaluation on real MDPBench Indonesian/English images.

Dataset: official public MDPBench (Apache-2.0) with author human-verified
layout transcription. NEVER train, fine-tune or upload private images.
Downloads public subset only with explicit --prepare. Raw images and the
73MB public JSON remain under ~/.superagent-r/datasets/ (not in Git).
Benchmark output excludes raw text, filenames and any document contents.

Important: layout text is a parsing benchmark, not automatically exhaustive
word-level page transcription. Report order-INDEPENDENT annotated-token F1
and lexical recall, not falsely comparable page CER/WER or bounding-box IoU.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import pathlib
import random
import re
import statistics
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote

import psutil
import requests
from PIL import Image, ImageOps

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = pathlib.Path.home() / ".superagent-r" / "datasets" / "mdpbench-public"
ANNOT = DATA / "MDPBench_public.json"
MANIFEST = DATA / "selected-real-documents.json"
CACHE = DATA / "images"
OCR_PY = pathlib.Path.home() / ".superagent-r" / "venvs" / "pdf-ocr-rapid" / (
    "Scripts/python.exe" if os.name == "nt" else "bin/python"
)
WORKER = ROOT / "scripts" / "pdf_ocr_backend.py"
ANNOT_SHA = "9b5f0f233917f5ab6c83c55dd526f66c930414254079097477d2ec5572e450f3"
BASE_URL = "https://huggingface.co/datasets/Delores-Lin/MDPBench/resolve/main/MDPBench_img_public/"
SEED = 20261105

def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.casefold())

def source_group(name: str) -> str:
    # Four entries usually represent original + 3 photographed variants.
    stem = pathlib.Path(name).stem
    return re.split(r"_(?:indoor|outdoor)_", stem, maxsplit=1)[0]

def read_annotations() -> list[dict]:
    if not ANNOT.is_file() or sha(ANNOT.read_bytes()) != ANNOT_SHA:
        raise ValueError("Official MDPBench annotation JSON absent or SHA mismatch.")
    rows = json.loads(ANNOT.read_text("utf-8"))
    if not isinstance(rows, list) or len(rows) < 1000:
        raise ValueError("MDPBench public annotation schema mismatch.")
    selected = []
    for row in rows:
        language = row["page_info"]["page_attribute"].get("language")
        lang = "id" if language == "Indonesian" else "en" if language == "english" else None
        if not lang:
            continue
        filename = row["page_info"]["image_path"]
        if not isinstance(filename, str) or not re.fullmatch(r"[a-z]{2}_[a-z0-9_+.-]+\.(?:jpg|JPEG|png|PNG)", filename):
            raise ValueError("Dataset file name is invalid; refusing unsafe download.")
        # Only transcribed textual blocks. Tables, formulas and images are not
        # fully represented by their top-level text fields: metric is partial.
        annotations = [
            det.get("text", "").strip()
            for det in row["layout_dets"]
            if det.get("category_type") not in ("figure", "image", "table", "formula")
            and isinstance(det.get("text"), str) and det.get("text", "").strip()
        ]
        gold = " ".join(annotations)
        if len(tokens(gold)) < 8:
            continue
        selected.append({
            "lang": lang, "filename": filename,
            "group": source_group(filename),
            "goldSha256": sha(gold.encode("utf-8")),
            "gold": gold,
            "annotationCount": len(annotations),
            "condition": "photo" if "_indoor_" in filename or "_outdoor_" in filename else "base",
        })
    return selected

def choose(rows: list[dict], per_lang: int) -> list[dict]:
    selected = []
    for lang in ("id", "en"):
        eligible = [row for row in rows if row["lang"] == lang]
        if len(eligible) < per_lang:
            raise ValueError("Insufficient valid annotated pages for " + lang)
        rng = random.Random(SEED + (1 if lang == "id" else 2))
        by_group = collections.defaultdict(list)
        for row in eligible:
            by_group[row["group"]].append(row)
        # Maximize source document diversity, then add transformed photos.
        groups = sorted(by_group)
        rng.shuffle(groups)
        for name in groups:
            originals = [row for row in by_group[name] if row["condition"] == "base"]
            if originals:
                selected.append(originals[0])
        picked = [row for row in selected if row["lang"] == lang]
        if len(picked) > per_lang:
            chosen = rng.sample(picked, per_lang)
            selected = [row for row in selected if row["lang"] != lang] + chosen
            continue
        rest = [row for row in eligible if row["filename"] not in {p["filename"] for p in picked}]
        rng.shuffle(rest)
        selected.extend(rest[:per_lang-len(picked)])
    if len(selected) != per_lang * 2:
        raise ValueError("Deterministic source-group selection failed.")
    return sorted(selected, key=lambda x: (x["lang"], x["filename"]))

def expected_manifest(per_lang: int) -> dict:
    rows = choose(read_annotations(), per_lang)
    return {
        "schema": 1, "seed": SEED, "dataset": "Delores-Lin/MDPBench",
        "datasetLicense": "Apache-2.0", "sourceAnnotationSHA256": ANNOT_SHA,
        "selectionMethod": "max unique original groups, then deterministic photo variants",
        "count": len(rows), "perLanguage": per_lang,
        "cases": [{
            "lang": row["lang"], "filename": row["filename"], "group": row["group"],
            "condition": row["condition"], "goldSha256": row["goldSha256"],
            "annotationCount": row["annotationCount"],
        } for row in rows],
    }

def provision(per_lang: int) -> None:
    manifest = expected_manifest(per_lang)
    CACHE.mkdir(parents=True, exist_ok=True)
    if MANIFEST.exists():
        prior = json.loads(MANIFEST.read_text(encoding="utf-8"))
        for key in ("count", "cases", "sourceAnnotationSHA256"):
            # Prior cases contain hashes/download data; compare selection only.
            if key == "cases":
                a = [{k:v for k,v in row.items() if k not in ("imageSha256", "imageBytes")} for row in prior[key]]
                if a != manifest[key]:
                    raise ValueError("Existing benchmark selection differs; no silent overwrite.")
            elif prior[key] != manifest[key]:
                raise ValueError("Existing benchmark selection differs; no silent overwrite.")
    downloaded = []
    client = requests.Session()
    client.headers["User-Agent"] = "SuperAgent OCR reproducibility/1.0"
    for i, row in enumerate(manifest["cases"]):
        filename = row["filename"]
        destination = CACHE / filename
        if not destination.exists():
            url = BASE_URL + quote(filename)
            with client.get(url, stream=True, timeout=(20,80)) as response:
                response.raise_for_status()
                length = response.headers.get("Content-Length")
                if length is not None and int(length) > 16 * 1024 * 1024:
                    raise ValueError("A public document image exceeds the 16 MiB per-image cap.")
                target = destination.with_name(destination.name + ".partial")
                size = 0
                try:
                    with target.open("xb") as output:
                        for chunk in response.iter_content(131072):
                            size += len(chunk)
                            if size > 16 * 1024 * 1024:
                                raise ValueError("Image exceeds per-file size cap.")
                            output.write(chunk)
                    target.replace(destination)
                finally:
                    target.unlink(missing_ok=True)
        raw = destination.read_bytes()
        if not 1000 < len(raw) <= 16 * 1024 * 1024:
            raise ValueError("Truncated or oversized public image.")
        with Image.open(destination) as im:
            im.verify()
        row["imageSha256"] = sha(raw)
        row["imageBytes"] = len(raw)
        downloaded.append(row)
        if (i+1) % 10 == 0:
            print(f"Verified public images: {i+1}/{manifest['count']}", flush=True)
    manifest["cases"] = downloaded
    if MANIFEST.exists():
        old=json.loads(MANIFEST.read_text("utf8"))
        if old != manifest:
            raise ValueError("Existing image lock differs; preserve previous record.")
    else:
        MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",encoding="utf-8")
    print(json.dumps({"status":"verified","cases":manifest["count"],
       "languages":dict(collections.Counter(x["lang"] for x in downloaded)),
       "uniqueSourceGroups":{lang:len(set(x["group"] for x in downloaded if x["lang"]==lang))
                             for lang in ("id","en")},
       "totalImageBytes":sum(x["imageBytes"] for x in downloaded)},ensure_ascii=False))

def score_recall(gold: str, predicted: str) -> dict:
    # Order-independent metric: page annotations are layout/reading-order
    # labels, not a certified exhaustive page transcript.
    want=collections.Counter(tokens(gold))
    got=collections.Counter(tokens(predicted))
    hit=sum((want & got).values())
    return {"hit":hit,"gold":sum(want.values()),"ocr":sum(got.values())}

def evaluate(per_lang: int, engine: str, start: int, count: int, output: pathlib.Path) -> None:
    manifest=json.loads(MANIFEST.read_text("utf8"))
    expected=expected_manifest(per_lang)
    if (manifest["count"]!=expected["count"] or
        any(any(x[k]!=y[k] for k in ("filename","lang","goldSha256")) for x,y in zip(manifest["cases"],expected["cases"]))):
        raise ValueError("Dataset selection / annotation lock changed.")
    if engine not in ("tiny","small","medium","tesseract"):
        raise ValueError("Unsupported pinned OCR engine.")
    if start<0 or count<1 or count>15 or start+count>manifest["count"]:
        raise ValueError("Use a valid range with up to 15 cases per process.")
    if output.exists():
        raise ValueError("Output already exists; cannot overwrite evidence.")
    from PIL import Image
    images=[]
    with tempfile.TemporaryDirectory(prefix="superagent-mdpbench-ocr-") as temp:
        folder=pathlib.Path(temp)
        for i in range(start,start+count):
            case=manifest["cases"][i]
            inp=CACHE / case["filename"]
            raw=inp.read_bytes()
            if sha(raw)!=case["imageSha256"]:
                raise ValueError("Public document image changed since provisioning.")
            with Image.open(inp) as image:
                if image.width*image.height>100_000_000:
                    raise ValueError("Refuse source image larger than 100 million pixels.")
                # Prefer decoder-level JPEG downsampling before materializing
                # a giant RGB image. Keep the exact same conversion for all models.
                image.draft("RGB",(2200,2200))
                image=ImageOps.exif_transpose(image).convert("RGB")
                # Hold one preprocessing policy fixed for every engine.
                image.thumbnail((2200,2200),Image.Resampling.LANCZOS)
                out=folder / f"case-{i:04d}.png"
                image.save(out,optimize=False)
            images.append({"path":str(out)})
        req={"engine":engine,"language":"auto","images":images,"maxChars":150000}
        t0=time.perf_counter()
        completed=subprocess.run([str(OCR_PY),str(WORKER)],input=json.dumps(req),
                                 text=True,capture_output=True,timeout=165)
        if completed.returncode:
            raise RuntimeError(f"OCR process failed: exit code {completed.returncode}")
        try: output_json=json.loads(completed.stdout)
        except ValueError as exc: raise RuntimeError("Invalid OCR output") from exc
        if output_json.get("status")!="verified" or len(output_json.get("pages",[]))!=len(images):
            raise RuntimeError("OCR worker rejected one or more images: "+str(output_json.get("code")))
        gold_by_name={case["filename"]:case for case in read_annotations()}
        results=[]
        for n,(case,page) in enumerate(zip(manifest["cases"][start:start+count],output_json["pages"])):
            ground=gold_by_name[case["filename"]]["gold"]
            rec=score_recall(ground,page["text"])
            results.append({
                "caseId":start+n, "lang":case["lang"],"condition":case["condition"],
                "sourceGroupHash":sha(case["group"].encode())[:16],
                "imageSha256":case["imageSha256"],
                "annotatedTokenHits":rec["hit"],"annotatedGoldTokens":rec["gold"],
                "recognizedTokens":rec["ocr"],"runtimeSeconds":page["elapsedSeconds"],
                "ocrTextSha256":sha(page["text"].encode("utf8")),
                "lineCount":page["lineCount"],
            })
        report={
            "status":"completed","dataset":"MDPBench public Apache-2.0",
            "annotationSourceSha256":ANNOT_SHA,"selectionSeed":SEED,
            "languageCount":per_lang,"engine":engine,"start":start,"count":count,
            "actualInference":True,"trainedOwnModel":False,
            "metric":"order-independent annotated layout-text token overlap; NOT page CER/WER, bbox F1 or exhaustive transcription",
            "preprocessing":"PIL EXIF transpose, RGB, downscale to <=2200x2200, no synthetic alterations",
            "runtimeSec":round(time.perf_counter()-t0,3),
            "modelHashes":output_json["modelHashes"],
            "observedRssBytes":output_json["observedRssBytes"],
            "cases":results,
        }
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(report,indent=2,ensure_ascii=False)+"\n",encoding="utf8")
    by=collections.defaultdict(lambda:collections.Counter())
    for row in results:
        by[row["lang"]].update({"hits":row["annotatedTokenHits"],
           "reference":row["annotatedGoldTokens"],"recognized":row["recognizedTokens"],
           "pages":1})
    summary={lang:{"pages":c["pages"],
       "annotatedTokenRecall":round(c["hits"]/max(1,c["reference"]),4),
       "annotatedTokenPrecision":round(c["hits"]/max(1,c["recognized"]),4)}
       for lang,c in by.items()}
    print(json.dumps({"status":"completed","engine":engine,"start":start,"count":count,"byLanguage":summary},ensure_ascii=False))

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--prepare",action="store_true")
    ap.add_argument("--evaluate",action="store_true")
    ap.add_argument("--per-language",type=int,default=10)
    ap.add_argument("--engine",default="tiny")
    ap.add_argument("--start",type=int,default=0)
    ap.add_argument("--count",type=int,default=10)
    ap.add_argument("--output")
    args=ap.parse_args()
    if not 1<=args.per_language<=160:
        ap.error("per-language must be 1..160")
    if args.prepare:
        provision(args.per_language)
    elif args.evaluate:
        if not args.output:
            ap.error("--output required for --evaluate")
        out=(ROOT / args.output).resolve()
        if not out.is_relative_to(ROOT) or out.suffix.lower()!=".json":
            raise ValueError("Output must be a repository JSON relative path.")
        evaluate(args.per_language,args.engine,args.start,args.count,out)
    else: ap.error("choose --prepare or --evaluate")

if __name__=="__main__":
    main()
