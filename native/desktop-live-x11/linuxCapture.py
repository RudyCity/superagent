#!/usr/bin/env python3
"""
SuperAgent Desktop Live Linux X11 exact-window capture worker.

The attended native consent gate lives in Core/Tray. This worker additionally
requires one matching, already-active AT-SPI/X11 window. No screen/root capture,
input injection, shell, screenshot files, or Wayland fallback is permitted.
"""
import base64
import json
import os
import re
import select
import subprocess
import sys
import time
import zlib

SESSION_SECONDS = 300
MAX_PNG_BYTES = 8 * 1024 * 1024
WMCTRL_LINE = re.compile(
    r"^\s*(0x[0-9a-fA-F]+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+"
    r"(-?\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$"
)
ACTIVE_WINDOW = re.compile(
    rb"_NET_ACTIVE_WINDOW\(WINDOW\): window id # 0x([0-9a-fA-F]+)\s*"
)
PROTECTED_WORDS = re.compile(
    r"\b(?:authentication|authorization|password|credentials?|polkit|"
    r"keyring|screen\s*lock|unlock|sudo)\b", re.IGNORECASE
)


def deny():
    raise RuntimeError("CAPTURE_DENIED")


def run_fixed(argv, timeout=6, limit=128 * 1024):
    """Only run fixed, absolute executable paths and bound stdout/time/memory."""
    process = None
    try:
        process = subprocess.Popen(
            argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, close_fds=True, env=os.environ.copy()
        )
        deadline = time.monotonic() + timeout
        chunks = []
        total = 0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select(
                [process.stdout], [], [], remaining
            )[0]:
                deny()
            block = os.read(process.stdout.fileno(), min(65536, limit + 1 - total))
            if not block:
                break
            total += len(block)
            if total > limit:
                deny()
            chunks.append(block)
        if process.wait(timeout=max(0.01, deadline - time.monotonic())) != 0:
            deny()
        return b"".join(chunks)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        deny()
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
            process.wait()


def process_start(pid):
    try:
        proc_path = "/proc/%d" % pid
        # X11 screenshot rights must not be used to capture a different user.
        if os.stat(proc_path).st_uid != os.getuid():
            deny()
        with open(proc_path + "/stat", "r", encoding="utf-8") as handle:
            stat = handle.read(8192)
        close = stat.rfind(")")
        if close < 0:
            deny()
        fields = stat[close + 2:].split()
        # Linux /proc/PID/stat starttime is field 22 (index 19 after comm).
        born = fields[19]
        if not born.isdecimal():
            deny()
        return born
    except (OSError, IndexError):
        deny()


def assert_target(target):
    if not isinstance(target, dict) or os.environ.get(
        "XDG_SESSION_TYPE", ""
    ).lower() != "x11":
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
    if target.get("active") is not True or target.get(
        "nativeId"
    ) != "atspi:%s:%s" % (pid, title):
        deny()
    if PROTECTED_WORDS.search(title) or PROTECTED_WORDS.search(name):
        deny()
    if not isinstance(bounds, dict) or set(bounds) != {
        "x", "y", "width", "height"
    }:
        deny()
    if not all(
        isinstance(bounds[k], int) and not isinstance(bounds[k], bool)
        for k in bounds
    ):
        deny()
    if not (1 <= bounds["width"] <= 8192 and
            1 <= bounds["height"] <= 8192 and
            bounds["width"] * bounds["height"] <= 16000000):
        deny()
    if any(abs(bounds[k]) > 50000 for k in ("x", "y")):
        deny()


def exact_window(target):
    # wmctrl -lpG: XID desktop PID X Y WIDTH HEIGHT hostname title
    # Reject a missing, ambiguous, moved, obscured or inactive target.
    try:
        lines = run_fixed(["/usr/bin/wmctrl", "-lpG"]).decode(
            "utf-8", "strict"
        ).splitlines()
    except UnicodeError:
        deny()
    candidates = []
    bounds = target["bounds"]
    for line in lines:
        match = WMCTRL_LINE.fullmatch(line)
        if match is None:
            continue
        xid, _desktop, pid, x, y, width, height, _host, title = match.groups()
        if (int(pid) == target["pid"] and title == target["title"] and
                int(x) == bounds["x"] and int(y) == bounds["y"] and
                int(width) == bounds["width"] and
                int(height) == bounds["height"] and int(xid, 16) > 0):
            candidates.append(int(xid, 16))
    if len(candidates) != 1:
        deny()
    focused = run_fixed(
        ["/usr/bin/xprop", "-root", "_NET_ACTIVE_WINDOW"], limit=4096
    ).strip()
    match = ACTIVE_WINDOW.fullmatch(focused)
    if not match or int(match.group(1), 16) != candidates[0]:
        deny()
    return candidates[0]


def window_fingerprint(target, xid):
    # The wmctrl PID comes from the X11 window property. Revalidate the
    # property on this exact XID and pin its complete identity for the session.
    props = run_fixed([
        "/usr/bin/xprop", "-id", hex(xid),
        "_NET_WM_PID", "WM_CLASS", "_NET_WM_NAME", "WM_NAME"
    ], limit=16384)
    pid = re.search(rb"(?m)^_NET_WM_PID\(CARDINAL\) = ([0-9]+)\s*$", props)
    if pid is None or int(pid.group(1)) != target["pid"]:
        deny()
    if not re.search(rb"(?m)^WM_CLASS\(STRING\) = .+$", props):
        deny()
    return props


