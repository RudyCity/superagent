#!/usr/bin/env python3
"""Reproducible bounded Studio multi-object Video-to-Code browser smoke.

Optional developer tools: Pillow, Python Playwright, FFmpeg, Chrome and Bun.
All generated inputs, decoded media, exported code and review PNGs stay inside
a disposable temporary Studio workspace and are deleted at exit.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", default=r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    parser.add_argument("--palette", choices=["dark", "light"], default="dark")
    parser.add_argument("--json", action="store_true")
    opts = parser.parse_args()
    try:
        from PIL import Image, ImageDraw
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"status": "unverified", "reason": "Pillow and Python Playwright are required"}))
        return 2
    if not Path(opts.chrome).is_file() or shutil.which("ffmpeg") is None or shutil.which("bun") is None:
        print(json.dumps({"status": "unverified", "reason": "Chrome, FFmpeg and Bun must be installed"}))
        return 2
    repo = Path(__file__).resolve().parent.parent
    root = Path(tempfile.mkdtemp(prefix="studio-multi-browser-smoke-"))

    def cli(*argv: str) -> dict:
        result = subprocess.run(
            ["bun", "src/cli.tsx", "studio", *argv, "--workspace", str(root), "--json"],
            cwd=repo, capture_output=True, text=True, timeout=40,
        )
        if result.returncode:
            raise RuntimeError("Studio CLI failed: " + result.stderr[-900:] + " " + result.stdout[-900:])
        return json.loads(result.stdout)

    try:
        for index in range(30):
            image = Image.new("RGB", (160, 90), "black" if opts.palette == "dark" else "#f0f0f0")
            painter = ImageDraw.Draw(image)
            painter.rectangle((12 + index, 16, 30 + index, 35),
                              fill="white" if opts.palette == "dark" else "#181b3e")
            offset = 94 + round(index * .22)
            painter.rectangle((offset, 50, offset + 20, 67),
                              fill="#fff3aa" if opts.palette == "dark" else "#c6255e")
            image.save(root / f"frame{index:03d}.png")
        video = root / "reference.mp4"
        encoded = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-framerate", "10",
            "-i", str(root / "frame%03d.png"), "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-y", str(video),
        ], capture_output=True, text=True, timeout=30)
        if encoded.returncode:
            raise RuntimeError(encoded.stderr[-900:])
        imported = cli("import-video", "--file", "reference.mp4")
        reconstruction = cli("reconstruct-video-multi", imported["id"])
        export = cli("export-code", reconstruction["projectId"], "--format", "html")
        png = Path(reconstruction["reviewPng"])
        assert png.is_file() and png.stat().st_size < 2 * 1024 * 1024
        assert len(reconstruction["objects"]) == 2
        assert 5 <= len(reconstruction["sampleTimes"]) <= 9
        assert len(reconstruction["interpolationCheckIoU"]) == 2
        assert all(score >= .38 for score in reconstruction["interpolationCheckIoU"])
        assert all(len(obj["boxes"]) == len(reconstruction["sampleTimes"])
                   for obj in reconstruction["objects"])
        assert len(reconstruction["measuredForegroundIoU"]) == 3
        assert all(score >= .38 for score in reconstruction["measuredForegroundIoU"])
        with Image.open(png) as review:
            assert review.format == "PNG"
            size = list(review.size)
            assert size[0] == 640 and size[1] == 568

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True, executable_path=opts.chrome,
                args=["--no-first-run", "--disable-extensions"])
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.context.set_offline(True)
            errors: list[str] = []
            requests: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: requests.append(request.url)
                    if request.url.startswith(("http:", "https:")) else None)
            page.goto(Path(export["file"]).as_uri(), wait_until="load", timeout=20000)
            assert page.locator("#studio-stage [data-studio-index]").count() == 2
            bar = page.locator("#studio-progress")
            bar.fill("500")
            bar.dispatch_event("input")
            clock = page.locator("#studio-time").inner_text()
            assert clock.startswith("1.5s / 3.0s"), clock
            assert not errors and not requests, (errors, requests)
            browser.close()
        output = {
            "status": "pass", "palette": opts.palette, "objects": 2,
            "measuredForegroundIoU": reconstruction["measuredForegroundIoU"],
            "interpolationCheckIoU": reconstruction["interpolationCheckIoU"],
            "trackedSamples": len(reconstruction["sampleTimes"]),
            "reviewPngDimensions": size, "browserTimeline": clock,
            "browserErrors": len(errors), "networkRequests": len(requests),
        }
        print(json.dumps(output, ensure_ascii=False) if opts.json else str(output))
        return 0
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1
    finally:
        shutil.rmtree(root, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
