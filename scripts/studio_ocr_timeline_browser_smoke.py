#!/usr/bin/env python3
"""Local OCR timeline → editable HTML Chrome smoke. Never touches user media.
Requires Bun, FFmpeg, Tesseract eng, Pillow, Playwright and Chrome on Windows.
"""
import json
import pathlib
import shutil
import subprocess
import tempfile
import sys

def main():
    from PIL import Image, ImageDraw, ImageFont
    from playwright.sync_api import sync_playwright
    root = pathlib.Path(tempfile.mkdtemp(prefix="studio-caption-timeline-smoke-"))
    repo = pathlib.Path(__file__).resolve().parent.parent
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 72)
        for frame in range(30):
            picture = Image.new("RGB", (640, 360), "#f0f0f0")
            value = "STUDIO" if frame < 11 else "HELLO" if frame >= 20 else ""
            if value:
                ImageDraw.Draw(picture).text((80, 118), value, font=font, fill="#101c40")
            picture.save(root / f"frame{frame:03d}.png")
        ffmpeg = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-framerate", "10",
            "-i", str(root / "frame%03d.png"), "-y", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", str(root / "reference.mp4"),
        ], capture_output=True, text=True, timeout=30)
        if ffmpeg.returncode:
            raise RuntimeError(ffmpeg.stderr[-700:])
        def studio(*args):
            proc = subprocess.run(
                ["bun", "src/cli.tsx", "studio", *args, "--workspace", str(root), "--json"],
                cwd=repo, capture_output=True, text=True, timeout=55,
            )
            if proc.returncode:
                raise RuntimeError("Studio CLI: " + proc.stderr[-600:] + proc.stdout[-600:])
            return json.loads(proc.stdout)
        asset = studio("import-video", "--file", "reference.mp4")
        captions = studio("reconstruct-video-text-timeline", asset["id"])
        exported = studio("export-code", captions["projectId"], "--format", "html")
        assert [entry["text"] for entry in captions["captions"]] == ["STUDIO", "HELLO"]
        assert len(captions["sampleTimes"]) == 9
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            )
            page = browser.new_page(viewport={"width": 1100, "height": 800})
            page.context.set_offline(True)
            errors, requests = [], []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request: requests.append(request.url)
                if request.url.startswith(("http:", "https:")) else None)
            page.goto(pathlib.Path(exported["file"]).as_uri(), wait_until="load")
            states = []
            for progress in ["100", "500", "900"]:
                bar = page.locator("#studio-progress")
                bar.fill(progress)
                bar.dispatch_event("input")
                visible = page.locator("#studio-stage [data-studio-index]").evaluate_all(
                    """nodes => nodes.map(n => ({
                        text: n.textContent,
                        opacity: Number(n.getAttribute("opacity"))
                    }))"""
                )
                states.append({"progress": progress, "captions": visible})
            browser.close()
        values = [[entry["opacity"] for entry in snapshot["captions"]] for snapshot in states]
        assert values == [[1, 0], [0, 0], [0, 1]], states
        assert not errors and not requests, (errors, requests)
        print(json.dumps({
            "status": "pass", "captions": captions["captions"],
            "tracked_samples": len(captions["sampleTimes"]), "sampled_states": states,
            "javascript_errors": errors, "external_requests": requests,
        }, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"status": "failed", "error": str(error)}, ensure_ascii=False))
        return 1
    finally:
        shutil.rmtree(root, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
