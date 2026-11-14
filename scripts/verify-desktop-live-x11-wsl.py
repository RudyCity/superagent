#!/usr/bin/env python3
"""Isolated Linux X11/AT-SPI real-pixel smoke; never captures the user desktop.

Run ONLY with an ephemeral Xvfb display and disposable GTK fixture:
  dbus-run-session -- env XDG_SESSION_TYPE=x11 GDK_BACKEND=x11 \
    SUPERAGENT_X11_E2E_ISOLATED=xvfb \
    xvfb-run -a -s "-screen 0 1024x768x24" \
    python3 scripts/verify-desktop-live-x11-wsl.py

Requires python3-gi, Gtk3/Atspi typelibs, openbox, wmctrl, xprop,
ImageMagick import and Xvfb. No network, monitor snapshot or OS input.
"""
from __future__ import annotations

import base64
import json
import os
from pathlib import Path
import re
import select
import struct
import subprocess
import sys
import time

TITLE = "SuperAgent X11 Fixture"
RENAMED = "Changed X11 Fixture"
ROOT = Path(__file__).resolve().parent.parent
WORKER = ROOT / "native" / "desktop-live-x11" / "linuxCapture.py"
FIXTURE = """
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib
GLib.set_prgname("SuperAgent X11 Fixture")
GLib.set_application_name("SuperAgent X11 Fixture")
window = Gtk.Window(title="SuperAgent X11 Fixture")
window.set_decorated(False)
window.set_default_size(320, 200)
window.set_position(Gtk.WindowPosition.CENTER)
window.connect("destroy", Gtk.main_quit)
window.show_all()
window.present()
Gtk.main()
"""


def run(args: list[str]) -> str:
    result = subprocess.run(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, timeout=5, check=True,
    )
    return result.stdout.strip()


def stop_owned(proc: subprocess.Popen | None) -> None:
    if proc is None:
        return
    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=4)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()


def receive(worker: subprocess.Popen, timeout: int = 8) -> dict:
    readable, _, _ = select.select([worker.stdout], [], [], timeout)
    if not readable:
        raise RuntimeError("X11 fixture worker timed out.")
    line = worker.stdout.readline()
    if not line or len(line) > 12_000_000:
        raise RuntimeError("X11 fixture worker returned no bounded response.")
    parsed = json.loads(line)
    if not isinstance(parsed, dict):
        raise RuntimeError("X11 fixture worker returned malformed data.")
    return parsed


def smoke() -> None:
    display = os.environ.get("DISPLAY", "")
    if (os.environ.get("SUPERAGENT_X11_E2E_ISOLATED") != "xvfb" or
            not re.fullmatch(r":[1-9][0-9]*(?:\.[0-9]+)?", display) or
            os.environ.get("XDG_SESSION_TYPE") != "x11"):
        raise RuntimeError("An explicit isolated Xvfb display is mandatory.")
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi

    env = dict(os.environ)
    env["NO_AT_BRIDGE"] = "0"
    env["GDK_BACKEND"] = "x11"
    env.pop("WAYLAND_DISPLAY", None)
    wm = child = worker = None
    try:
        wm = subprocess.Popen(
            ["/usr/bin/openbox", "--sm-disable"], env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.1)
        if "Name: Openbox" not in run(["/usr/bin/wmctrl", "-m"]):
            raise RuntimeError("Temporary window manager unavailable.")

        child = subprocess.Popen(
            ["/usr/bin/python3", "-c", FIXTURE], env=env,
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        lines: list[str] = []
        for _ in range(45):
            time.sleep(0.2)
            rows = run(["/usr/bin/wmctrl", "-lpG"]).splitlines()
            lines = [line for line in rows if line.endswith(" " + TITLE)]
            if len(lines) == 1:
                break
        if len(lines) != 1:
            raise RuntimeError("Unique disposable X11 fixture not found.")
        cols = lines[0].split(maxsplit=8)
        if len(cols) != 9 or cols[8] != TITLE or int(cols[2]) != child.pid:
            raise RuntimeError("Fixture XID or PID changed.")
        xid, pid = cols[0], child.pid
        bounds = dict(zip(("x", "y", "width", "height"), map(int, cols[3:7])))
        if f"window id # {hex(int(xid, 16))}" not in run([
                "/usr/bin/xprop", "-root", "_NET_ACTIVE_WINDOW"]):
            raise RuntimeError("Fixture window is not active.")

        desktop = Atspi.get_desktop(0)
        applications = [
            desktop.get_child_at_index(i)
            for i in range(desktop.get_child_count())
        ]
        apps = [app for app in applications if app.get_process_id() == pid]
        if len(apps) != 1:
            raise RuntimeError("AT-SPI fixture process identity is ambiguous.")
        app = apps[0]
        matches = [
            app.get_child_at_index(i)
            for i in range(app.get_child_count())
            if app.get_child_at_index(i).get_name() == TITLE
        ]
        if len(matches) != 1 or matches[0].get_role_name() not in ("frame", "window"):
            raise RuntimeError("AT-SPI fixture window identity is ambiguous.")
        node = matches[0]
        rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
        actual = {k: int(getattr(rect, k)) for k in bounds}
        if actual != bounds or not node.get_state_set().contains(Atspi.StateType.ACTIVE):
            raise RuntimeError("X11/AT-SPI bounds or active state did not match exactly.")
        target = {
            "pid": pid, "nativeId": f"atspi:{pid}:{TITLE}",
            "title": TITLE, "application": app.get_name(),
            "active": True, "bounds": bounds,
        }
        env["SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET"] = json.dumps(target)
        worker = subprocess.Popen(
            ["/usr/bin/python3", str(WORKER)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env,
        )
        if receive(worker) != {"type": "ready"}:
            raise RuntimeError("Worker rejected exact-window consent fixture.")
        worker.stdin.write("capture\n")
        worker.stdin.flush()
        frame = receive(worker)
        if frame.get("type") != "frame":
            raise RuntimeError("Verified X11 fixture was not captured.")
        pixels = base64.b64decode(frame["png"], validate=True)
        if (len(pixels) < 57 or len(pixels) > 8 * 1024 * 1024 or
                pixels[:8] != b"\x89PNG\r\n\x1a\n" or
                struct.unpack(">II", pixels[16:24]) != (bounds["width"], bounds["height"])):
            raise RuntimeError("X11 PNG bytes or dimensions did not match.")
        print(f"WSL_X11_REAL_FRAME_PASS {bounds['width']}x{bounds['height']} png_bytes={len(pixels)}")

        run(["/usr/bin/wmctrl", "-ir", xid, "-T", RENAMED])
        time.sleep(0.2)
        worker.stdin.write("capture\n")
        worker.stdin.flush()
        if receive(worker) != {"type": "denied"}:
            raise RuntimeError("Window rename failed to revoke the worker.")
        print("WSL_X11_RENAME_REVOKE_PASS")
    finally:
        stop_owned(worker)
        stop_owned(child)
        stop_owned(wm)


if __name__ == "__main__":
    try:
        smoke()
    except Exception as exc:
        # Never print screen bytes or user windows.
        print(f"WSL_X11_FIXTURE_FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(2)
