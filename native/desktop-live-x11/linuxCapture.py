#!/usr/bin/env python3
"""
SuperAgent Desktop Live Linux/X11 exact active-window capture worker.
Optional X11 worker; NOT a Wayland portal bypass. No shell, screen-wide
fallback, input injection, screenshot files, or privileged commands.
Requires /usr/bin/wmctrl, /usr/bin/xprop and ImageMagick /usr/bin/import.
Core/Tray native attended consent is required before launching.
"""
import base64
import json
import os
import re
import subprocess
import sys
import time


def deny():
    raise RuntimeError("CAPTURE_DENIED")


def run_fixed(argv, timeout=6):
    try:
        p = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           check=False, timeout=timeout, env=os.environ.copy())
    except (OSError, subprocess.TimeoutExpired):
        deny()
    if p.returncode != 0:
        deny()
    return p.stdout


def process_start(pid):
    try:
        with open("/proc/%d/stat" % pid, "r", encoding="utf-8") as handle:
            stat = handle.read(8192)
        close = stat.rfind(")")
        if close < 0:
            deny()
        fields = stat[close + 2:].split()
        # Linux proc stat starttime field #22; indexes after "comm)" start #3.
        return fields[19]
    except (OSError, IndexError):
        deny()


def assert_target(target):
    if os.environ.get("XDG_SESSION_TYPE", "").lower() != "x11":
        deny()
    pid = target.get("pid")
    title = target.get("title")
    name = target.get("application")
    bounds = target.get("bounds")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        deny()
    if not isinstance(title, str) or not title or len(title) > 512:
        deny()
    if not isinstance(name, str) or not name or len(name) > 256:
        deny()
    if target.get("nativeId") != "atspi:%s:%s" % (pid, title):
        deny()
    if not isinstance(bounds, dict) or set(bounds) != {"x","y","width","height"}:
        deny()
    if not all(isinstance(bounds[k], int) and not isinstance(bounds[k], bool)
               for k in bounds):
        deny()
    if bounds["width"] < 1 or bounds["height"] < 1 or \
            bounds["width"] > 8192 or bounds["height"] > 8192 or \
            bounds["width"] * bounds["height"] > 16000000:
        deny()
    if any(abs(bounds[k]) > 50000 for k in ("x", "y")):
        deny()


def exact_window(target):
    # wmctrl -lpG: XID desktop PID X Y WIDTH HEIGHT host title
    # Reject ambiguous matching titles, coordinate mismatches, and inactive
    # windows; do not select XIDs merely by a title or by geometrical area.
    entries = run_fixed(["/usr/bin/wmctrl", "-lpG"]).decode("utf-8", "strict").splitlines()
    candidates = []
    b = target["bounds"]
    for line in entries:
        cols = line.split(None, 8)
        if len(cols) != 9:
            continue
        try:
            xid = int(cols[0], 16)
            pid = int(cols[2])
            x, y, w, h = [int(value) for value in cols[3:7]]
        except ValueError:
            continue
        if pid == target["pid"] and cols[8] == target["title"] and \
                x == b["x"] and y == b["y"] and \
                w == b["width"] and h == b["height"] and xid > 0:
            candidates.append(xid)
    if len(candidates) != 1:
        deny()
    focused = run_fixed(["/usr/bin/xprop", "-root", "_NET_ACTIVE_WINDOW"])
    match = re.search(rb"0x([a-fA-F0-9]+)", focused)
    if not match or int(match.group(1), 16) != candidates[0]:
        deny()
    return candidates[0]


def main():
    target_raw = os.environ.get("SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET", "")
    if not target_raw or len(target_raw) > 4096:
        deny()
    target = json.loads(target_raw)
    assert_target(target)
    born = process_start(target["pid"])
    xid = exact_window(target)
    print('{"type":"ready"}', flush=True)
    started = time.monotonic()
    for command in sys.stdin:
        if command.rstrip("\r\n") == "close":
            return
        if command.rstrip("\r\n") != "capture" or time.monotonic() - started > 300:
            return
        try:
            if process_start(target["pid"]) != born or exact_window(target) != xid:
                deny()
            png = run_fixed(["/usr/bin/import", "-quiet", "-window", hex(xid), "png:-"])
            if len(png) < 24 or len(png) > 8 * 1024 * 1024 or \
                    png[:8] != b"\x89PNG\r\n\x1a\n":
                deny()
            width = int.from_bytes(png[16:20], "big")
            height = int.from_bytes(png[20:24], "big")
            bounds = target["bounds"]
            if width != bounds["width"] or height != bounds["height"]:
                deny()
            if process_start(target["pid"]) != born or exact_window(target) != xid:
                deny()
            # The bytes are only released to the authenticated local Core.
            output = {"type": "frame", "png": base64.b64encode(png).decode("ascii"),
                "window": {"pid": target["pid"], "nativeId": target["nativeId"],
                "title": target["title"], "active": True, "bounds": target["bounds"]}}
            print(json.dumps(output, separators=(",", ":")), flush=True)
        except Exception:
            print('{"type":"denied"}', flush=True)
            return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(2)
