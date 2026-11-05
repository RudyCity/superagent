"""Explicit installer/check for optional portable Real-ESRGAN backend.
No installer is invoked implicitly by a document conversion request.
Uses one pinned official upstream release and never modifies PATH or repo files.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile
from urllib.request import Request, urlopen
import zipfile

URL = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip"
ROOT = Path.home() / ".superagent-r" / "media-backends" / "realesrgan"


def inspect():
    exe = ROOT / "realesrgan-ncnn-vulkan.exe"
    models = ROOT / "models"
    return {"installed": exe.is_file() and models.is_dir(), "executable": str(exe),
            "models": sorted(p.stem for p in models.glob("*.param")) if models.exists() else [],
            "source": URL}


def download():
    if os.name != "nt":
        raise RuntimeError("Installer is currently Windows-only; install an official platform binary manually.")
    if inspect()["installed"]:
        return inspect()
    ROOT.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="superagent-media-setup-") as folder:
        zipped = Path(folder) / "release.zip"
        digest = hashlib.sha256()
        size = 0
        request = Request(URL, headers={"User-Agent": "SuperAgent-MediaSetup/1.0"})
        with urlopen(request, timeout=30) as response, zipped.open("wb") as output:
            while True:
                piece = response.read(1024 * 1024)
                if not piece:
                    break
                size += len(piece)
                if size > 100_000_000:
                    raise RuntimeError("Compressed release exceeds 100MB safety cap")
                digest.update(piece)
                output.write(piece)
        unpack = Path(folder) / "unpacked"
        unpack.mkdir()
        with zipfile.ZipFile(zipped) as archive:
            members = archive.infolist()
            if len(members) > 500 or sum(m.file_size for m in members) > 500_000_000:
                raise RuntimeError("Release extraction exceeds 500MB / 500 entry cap")
            for item in members:
                loc = (unpack / item.filename).resolve()
                if not loc.is_relative_to(unpack.resolve()) or (item.external_attr >> 16) & 0o170000 == 0o120000:
                    raise RuntimeError("Unsafe archive entry")
            archive.extractall(unpack)
        found = list(unpack.rglob("realesrgan-ncnn-vulkan.exe"))
        if len(found) != 1 or not (found[0].parent / "models").is_dir():
            raise RuntimeError("Release layout missing executable or model directory")
        if ROOT.exists():
            raise RuntimeError("Partial or externally managed backend directory exists; refusing overwrite")
        shutil.copytree(found[0].parent, ROOT)
        lock = {"source": URL, "archive_sha256": digest.hexdigest(), "archive_bytes": size}
        (ROOT / "source-lock.json").write_text(json.dumps(lock, indent=2) + "\n", encoding="utf-8")
        return {**inspect(), **lock}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--install-realesrgan", action="store_true")
    args = parser.parse_args()
    print(json.dumps(download() if args.install_realesrgan else inspect(), indent=2))
