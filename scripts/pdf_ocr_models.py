#!/usr/bin/env python3
"""Explicit, SHA-verified, offline-ready OCR model provisioning for SuperAgent.

This is a provisioning command, NEVER invoked while processing user PDFs.
Artifacts live under the operator's private profile, not in Git or global Python.
The six ONNX hashes come from pinned RapidOCR v3.9.2 default_models.yaml.
Recogniser dictionaries + Tesseract traineddata are SHA-recorded at install,
then strictly checked offline. Re-run with --install ONLY on explicit upgrades.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlsplit

import rapidocr
import requests
import yaml

RAPID_VERSION = "3.9.2"
ONNX_VERSION = "1.23.2"
MODEL_BASE = Path.home() / ".superagent-r" / "models" / "pdf-ocr-v6"
TIERS = ("tiny", "small", "medium")
LANGS = ("eng", "ind")
MAX_ARTIFACT_BYTES = 220 * 1024 * 1024
URL_TESS = "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/{lang}.traineddata"
LOCK_PATH = Path(__file__).with_name("pdf-ocr-v6-lock.json")


def locked_hashes() -> dict[str, str]:
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    if (lock.get("schemaVersion") != 1 or lock.get("rapidocr") != RAPID_VERSION
            or lock.get("onnxruntime") != ONNX_VERSION):
        raise ValueError("Pinned OCR model lock schema/runtime mismatch.")
    hashes = lock.get("artifacts")
    if not isinstance(hashes, dict) or any(
        not isinstance(val, str) or len(val) != 64 for val in hashes.values()
    ):
        raise ValueError("Invalid SHA-256 OCR lock.")
    return hashes


def checked_versions() -> None:
    for package, expected in (("rapidocr", RAPID_VERSION), ("onnxruntime", ONNX_VERSION)):
        installed = version(package)
        if installed != expected:
            raise ValueError(f"{package} version mismatch. Required {expected}, found {installed}")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def file_info(path: Path) -> dict:
    return {"filename": path.name, "sha256": digest(path), "bytes": path.stat().st_size}


def provider_manifest() -> dict:
    root = Path(rapidocr.__file__).resolve().parent
    yaml_path = root / "default_models.yaml"
    manifest = yaml.safe_load(yaml_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("Unexpected RapidOCR model manifest.")
    return manifest


def expected_entries(manifest: dict, tier: str) -> list[dict]:
    if tier not in TIERS:
        raise ValueError("Unsupported tier: " + tier)
    onnx = manifest["onnxruntime"]["PP-OCRv6"]
    paddle = manifest["paddle"]["PP-OCRv6"]
    result = []
    hashes = locked_hashes()
    for task in ("det", "rec"):
        item = onnx[task][f"multi_PP-OCRv6_{task}_{tier}"]
        source = item["model_dir"]
        expected = item["SHA256"]
        if not isinstance(expected, str) or len(expected) != 64 or hashes.get(f"PP-OCRv6_{task}_{tier}") != expected.lower():
            raise ValueError("Vendor model SHA256 differs from pinned project lock.")
        if urlsplit(source).netloc != "www.modelscope.cn" or "/v3.9.2/" not in source:
            raise ValueError("Unapproved model source URL.")
        result.append({
            "id": f"PP-OCRv6_{task}_{tier}",
            "kind": "model",
            "source": source,
            "expectedSha256": expected.lower(),
            "path": MODEL_BASE / tier / f"PP-OCRv6_{task}_{tier}.onnx",
        })
    dictionary = paddle["rec"][f"multi_PP-OCRv6_rec_{tier}"]["dict_url"]
    if urlsplit(dictionary).netloc != "www.modelscope.cn" or "/v3.9.2/" not in dictionary:
        raise ValueError("Unapproved recognition dictionary source URL.")
    result.append({
        "id": f"PP-OCRv6_dict_{tier}",
        "kind": "dictionary",
        "source": dictionary,
        "expectedSha256": hashes[f"PP-OCRv6_dict_{tier}"],
        "path": MODEL_BASE / tier / Path(urlsplit(dictionary).path).name,
    })
    return result


def download(entry: dict, client: requests.Session, *, existing_hash: str | None) -> dict:
    path: Path = entry["path"]
    path.parent.mkdir(parents=True, exist_ok=True)
    expected = entry.get("expectedSha256") or existing_hash
    if path.exists():
        if not path.is_file() or path.is_symlink():
            raise ValueError("Non-regular OCR model path.")
        existing = file_info(path)
        if expected and existing["sha256"] != expected:
            raise ValueError(f"Existing artifact has unexpected SHA256: {entry['id']}. Refuse overwrite.")
        if expected:
            return existing
        raise ValueError("Unknown existing artifact hash; refuse to trust implicitly. Inspect/remove manually.")
    fd, tmp_path = tempfile.mkstemp(prefix=path.name + ".", suffix=".partial", dir=str(path.parent))
    temp = Path(tmp_path)
    os.close(fd)
    size = 0
    try:
        with client.get(entry["source"], stream=True, timeout=(15, 80)) as response:
            response.raise_for_status()
            if "text/html" in response.headers.get("Content-Type", ""):
                raise ValueError("Artifact download returned HTML, not a model.")
            with temp.open("wb") as out:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_ARTIFACT_BYTES:
                        raise ValueError("Downloaded OCR artifact exceeds configured safety limit.")
                    out.write(chunk)
                out.flush()
                os.fsync(out.fileno())
        actual = file_info(temp)
        if actual["bytes"] < 100 or (expected and actual["sha256"] != expected):
            raise ValueError(f"Model hash/size verification failed: {entry['id']}.")
        # An exclusive hard link prevents race-condition overwrite.
        os.link(temp, path)
        return file_info(path)
    finally:
        temp.unlink(missing_ok=True)


def registry_path() -> Path:
    return MODEL_BASE / "registry.json"


def load_registry() -> dict:
    registry = registry_path()
    if not registry.is_file():
        raise ValueError("OCR models are not installed; run explicit provisioning first.")
    obj = json.loads(registry.read_text(encoding="utf-8"))
    if obj.get("rapidocr") != RAPID_VERSION or obj.get("onnxruntime") != ONNX_VERSION:
        raise ValueError("OCR registry runtime version mismatch.")
    return obj


def install(tiers: tuple[str, ...], with_tessdata: bool, with_font: bool = False) -> dict:
    checked_versions()
    manifest = provider_manifest()
    if registry_path().exists():
        data = load_registry()
    else:
        data = {"schemaVersion": 1, "rapidocr": RAPID_VERSION,
                "onnxruntime": ONNX_VERSION, "artifacts": {}, "tiers": [],
                "source": "RapidOCR 3.9.2 pinned official/default_models.yaml"}
    if not isinstance(data.get("artifacts"), dict):
        raise ValueError("Invalid registry.")
    client = requests.Session()
    client.headers.update({"User-Agent": "SuperAgent-local-OCR-provisioner/1.0"})
    for tier in tiers:
        for item in expected_entries(manifest, tier):
            record = data["artifacts"].get(item["id"]) or {}
            prior = record.get("sha256") if isinstance(record, dict) else None
            saved = download(item, client, existing_hash=prior)
            print(f"Verified {item['id']}: {saved['bytes']} bytes SHA256={saved['sha256']}", file=sys.stderr)
            data["artifacts"][item["id"]] = {
                "kind": item["kind"], "path": str(item["path"]), "source": item["source"],
                "bytes": saved["bytes"], "sha256": saved["sha256"],
            }
        if tier not in data["tiers"]:
            data["tiers"].append(tier)
    if with_tessdata:
        for lang in LANGS:
            item = {
                "id": f"tesseract_{lang}",
                "kind": "traineddata",
                "source": URL_TESS.format(lang=lang),
                "expectedSha256": locked_hashes()[f"tesseract_{lang}"],
                "path": MODEL_BASE / "tessdata" / f"{lang}.traineddata",
            }
            record = data["artifacts"].get(item["id"]) or {}
            saved = download(item, client, existing_hash=record.get("sha256"))
            print(f"Verified {item['id']}: {saved['bytes']} bytes SHA256={saved['sha256']}", file=sys.stderr)
            data["artifacts"][item["id"]] = {
                "kind": item["kind"], "path": str(item["path"]), "source": item["source"],
                "bytes": saved["bytes"], "sha256": saved["sha256"],
            }
    if with_font:
        pin = json.loads(LOCK_PATH.read_text(encoding="utf-8"))["fonts"]["noto_sans_regular"]
        item = {
            "id": "noto_sans_regular",
            "kind": "font",
            "source": pin["source"],
            "expectedSha256": pin["sha256"],
            "path": MODEL_BASE / "fonts" / "NotoSans-Regular.ttf",
        }
        record = data["artifacts"].get(item["id"]) or {}
        saved = download(item, client, existing_hash=record.get("sha256"))
        if saved["bytes"] != pin["bytes"]:
            raise ValueError("Pinned Noto Sans byte size mismatch.")
        data["artifacts"][item["id"]] = {
            "kind": item["kind"], "path": str(item["path"]), "source": item["source"],
            "bytes": saved["bytes"], "sha256": saved["sha256"], "license": pin["license"],
        }
        print(f"Verified {item['id']}: {saved['bytes']} bytes SHA256={saved['sha256']}", file=sys.stderr)
    data["tiers"].sort(key=TIERS.index)
    MODEL_BASE.mkdir(parents=True, exist_ok=True)
    serialized = (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode()
    tmp = MODEL_BASE / "registry.json.new"
    with tmp.open("xb") as stream:
        stream.write(serialized)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(tmp, registry_path())
    finally:
        tmp.unlink(missing_ok=True)
    return verify(tiers)


def verify(tiers: tuple[str, ...]) -> dict:
    checked_versions()
    manifest = provider_manifest()
    registry = load_registry()
    all_entries = registry["artifacts"]
    if not isinstance(all_entries, dict):
        raise ValueError("Corrupted OCR registry.")
    summary = {}
    for tier in tiers:
        records = []
        for item in expected_entries(manifest, tier):
            record = all_entries.get(item["id"])
            if not record or record.get("source") != item["source"]:
                raise ValueError("Missing/incorrect model registry entry: " + item["id"])
            file = item["path"]
            if file.is_symlink() or not file.is_file() or file.stat().st_size > MAX_ARTIFACT_BYTES:
                raise ValueError("Missing or disallowed OCR model: " + item["id"])
            actual = file_info(file)
            if actual["sha256"] != record["sha256"] or actual["bytes"] != record["bytes"]:
                raise ValueError("OCR model/dictionary SHA256 mismatch: " + item["id"])
            if item["expectedSha256"] and record["sha256"] != item["expectedSha256"]:
                raise ValueError("OCR model no longer matches pinned upstream SHA256.")
            records.append({**actual, "id": item["id"]})
        summary[tier] = {"files": records, "totalModelBytes": sum(r["bytes"] for r in records)}
    tessdata = {}
    for lang in LANGS:
        item = all_entries.get(f"tesseract_{lang}")
        if item:
            file = MODEL_BASE / "tessdata" / f"{lang}.traineddata"
            if (file.is_symlink() or not file.is_file() or
                    digest(file) != item.get("sha256") or
                    item.get("sha256") != locked_hashes()[f"tesseract_{lang}"]):
                raise ValueError("Tesseract language pack failed verification: " + lang)
            tessdata[lang] = file_info(file)
    fonts = {}
    pin = json.loads(LOCK_PATH.read_text(encoding="utf-8"))["fonts"]["noto_sans_regular"]
    entry = all_entries.get("noto_sans_regular")
    if entry is not None:
        file = MODEL_BASE / "fonts" / "NotoSans-Regular.ttf"
        if (file.is_symlink() or not file.is_file() or digest(file) != pin["sha256"]
                or file.stat().st_size != pin["bytes"]
                or entry.get("sha256") != pin["sha256"]
                or entry.get("source") != pin["source"]):
            raise ValueError("Unicode OCR font differs from pinned SIL OFL artifact.")
        fonts["noto_sans_regular"] = file_info(file)
    import rapidocr
    cls = Path(rapidocr.__file__).parent / "models" / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"
    if cls.is_symlink() or not cls.is_file() or digest(cls) != locked_hashes()["rapidocr_bundled_cls"]:
        raise ValueError("Bundled RapidOCR classifier differs from pinned SHA-256.")
    return {"status": "verified", "root": str(MODEL_BASE), "rapidocr": RAPID_VERSION,
            "onnxruntime": ONNX_VERSION, "tiers": summary, "tessdata": tessdata, "fonts": fonts,
            "networkUsedForVerification": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--install", action="store_true", help="Explicitly download, never called from PDF tool.")
    parser.add_argument("--tiers", default="tiny,small,medium")
    parser.add_argument("--tessdata", action="store_true")
    parser.add_argument("--font", action="store_true", help="Explicitly provision SHA-pinned SIL OFL Noto Sans for searchable Unicode OCR.")
    args = parser.parse_args()
    tiers = tuple(x.strip() for x in args.tiers.split(",") if x.strip())
    if not tiers or len(set(tiers)) != len(tiers) or any(x not in TIERS for x in tiers):
        parser.error("tiers must be unique members of tiny,small,medium.")
    result = install(tiers, args.tessdata, args.font) if args.install else verify(tiers)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