def verify_atspi_window(target):
    # The AT-SPI tree is independent of X11's client-supplied PID/title.
    # Fail closed when inaccessible, ambiguous, protected, or too large.
    try:
        import gi
        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi
        desktop = Atspi.get_desktop(0)
        matches = []
        for app_index in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(app_index)
            if (int(app.get_process_id()) != target["pid"] or
                    (app.get_name() or "") != target["application"]):
                continue
            for index in range(app.get_child_count()):
                node = app.get_child_at_index(index)
                if (node.get_role_name() in ("frame", "window", "dialog") and
                        node.get_name() == target["title"]):
                    matches.append(node)
        if len(matches) != 1:
            deny()
        window = matches[0]
        state = window.get_state_set()
        if not state.contains(Atspi.StateType.ACTIVE):
            deny()
        rect = window.get_component_iface().get_extents(
            Atspi.CoordType.SCREEN
        )
        if any(getattr(rect, key) != target["bounds"][key]
               for key in ("x", "y", "width", "height")):
            deny()
        protected = getattr(Atspi.StateType, "PROTECTED", None)
        pending = [(window, 0)]
        visited = 0
        while pending:
            node, depth = pending.pop()
            visited += 1
            if visited > 2000 or depth > 12:
                deny()
            role = (node.get_role_name() or "").lower()
            node_state = node.get_state_set()
            if ("password" in role or "credential" in role or
                    (protected is not None and node_state.contains(protected))):
                deny()
            count = node.get_child_count()
            if count < 0 or count > 2000 or visited + len(pending) + count > 2000:
                deny()
            for index in range(count):
                pending.append((node.get_child_at_index(index), depth + 1))
    except Exception:
        deny()


def validate_png(png, bounds):
    if len(png) < 57 or len(png) > MAX_PNG_BYTES or not png.startswith(
        b"\x89PNG\r\n\x1a\n"
    ):
        deny()
    offset = 8
    first = True
    has_idat = False
    while offset < len(png):
        if len(png) - offset < 12:
            deny()
        length = int.from_bytes(png[offset:offset + 4], "big")
        kind = png[offset + 4:offset + 8]
        end = offset + 12 + length
        if length > MAX_PNG_BYTES or end > len(png):
            deny()
        data = png[offset + 8:offset + 8 + length]
        actual_crc = int.from_bytes(png[offset + 8 + length:end], "big")
        if zlib.crc32(kind + data) & 0xffffffff != actual_crc:
            deny()
        if first:
            if kind != b"IHDR" or length != 13:
                deny()
            width = int.from_bytes(data[0:4], "big")
            height = int.from_bytes(data[4:8], "big")
            if width != bounds["width"] or height != bounds["height"]:
                deny()
            first = False
        elif kind == b"IHDR":
            deny()
        if kind == b"IDAT":
            has_idat = True
        if kind == b"IEND":
            if length != 0 or not has_idat or end != len(png):
                deny()
            return
        offset = end
    deny()


def read_command(deadline, pending):
    # Read from the fd, not TextIOWrapper.readline(): the latter can prefetch
    # multiple commands, making select() miss an already-buffered "close".
    while b"\n" not in pending:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select(
            [sys.stdin], [], [], remaining
        )[0]:
            return None, b""
        block = os.read(sys.stdin.fileno(), 64)
        if not block:
            return None, b""
        pending += block
        if len(pending) > 64:
            deny()
    raw, pending = pending.split(b"\n", 1)
    try:
        if len(raw) > 16:
            deny()
        return raw.rstrip(b"\r").decode("ascii", "strict"), pending
    except UnicodeError:
        deny()


def main():
    target_raw = os.environ.get("SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET", "")
    if not target_raw or len(target_raw) > 4096:
        deny()
    target = json.loads(target_raw)
    assert_target(target)
    born = process_start(target["pid"])
    xid = exact_window(target)
    fingerprint = window_fingerprint(target, xid)
    verify_atspi_window(target)
    started = time.monotonic()
    deadline = started + SESSION_SECONDS
    print('{"type":"ready"}', flush=True)
    pending = b""
    while True:
        command, pending = read_command(deadline, pending)
        if command is None or command == "close":
            return  # expire even when the controller sends no more input
        if command != "capture":
            return
        try:
            if time.monotonic() >= deadline:
                deny()
            if (process_start(target["pid"]) != born or
                    exact_window(target) != xid or
                    window_fingerprint(target, xid) != fingerprint):
                deny()
            verify_atspi_window(target)
            png = run_fixed([
                "/usr/bin/import", "-quiet", "-window", hex(xid), "png:-"
            ], limit=MAX_PNG_BYTES)
            validate_png(png, target["bounds"])
            if (time.monotonic() >= deadline or
                    process_start(target["pid"]) != born or
                    exact_window(target) != xid or
                    window_fingerprint(target, xid) != fingerprint):
                deny()
            verify_atspi_window(target)
            print(json.dumps({
                "type": "frame", "png": base64.b64encode(png).decode("ascii"),
                "window": {
                    "pid": target["pid"], "nativeId": target["nativeId"],
                    "title": target["title"], "active": True,
                    "bounds": target["bounds"]
                }
            }, separators=(",", ":")), flush=True)
        except Exception:
            print('{"type":"denied"}', flush=True)
            return


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(2)
