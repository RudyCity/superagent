#!/usr/bin/env python3
"""Offline Chrome smoke test for SuperAgent Studio's first-party code exports.

Requires Python Playwright and locally installed Chrome; writes only to a
temporary workspace, never the current project's Studio storage.
"""
from __future__ import annotations
import argparse
import html
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", default=r"C:\Program Files\Google\Chrome\Application\chrome.exe")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"status": "unverified", "reason": "Install Python playwright to run browser E2E"}))
        return 2
    if not Path(args.chrome).is_file():
        print(json.dumps({"status": "unverified", "reason": "Chrome executable unavailable"}))
        return 2
    repo = Path(__file__).resolve().parent.parent
    root = Path(tempfile.mkdtemp(prefix="studio-native-smoke-"))
    details: list[dict[str, object]] = []

    def cli(*extra: str) -> dict:
        command = ["bun", "src/cli.tsx", "studio", *extra,
                   "--workspace", str(root), "--json"]
        result = subprocess.run(command, cwd=repo, capture_output=True, text=True,
                                timeout=35, check=True)
        return json.loads(result.stdout)

    try:
        project = cli("new", "--name", "Offline Test")
        eval_script = (
            'import {getMotionProject} from "./src/core/motion/project/projectStore.ts";'
            'import {evaluateFrame} from "./src/core/motion/timeline/evaluateFrame.ts";'
            'const p=await getMotionProject(process.argv[1],process.argv[2]);'
            'const frames=[0,0.25,0.5,0.75].map(v=>Math.floor(p.composition.durationFrames*v));'
            'console.log(JSON.stringify({total:p.composition.durationFrames,samples:frames.map(frame=>('
            '{frame,values:evaluateFrame(p,frame).layers.map(x=>x.values)}))}));'
        )
        expected = json.loads(subprocess.run(
            ["bun", "-e", eval_script, "--", str(root), project["id"]],
            cwd=repo, capture_output=True, text=True, check=True, timeout=20
        ).stdout)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True,
                executable_path=args.chrome, args=["--disable-extensions", "--no-first-run"])
            for mode in ("autoplay", "scroll", "click", "hover"):
                item = cli("export-code", project["id"], "--trigger", mode)
                page = browser.new_page(viewport={"width": 1280, "height": 800})
                page.context.set_offline(True)
                errors: list[str] = []
                requests: list[str] = []
                page.on("pageerror", lambda err: errors.append(str(err)))
                page.on("request", lambda req: requests.append(req.url)
                        if req.url.startswith(("http:", "https:")) else None)
                page.goto(Path(item["file"]).as_uri(), wait_until="load", timeout=20000)
                assert page.locator("#studio-stage").count() == 1
                if mode == "scroll":
                    page.evaluate("window.scrollTo(0, document.documentElement.scrollHeight)")
                elif mode == "click":
                    page.locator("#studio-stage").click(position={"x": 100, "y": 100})
                elif mode == "hover":
                    page.locator("#studio-stage").hover(position={"x": 100, "y": 100})
                page.wait_for_timeout(700)
                clock = page.locator("#studio-time").inner_text()
                seconds = float(clock.split("s")[0])
                assert seconds > 0, f"{mode} timeline did not advance: {clock}"
                assert not errors, (mode, errors)
                assert not requests, (mode, requests)
                assert "gsap" not in page.content().lower(), "Default exported source contains GSAP"
                if mode == "autoplay":
                    # Compare the exported browser engine to the canonical Studio
                    # evaluateFrame() on 4 timeline samples and every layer.
                    for sample in expected["samples"]:
                        step = round(sample["frame"] / expected["total"] * 1000)
                        if round(step * expected["total"] / 1000) != sample["frame"]:
                            continue  # native range input has integer ticks
                        actual = page.evaluate("""step => {
                          const bar = document.getElementById("studio-progress");
                          bar.value = String(step);
                          bar.dispatchEvent(new Event("input", {bubbles:true}));
                          return [...document.querySelectorAll("[data-studio-index]")]
                            .map(e => ({transform:e.getAttribute("transform"), opacity:e.getAttribute("opacity")}));
                        }""", step)
                        for idx, values in enumerate(sample["values"]):
                            raw = actual[idx]["transform"]
                            assert raw, f"Missing SVG transform on layer {idx}"
                            nums = [float(x) for x in __import__("re").findall(
                                r"[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?", raw)]
                            reference = [values[k] for k in ("x","y","rotation","scaleX","scaleY")]
                            assert len(nums) == len(reference), raw
                            assert all(abs(a-b)<0.06 for a,b in zip(nums,reference)), (
                                sample["frame"],idx,nums,reference)
                            assert abs(float(actual[idx]["opacity"])-values["opacity"])<0.01
                    details.append({"timeline_parity": "sampled transforms/opacity match canonical evaluator"})
                details.append({"trigger": mode, "elapsed_seconds": seconds, "network": 0, "errors": 0})
                page.close()
            page = browser.new_page(reduced_motion="reduce")
            page.context.set_offline(True)
            item = cli("export-code", project["id"], "--trigger", "autoplay", "--format", "react")
            source = Path(item["file"]).read_text(encoding="utf-8")
            assert source.startswith('"use client";')
            assert 'sandbox="allow-scripts"' in source
            match = re.search(r'const STUDIO_OFFLINE_HTML = (".*");', source)
            assert match, "React component does not include the scene"
            frame_html = json.loads(match.group(1))
            assert "cdn.jsdelivr.net" not in frame_html
            host = root / "embedded-react-test.html"
            host.write_text(
                '<!doctype html><html><body><iframe id="wrapped" sandbox="allow-scripts" srcdoc="' +
                html.escape(frame_html, quote=True) + '"></iframe></body></html>',
                encoding="utf-8"
            )
            page.goto(host.as_uri(), wait_until="load")
            inner = page.frame_locator("#wrapped")
            assert inner.locator("#studio-stage").count() == 1
            inner.locator("#studio-stage").click(position={"x": 100, "y": 100})
            page.wait_for_timeout(400)
            assert float(inner.locator("#studio-time").inner_text().split("s")[0]) > 0
            details.append({"react_iframe": "pass", "network": 0})
            page.close()
            page = browser.new_page(reduced_motion="reduce")
            page.context.set_offline(True)
            original = root / ".superagent" / "studio" / "code"
            html_path = next(original.glob("*-autoplay.html"))
            page.goto(html_path.as_uri(), wait_until="load")
            time_label = page.locator("#studio-time").inner_text()
            assert time_label.startswith("10.0s"), time_label
            details.append({"reduced_motion": "final frame"})
            browser.close()
        result = {"status": "pass", "checks": details}
        print(json.dumps(result, ensure_ascii=False) if args.json else str(result))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "failed", "error": str(exc), "checks": details}, ensure_ascii=False))
        return 1
    finally:
        shutil.rmtree(root, ignore_errors=True)

if __name__ == "__main__":
    sys.exit(main())
