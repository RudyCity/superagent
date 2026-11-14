import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Every Python worker assertion is mocked; no X server, screen or import
// invocation is ever required. On Windows, exercise Python inside Ubuntu WSL2.
const python = process.platform === "win32" ? "wsl.exe" : "/usr/bin/python3";
const command = (code: string) =>
  process.platform === "win32" ? ["-e", "python3", "-c", code] : ["-c", code];
const probe = spawnSync(python, command("print('PYTHON_READY')"), {
  timeout: 5000, encoding: "utf8",
});
const pythonIt = probe.status === 0 ? it : it.skip;

const HARNESS = String.raw`
import contextlib
import io
import json
import os
import struct
import sys
import types
import unittest
import zlib
from unittest.mock import patch

source = sys.stdin.read()

def worker():
    namespace = {"__name__": "test_linux_capture"}
    exec(compile(source, "linuxCapture.py", "exec"), namespace)
    return namespace

def target():
    return {"pid": 1234, "nativeId": "atspi:1234:Demo Window",
            "title": "Demo Window", "application": "Demo",
            "active": True,
            "bounds": {"x": 3, "y": 4, "width": 1, "height": 1}}

def denied(function):
    try:
        function()
    except RuntimeError as error:
        assert str(error) == "CAPTURE_DENIED", str(error)
    else:
        raise AssertionError("Expected capture denial")

def png_chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data +
            struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff))

def fixture_png():
    header = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    return (bytes([137,80,78,71,13,10,26,10]) +
            png_chunk(b"IHDR", header) +
            png_chunk(b"IDAT", zlib.compress(bytes([0, 0, 0, 0, 255]))) +
            png_chunk(b"IEND", b""))

class X11Smoke(unittest.TestCase):
    def test_wmctrl_columns_pid_geometry_and_focus(self):
        ns = worker()
        lines = [b"0x000001ae  0 1234 3 4 1 1 laptop Demo Window"]
        active = [b"_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1ae"]
        def mock_run(argv, **kwargs):
            return b"\n".join(lines) if argv[1] == "-lpG" else active[0]
        ns["run_fixed"] = mock_run
        self.assertEqual(ns["exact_window"](target()), 0x1ae)
        lines[0] = b"0x000001ae  0 4321 3 4 1 1 laptop Demo Window"
        denied(lambda: ns["exact_window"](target()))
        lines[0] = b"0x000001ae  0 1234 3 4 2 1 laptop Demo Window"
        denied(lambda: ns["exact_window"](target()))
        lines[0] = b"0x000001ae  0 1234 3 4 1 1 laptop Demo Window"
        active[0] = b"_NET_ACTIVE_WINDOW(WINDOW): window id # 0x2ae"
        denied(lambda: ns["exact_window"](target()))
        active[0] = b"_NET_ACTIVE_WINDOW(WINDOW): window id # 0x1ae"
        lines.append(lines[0])
        denied(lambda: ns["exact_window"](target()))

    def test_xid_fingerprint_rejects_wrong_pid_and_missing_class(self):
        ns = worker()
        data = [b'_NET_WM_PID(CARDINAL) = 1234\nWM_CLASS(STRING) = "demo", "Demo"\n']
        ns["run_fixed"] = lambda *args, **kwargs: data[0]
        self.assertEqual(ns["window_fingerprint"](target(), 0x1ae), data[0])
        data[0] = b'_NET_WM_PID(CARDINAL) = 4321\nWM_CLASS(STRING) = "demo"\n'
        denied(lambda: ns["window_fingerprint"](target(), 0x1ae))
        data[0] = b'_NET_WM_PID(CARDINAL) = 1234\n'
        denied(lambda: ns["window_fingerprint"](target(), 0x1ae))

    def test_target_and_pid_reuse_guards(self):
        ns = worker()
        with patch.dict(os.environ, {"XDG_SESSION_TYPE": "x11"}):
            ns["assert_target"](target())
            old = target()
            old["active"] = False
            denied(lambda: ns["assert_target"](old))
            old = target()
            old["nativeId"] = "atspi:1234:Wrong"
            denied(lambda: ns["assert_target"](old))
            old = target()
            old["title"] = "Password prompt"
            denied(lambda: ns["assert_target"](old))
            old = target()
            old["bounds"]["width"] = 99999
            denied(lambda: ns["assert_target"](old))
        with patch.dict(os.environ, {"XDG_SESSION_TYPE": "wayland"}):
            denied(lambda: ns["assert_target"](target()))
        self.assertTrue(ns["process_start"](os.getpid()).isdecimal())
        denied(lambda: ns["process_start"](999999999))

    def test_atspi_active_bounds_and_protected_descendants(self):
        ns = worker()
        class State:
            def __init__(self, active=True, protected=False):
                self.active, self.protected = active, protected
            def contains(self, item):
                return self.active if item == "ACTIVE" else self.protected
        class Node:
            def __init__(self, role="frame", name="Demo Window", active=True, children=None):
                self.role, self.name = role, name
                self.state = State(active)
                self.children = children or []
            def get_role_name(self): return self.role
            def get_name(self): return self.name
            def get_state_set(self): return self.state
            def get_child_count(self): return len(self.children)
            def get_child_at_index(self, index): return self.children[index]
            def get_component_iface(self): return self
            def get_extents(self, coord):
                return types.SimpleNamespace(x=3, y=4, width=1, height=1)
        win = Node()
        app = Node(name="Demo", children=[win])
        app.get_process_id = lambda: 1234
        desktop = Node(children=[app])
        atspi = types.SimpleNamespace(get_desktop=lambda _: desktop,
            StateType=types.SimpleNamespace(ACTIVE="ACTIVE", PROTECTED="PROTECTED"),
            CoordType=types.SimpleNamespace(SCREEN="SCREEN"))
        gi = types.ModuleType("gi")
        gi.require_version = lambda *_: None
        repository = types.ModuleType("gi.repository")
        repository.Atspi = atspi
        gi.repository = repository
        with patch.dict(sys.modules, {"gi": gi, "gi.repository": repository}):
            ns["verify_atspi_window"](target())
            win.children = [Node(role="password text", name="secret")]
            denied(lambda: ns["verify_atspi_window"](target()))
            win.children = []
            win.state.active = False
            denied(lambda: ns["verify_atspi_window"](target()))
            win.state.active = True
            win.get_extents = lambda _: types.SimpleNamespace(x=3,y=4,width=2,height=1)
            denied(lambda: ns["verify_atspi_window"](target()))
            win.get_extents = lambda _: types.SimpleNamespace(x=3,y=4,width=1,height=1)
            app.children = [win, win]
            denied(lambda: ns["verify_atspi_window"](target()))

    def test_png_chunks_crc_dimensions_and_truncation(self):
        ns = worker()
        png = fixture_png()
        ns["validate_png"](png, target()["bounds"])
        other = target()["bounds"].copy()
        other["width"] = 2
        denied(lambda: ns["validate_png"](png, other))
        denied(lambda: ns["validate_png"](png[:-3], target()["bounds"]))
        denied(lambda: ns["validate_png"](png + b"garbage", target()["bounds"]))
        corrupt = bytearray(png)
        corrupt[20] ^= 1
        denied(lambda: ns["validate_png"](bytes(corrupt), target()["bounds"]))

    def test_capture_revokes_when_xid_changes_after_frame(self):
        ns = worker()
        ns["assert_target"] = lambda _: None
        ns["process_start"] = lambda _: "original-birth"
        ids = iter([42, 42, 43])
        ns["exact_window"] = lambda _: next(ids)
        ns["window_fingerprint"] = lambda *_: b"unchanged"
        ns["verify_atspi_window"] = lambda *_: None
        ns["run_fixed"] = lambda *_args, **_kwargs: fixture_png()
        ns["read_command"] = lambda *_: ("capture", b"")
        ns["sys"] = types.SimpleNamespace(stdin=io.StringIO("capture\n"))
        ns["os"] = types.SimpleNamespace(environ={
            "SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET": json.dumps(target())
        })
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            ns["main"]()
        self.assertEqual(output.getvalue().splitlines(),
                         ['{"type":"ready"}', '{"type":"denied"}'])

    def test_capture_revokes_when_process_birth_changes(self):
        ns = worker()
        ns["assert_target"] = lambda _: None
        births = iter(["old", "old", "reused"])
        ns["process_start"] = lambda _: next(births)
        ns["exact_window"] = lambda _: 42
        ns["window_fingerprint"] = lambda *_: b"unchanged"
        ns["verify_atspi_window"] = lambda *_: None
        ns["run_fixed"] = lambda *_args, **_kwargs: fixture_png()
        ns["read_command"] = lambda *_: ("capture", b"")
        ns["sys"] = types.SimpleNamespace(stdin=io.StringIO("capture\n"))
        ns["os"] = types.SimpleNamespace(environ={
            "SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET": json.dumps(target())
        })
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            ns["main"]()
        self.assertEqual(output.getvalue().splitlines(),
                         ['{"type":"ready"}', '{"type":"denied"}'])

    def test_subprocess_timeout_and_output_limit_reap_children(self):
        ns = worker()
        original = ns["subprocess"].Popen
        children = []
        def tracking(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        with patch.object(ns["subprocess"], "Popen", side_effect=tracking):
            denied(lambda: ns["run_fixed"](
                ["/usr/bin/python3", "-c", "import time;time.sleep(3)"],
                timeout=0.05))
            denied(lambda: ns["run_fixed"](
                ["/usr/bin/python3", "-c", "print('X'*100000)"],
                limit=256))
        self.assertEqual(len(children), 2)
        self.assertTrue(all(child.poll() is not None for child in children))

    def test_fd_command_reader_consumes_buffered_close_and_expires(self):
        ns = worker()
        read_fd, write_fd = os.pipe()
        os.write(write_fd, b"capture\nclose\n")
        os.close(write_fd)
        with os.fdopen(read_fd, "rb", buffering=0) as stream:
            ns["sys"] = types.SimpleNamespace(stdin=stream)
            deadline = ns["time"].monotonic() + 1
            first, pending = ns["read_command"](deadline, b"")
            self.assertEqual(first, "capture")
            second, pending = ns["read_command"](deadline, pending)
            self.assertEqual(second, "close")
            third, _ = ns["read_command"](deadline, pending)
            self.assertIsNone(third)
        read_fd, write_fd = os.pipe()
        with os.fdopen(read_fd, "rb", buffering=0) as stream:
            ns["sys"] = types.SimpleNamespace(stdin=stream)
            result, _ = ns["read_command"](ns["time"].monotonic(), b"")
            self.assertIsNone(result)
        os.close(write_fd)

    def test_idle_session_expires_without_input(self):
        ns = worker()
        ns["assert_target"] = lambda _: None
        ns["process_start"] = lambda _: "born"
        ns["exact_window"] = lambda _: 42
        ns["window_fingerprint"] = lambda *_: b"unchanged"
        ns["verify_atspi_window"] = lambda *_: None
        ns["SESSION_SECONDS"] = 0
        ns["time"] = types.SimpleNamespace(monotonic=lambda: 100)
        ns["select"] = types.SimpleNamespace(select=lambda *_: self.fail("expired worker must not block"))
        ns["sys"] = types.SimpleNamespace(stdin=io.StringIO(""))
        ns["os"] = types.SimpleNamespace(environ={
            "SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET": json.dumps(target())
        })
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            ns["main"]()
        self.assertEqual(output.getvalue().strip(), '{"type":"ready"}')

suite = unittest.defaultTestLoader.loadTestsFromTestCase(X11Smoke)
result = unittest.TextTestRunner(verbosity=2, stream=sys.stderr).run(suite)
print("X11_PYTHON_SMOKE_PASS" if result.wasSuccessful() else "X11_PYTHON_SMOKE_FAIL")
sys.exit(0 if result.wasSuccessful() else 1)
`;

describe("Linux X11 worker (no physical screenshot, no X11 utilities installed)", () => {
  pythonIt("fails closed on forged targets, protected windows, focus, XID/PID reuse and PNG corruption", () => {
    const source = readFileSync(path.join("native", "desktop-live-x11", "linuxCapture.py"), "utf8");
    const result = spawnSync(python, command(HARNESS), {
      input: source,
      timeout: 15000,
      maxBuffer: 1_000_000,
      encoding: "utf8",
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("X11_PYTHON_SMOKE_PASS");
  });
});
