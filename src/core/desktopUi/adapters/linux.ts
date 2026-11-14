import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopUiError, asDesktopUiError } from "../errors.js";
import {
  PYTHON_PORTAL_READINESS_SCRIPT, parseLinuxPortalReadiness,
} from "./linuxPortalPolicy.js";
import { createRestrictedProcessRunner, type DesktopProcessRunner } from "../processRunner.js";
import type {
  AccessibilitySnapshot,
  DesktopBounds,
  DesktopDiscoveredWindow,
  DesktopUiAdapter,
  DesktopUiCapabilities,
  DesktopWindow,
  DesktopWindowDiscoveryResult,
  DesktopWindowTarget,
  NativeCapture,
  NativeDesktopAction,
} from "../types.js";

const PYTHON3 = "/usr/bin/python3";
const GNOME_SCREENSHOT = "/usr/bin/gnome-screenshot";
const SCROT = "/usr/bin/scrot";
const WMCTRL = "/usr/bin/wmctrl";
const XPROP = "/usr/bin/xprop";
const IMAGE_MAGICK_IMPORT = "/usr/bin/import";

const PYTHON_DISCOVERY_SCRIPT = String.raw`
import json, os
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
payload = json.loads(os.environ["SUPERAGENT_DESKTOP_UI_PAYLOAD"])
limit = int(payload.get("limit", 0))
if limit < 1 or limit > 100:
    raise RuntimeError("INVALID_ACTION: discovery limit must be between 1 and 100")
desktop = Atspi.get_desktop(0)
candidates = {}
order = []
ambiguous = set()
scanned = 0
scan_truncated = False
for app_index in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(app_index)
    try:
        pid = int(app.get_process_id())
        application = (app.get_name() or "")[:256]
    except Exception:
        continue
    if pid <= 0 or not application:
        continue
    for win_index in range(app.get_child_count()):
        if scanned >= 1000:
            scan_truncated = True
            break
        scanned += 1
        node = app.get_child_at_index(win_index)
        try:
            role = node.get_role_name() or ""
            title = (node.get_name() or "")[:512]
            if role not in ("frame", "window", "dialog") or not title:
                continue
            rect = node.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
            if rect.width <= 0 or rect.height <= 0:
                continue
            key = "%s\0%s" % (pid, title)
            if key in candidates:
                ambiguous.add(key)
                continue
            states = node.get_state_set()
            candidates[key] = {
                "pid": pid,
                "nativeId": "atspi:%s:%s" % (pid, title),
                "title": title,
                "application": application,
                "active": bool(states.contains(Atspi.StateType.ACTIVE)),
                "bounds": {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
            }
            order.append(key)
        except Exception:
            pass
    if scan_truncated:
        break
windows = [candidates[key] for key in order if key not in ambiguous]
print(json.dumps({
    "windows": windows[:limit],
    "limit": limit,
    "truncated": bool(scan_truncated or len(windows) > limit),
    "skippedAmbiguous": len(ambiguous)
}))
`;

const PYTHON_WINDOW_SCRIPT = String.raw`
import json, os
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
payload = json.loads(os.environ["SUPERAGENT_DESKTOP_UI_PAYLOAD"])
desktop = Atspi.get_desktop(0)
target_app = None
for i in range(desktop.get_child_count()):
    app = desktop.get_child_at_index(i)
    try:
        if int(app.get_process_id()) == int(payload["pid"]):
            target_app = app
            break
    except Exception:
        pass
if target_app is None:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI application not found")
matches = []
for i in range(target_app.get_child_count()):
    node = target_app.get_child_at_index(i)
    try:
        name = node.get_name() or ""
        role = node.get_role_name() or ""
        if role in ("frame", "window", "dialog") and (not payload.get("title") or name == payload["title"]):
            matches.append(node)
    except Exception:
        pass
if len(matches) != 1:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI window selection is absent or ambiguous")
target_window = matches[0]
component = target_window.get_component_iface()
rect = component.get_extents(Atspi.CoordType.SCREEN)
states = target_window.get_state_set()
active = states.contains(Atspi.StateType.ACTIVE)
title = target_window.get_name() or ""
resolved_native_id = "atspi:%s:%s" % (payload["pid"], title)
if payload.get("nativeId") and payload["nativeId"] != resolved_native_id:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI nativeId does not match the requested window")
print(json.dumps({
    "pid": int(payload["pid"]),
    "nativeId": resolved_native_id,
    "title": title,
    "active": bool(active),
    "bounds": {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
}))
`;

const PYTHON_ACCESSIBILITY_SCRIPT = String.raw`
import json, os
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
payload = json.loads(os.environ["SUPERAGENT_DESKTOP_UI_PAYLOAD"])
desktop = Atspi.get_desktop(0)
app = None
for i in range(desktop.get_child_count()):
    candidate = desktop.get_child_at_index(i)
    try:
        if int(candidate.get_process_id()) == int(payload["pid"]):
            app = candidate
            break
    except Exception:
        pass
if app is None:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI application not found")
matches = []
for i in range(app.get_child_count()):
    node = app.get_child_at_index(i)
    try:
        name = node.get_name() or ""
        if node.get_role_name() in ("frame", "window", "dialog") and (not payload.get("title") or name == payload["title"]):
            matches.append(node)
    except Exception:
        pass
if len(matches) != 1:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI window selection is absent or ambiguous")
win = matches[0]
title = win.get_name() or ""
resolved_native_id = "atspi:%s:%s" % (payload["pid"], title)
if payload.get("nativeId") and payload["nativeId"] != resolved_native_id:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI nativeId does not match the requested window")
rect = win.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
active = win.get_state_set().contains(Atspi.StateType.ACTIVE)
items = []
stack = [(win, 0, "0")]
while stack and len(items) < 2000:
    node, depth, node_path = stack.pop()
    try:
        comp = node.get_component_iface()
        bounds = comp.get_extents(Atspi.CoordType.SCREEN)
        if bounds.width > 0 and bounds.height > 0:
            action = node.get_action_iface()
            actionable = bool(action and action.get_n_actions() > 0)
            role_name = node.get_role_name() or "unknown"
            states = node.get_state_set()
            protected_state = getattr(Atspi.StateType, "PROTECTED", None)
            protected = bool(protected_state is not None and states.contains(protected_state))
            protected = protected or "password" in role_name.lower()
            value = None
            if not protected:
                try:
                    text_iface = node.get_text_iface()
                    if text_iface and text_iface.get_character_count() <= 4096:
                        raw = text_iface.get_text(0, text_iface.get_character_count())
                        if raw:
                            value = raw
                except Exception:
                    pass
            name = node.get_name() or None
            description = node.get_description() or None
            items.append({
                "role": role_name,
                "label": name,
                "description": description,
                "value": value,
                "bounds": {"x": bounds.x, "y": bounds.y, "width": bounds.width, "height": bounds.height},
                "actionable": actionable,
                "focused": bool(states.contains(Atspi.StateType.FOCUSED)),
                "nativeRef": "atspipath:" + node_path
            })
    except Exception:
        pass
    if depth < 12:
        try:
            for idx in range(node.get_child_count() - 1, -1, -1):
                stack.append((node.get_child_at_index(idx), depth + 1, node_path + "." + str(idx)))
        except Exception:
            pass
print(json.dumps({
    "window": {
        "pid": int(payload["pid"]),
        "nativeId": resolved_native_id,
        "title": title,
        "active": bool(active),
        "bounds": {"x": rect.x, "y": rect.y, "width": rect.width, "height": rect.height}
    },
    "elements": items
}))
`;

const PYTHON_INPUT_SCRIPT = String.raw`
import json, os
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
payload = json.loads(os.environ["SUPERAGENT_DESKTOP_UI_PAYLOAD"])
desktop = Atspi.get_desktop(0)
app = None
for i in range(desktop.get_child_count()):
    candidate = desktop.get_child_at_index(i)
    try:
        if int(candidate.get_process_id()) == int(payload["pid"]):
            app = candidate
            break
    except Exception:
        pass
if app is None:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI application not found")
matches = []
for i in range(app.get_child_count()):
    node = app.get_child_at_index(i)
    try:
        name = node.get_name() or ""
        if node.get_role_name() in ("frame", "window", "dialog") and (not payload.get("title") or name == payload["title"]):
            matches.append(node)
    except Exception:
        pass
if len(matches) != 1:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI window selection is absent or ambiguous")
win = matches[0]
title = win.get_name() or ""
resolved_native_id = "atspi:%s:%s" % (payload["pid"], title)
if payload.get("nativeId") and payload["nativeId"] != resolved_native_id:
    raise RuntimeError("TARGET_NOT_FOUND: AT-SPI nativeId does not match the requested window")
if not win.get_state_set().contains(Atspi.StateType.ACTIVE):
    raise RuntimeError("TARGET_NOT_ACTIVE: target AT-SPI window must already be active")
rect = win.get_component_iface().get_extents(Atspi.CoordType.SCREEN)
def assert_point(x, y):
    if x < rect.x or y < rect.y or x >= rect.x + rect.width or y >= rect.y + rect.height:
        raise RuntimeError("INVALID_ACTION: point outside scoped AT-SPI window")
kind = payload["kind"]
if kind in ("click", "type", "scroll"):
    x, y = int(round(payload["x"])), int(round(payload["y"]))
    assert_point(x, y)
if kind == "click":
    Atspi.generate_mouse_event(x, y, "b1c")
elif kind == "type":
    Atspi.generate_mouse_event(x, y, "b1c")
    Atspi.generate_keyboard_event(0, str(payload["text"]), Atspi.KeySynthType.STRING)
elif kind == "key":
    if payload.get("modifiers"):
        raise RuntimeError("INVALID_ACTION: modifier chords are not enabled for the Linux adapter")
    key_names = {
        "ENTER":"Return", "TAB":"Tab", "ESCAPE":"Escape", "BACKSPACE":"BackSpace", "DELETE":"Delete",
        "ARROW_UP":"Up", "ARROW_DOWN":"Down", "ARROW_LEFT":"Left", "ARROW_RIGHT":"Right",
        "HOME":"Home", "END":"End", "PAGE_UP":"Page_Up", "PAGE_DOWN":"Page_Down", "SPACE":"space"
    }
    if payload["key"] not in key_names:
        raise RuntimeError("INVALID_ACTION: unsupported key")
    Atspi.generate_keyboard_event(0, key_names[payload["key"]], Atspi.KeySynthType.SYM)
elif kind == "scroll":
    dy, dx = int(payload.get("deltaY", 0)), int(payload.get("deltaX", 0))
    for _ in range(abs(dy)):
        Atspi.generate_mouse_event(x, y, "b4c" if dy > 0 else "b5c")
    for _ in range(abs(dx)):
        Atspi.generate_mouse_event(x, y, "b6c" if dx > 0 else "b7c")
else:
    raise RuntimeError("INVALID_ACTION: unknown native action")
print(json.dumps({"ok": True}))
`;

function parseJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DesktopUiError("PROCESS_FAILED", `${context} returned invalid JSON.`);
  }
}

function validBounds(bounds: any): bounds is DesktopBounds {
  return bounds
    && typeof bounds.x === "number"
    && typeof bounds.y === "number"
    && typeof bounds.width === "number"
    && typeof bounds.height === "number"
    && Number.isFinite(bounds.x)
    && Number.isFinite(bounds.y)
    && Number.isFinite(bounds.width)
    && Number.isFinite(bounds.height)
    && bounds.width > 0
    && bounds.height > 0;
}

function windowFrom(value: any): DesktopWindow {
  if (
    !value
    || typeof value.pid !== "number"
    || typeof value.nativeId !== "string"
    || !validBounds(value.bounds)
  ) {
    throw new DesktopUiError("PROCESS_FAILED", "Linux adapter returned an invalid window descriptor.");
  }
  return {
    pid: value.pid,
    nativeId: value.nativeId,
    title: typeof value.title === "string" ? value.title : "",
    active: value.active === true,
    bounds: value.bounds,
  };
}


function requireDiscoveryLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DesktopUiError("INVALID_ACTION", "Window discovery limit must be an integer between 1 and 100.");
  }
  return limit;
}

function discoveredWindowFrom(value: any): DesktopDiscoveredWindow {
  const window = windowFrom(value);
  if (typeof value?.application !== "string" || !value.application.trim()) {
    throw new DesktopUiError("PROCESS_FAILED", "Linux discovery returned a window without an application name.");
  }
  return { ...window, application: value.application };
}

function discoveryResultFrom(value: any, limit: number): DesktopWindowDiscoveryResult {
  const windows = Array.isArray(value?.windows) ? value.windows.map(discoveredWindowFrom) : [];
  const seen = new Set<string>();
  for (const window of windows) {
    const identity = `${window.pid}:${window.nativeId}`;
    if (seen.has(identity)) {
      throw new DesktopUiError("PROCESS_FAILED", "Linux discovery returned a duplicate AT-SPI window identity.");
    }
    seen.add(identity);
  }
  const skippedAmbiguous = Number.isInteger(value?.skippedAmbiguous) && value.skippedAmbiguous > 0
    ? value.skippedAmbiguous
    : undefined;
  return { windows, limit, truncated: value?.truncated === true, ...(skippedAmbiguous ? { skippedAmbiguous } : {}) };
}

function sameWindow(a: DesktopWindow, b: DesktopWindow): boolean {
  return a.pid === b.pid
    && a.nativeId === b.nativeId
    && a.bounds.x === b.bounds.x
    && a.bounds.y === b.bounds.y
    && a.bounds.width === b.bounds.width
    && a.bounds.height === b.bounds.height;
}

export function createLinuxDesktopUiAdapter(
  runner: DesktopProcessRunner = createRestrictedProcessRunner([
    PYTHON3,
    GNOME_SCREENSHOT,
    SCROT,
    WMCTRL,
    XPROP,
    IMAGE_MAGICK_IMPORT,
  ]),
): DesktopUiAdapter {
  const sessionType = (process.env.XDG_SESSION_TYPE || "").trim().toLowerCase();

  const runPython = (script: string, payload: unknown) =>
    runner.run({
      executable: PYTHON3,
      args: ["-c", script],
      env: { SUPERAGENT_DESKTOP_UI_PAYLOAD: JSON.stringify(payload) },
      timeoutMs: 15_000,
    });

  const getWindow = async (target: DesktopWindowTarget) => {
    const result = await runPython(PYTHON_WINDOW_SCRIPT, target);
    return windowFrom(parseJson(result.stdout, "Linux AT-SPI window lookup"));
  };

  const useVerifiedX11 = sessionType === "x11" &&
    process.env.SUPERAGENT_DESKTOP_LIVE_X11 === "1";

  const findScreenshotCommand = async (): Promise<typeof GNOME_SCREENSHOT | typeof SCROT | null> => {
    // On Wayland, gnome-screenshot -w does not provide a verifiable XID/AT-SPI
    // binding. A compositor permission prompt alone cannot pin the selected
    // window. Deny until a one-window portal stream has an identity receipt.
    if (sessionType !== "x11") return null;
    try {
      await runner.run({ executable: GNOME_SCREENSHOT, args: ["--version"], timeoutMs: 3_000 });
      return GNOME_SCREENSHOT;
    } catch {}
    if (sessionType !== "x11") return null;
    try {
      await runner.run({ executable: SCROT, args: ["--version"], timeoutMs: 3_000 });
      return SCROT;
    } catch {}
    return null;
  };

  return {
    platform: "linux",

    async probe(): Promise<DesktopUiCapabilities> {
      let accessibility = false;
      const errors: string[] = [];
      try {
        await runPython(
          'import json, gi; gi.require_version("Atspi","2.0"); from gi.repository import Atspi; print(json.dumps({"ok": True}))',
          {},
        );
        accessibility = true;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }

      let portalDescription = "";
      if (sessionType === "wayland") {
        try {
          const response = await runner.run({
            executable: PYTHON3,
            args: ["-c", PYTHON_PORTAL_READINESS_SCRIPT],
            timeoutMs: 6_000,
          });
          const portal = parseLinuxPortalReadiness(
            parseJson(response.stdout, "Wayland ScreenCast/PipeWire availability"));
          portalDescription = portal.available
            ? `Portal v${portal.version}: WINDOW=${portal.supportsWindow}, hidden-cursor=${portal.hiddenCursor}, PipeWire reader=${portal.pipewireReader}.`
            : "ScreenCast/PipeWire portal is unavailable.";
        } catch {
          portalDescription = "ScreenCast/PipeWire portal capability cannot be verified.";
        }
      }
      const screenshotCommand = useVerifiedX11 ? null : await findScreenshotCommand();
      let verifiedX11 = false;
      if (useVerifiedX11) {
        try {
          const { locateVerifiedLinuxX11Helper } = await import("./linuxX11Artifact.js");
          if (!locateVerifiedLinuxX11Helper()) throw new Error("Missing X11 bundle");
          await runner.run({ executable: WMCTRL, args: ["-lpG"], timeoutMs: 3_000 });
          await runner.run({ executable: XPROP, args: ["-root", "_NET_ACTIVE_WINDOW"], timeoutMs: 3_000 });
          await runner.run({ executable: IMAGE_MAGICK_IMPORT, args: ["-version"], timeoutMs: 3_000 });
          verifiedX11 = true;
        } catch {
          errors.push("Verified Linux X11 worker requires its checksum-pinned script and wmctrl/xprop/ImageMagick tools on the active X11 desktop.");
        }
      }
      const screenshot = accessibility && (useVerifiedX11 ? verifiedX11 : screenshotCommand !== null);
      const input = accessibility && sessionType === "x11";
      if (sessionType !== "x11") {
        errors.push(
          sessionType === "wayland"
            ? "Wayland native input injection is intentionally disabled; use CDP/Delegate for Chrome/Electron or a compositor-approved integration."
            : "Native input is disabled unless XDG_SESSION_TYPE is explicitly and positively identified as x11.",
        );
      }
      if (sessionType === "wayland") {
        errors.push("Wayland Desktop Live denied: portal window streams do not carry a standard, verifiable AT-SPI PID/native-ID binding. " + portalDescription);
      } else if (!useVerifiedX11 && !screenshotCommand) {
        errors.push("No scoped screenshot backend is available (gnome-screenshot, or scrot on verified X11).");
      }

      return {
        platform: "linux",
        available: accessibility && screenshot,
        screenshot,
        accessibility,
        input,
        scroll: input,
        sessionType: sessionType || "unknown",
        prerequisites: ["Python 3", "PyGObject AT-SPI bindings", "AT-SPI accessibility bus", "X11 gnome-screenshot/scrot or compositor-verified PipeWire window binding"],
        limitations: [
          "Native capture is limited to the already-active target window and is revalidated immediately after capture.",
          "Input injection is enabled only for a positively identified X11 session.",
          "Wayland and unknown session types are default-denied for native input.",
          "Modifier key chords are intentionally not enabled.",
        ],
        errors,
      };
    },


    async listWindows(limit: number): Promise<DesktopWindowDiscoveryResult> {
      const boundedLimit = requireDiscoveryLimit(limit);
      try {
        const result = await runPython(PYTHON_DISCOVERY_SCRIPT, { limit: boundedLimit });
        return discoveryResultFrom(parseJson(result.stdout, "Linux AT-SPI window discovery"), boundedLimit);
      } catch (error) {
        throw asDesktopUiError(error, "ACCESSIBILITY_UNAVAILABLE", "Linux AT-SPI window discovery failed");
      }
    },

    async getActiveWindow(): Promise<DesktopDiscoveredWindow | null> {
      const discovery = await this.listWindows!(100);
      const active = discovery.windows.filter((window) => window.active);
      return active.length === 1 ? active[0] : null;
    },

    openVerifiedCapture: useVerifiedX11
      ? async (window: DesktopDiscoveredWindow) => {
          if (process.platform !== "linux" || process.arch !== "x64" ||
              !window.active || !window.title || !window.application ||
              window.nativeId !== `atspi:${window.pid}:${window.title}`) {
            throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "X11 verified preview requires the exact active application window.");
          }
          const { locateVerifiedLinuxX11Helper, X11_HELPER_BACKEND } = await import("./linuxX11Artifact.js");
          const script = locateVerifiedLinuxX11Helper();
          if (!script) throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Linux X11 worker binary checksum is unavailable.");
          const { openFixedWindowPreviewWorker } = await import("./scopedNativePreviewWorker.js");
          return openFixedWindowPreviewWorker("/usr/bin/python3", window, X11_HELPER_BACKEND, [script]);
        }
      : undefined,

    async capture(target): Promise<NativeCapture> {
      if (sessionType !== "x11") {
        throw new DesktopUiError("OS_PERMISSION_REQUIRED",
          "Window-only Linux capture is unavailable without verified X11 or a compositor-attested PipeWire window.");
      }
      const targetWindow = await getWindow(target);
      if (!targetWindow.active) {
        throw new DesktopUiError(
          "TARGET_NOT_ACTIVE",
          "Linux scoped screenshot capture requires the target AT-SPI window to already be active.",
        );
      }

      const command = await findScreenshotCommand();
      if (!command) {
        throw new DesktopUiError(
          "DEPENDENCY_REQUIRED",
          "No scoped Linux screenshot command is available.",
        );
      }

      const dir = await mkdtemp(path.join(os.tmpdir(), "superagent-desktop-ui-"));
      const outputPath = path.join(dir, "capture.png");
      try {
        if (command === GNOME_SCREENSHOT) {
          await runner.run({ executable: command, args: ["-w", "-f", outputPath], timeoutMs: 15_000 });
        } else {
          await runner.run({ executable: command, args: ["-u", outputPath], timeoutMs: 15_000 });
        }

        const confirmation = await getWindow({
          pid: targetWindow.pid,
          nativeId: targetWindow.nativeId,
          title: targetWindow.title,
        });
        if (!confirmation.active || !sameWindow(targetWindow, confirmation)) {
          throw new DesktopUiError(
            "STALE_SCREENSHOT",
            "Linux target window lost active identity while the window-scoped screenshot was captured.",
          );
        }

        return {
          image: await readFile(outputPath),
          capturedAt: new Date().toISOString(),
          targetWindow: confirmation,
        };
      } catch (error) {
        if (error instanceof DesktopUiError) throw error;
        throw asDesktopUiError(error, "SCREENSHOT_UNAVAILABLE", "Linux active-window screenshot failed");
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async inspectAccessibility(target, capture): Promise<AccessibilitySnapshot> {
      try {
        const result = await runPython(PYTHON_ACCESSIBILITY_SCRIPT, {
          ...target,
          nativeId: capture.targetWindow.nativeId,
          title: capture.targetWindow.title,
        });
        const payload = parseJson<any>(result.stdout, "Linux AT-SPI inspection");
        const window = windowFrom(payload.window);
        const elements = (Array.isArray(payload.elements) ? payload.elements : [])
          .filter((element: any) =>
            typeof element?.role === "string"
            && validBounds(element.bounds))
          .map((element: any) => ({
            role: element.role,
            label: typeof element.label === "string" ? element.label : null,
            description: typeof element.description === "string" ? element.description : null,
            value: typeof element.value === "string" ? element.value : null,
            bounds: element.bounds,
            center: {
              x: element.bounds.x + element.bounds.width / 2,
              y: element.bounds.y + element.bounds.height / 2,
            },
            actionable: element.actionable === true,
            focused: typeof element.focused === "boolean" ? element.focused : undefined,
            nativeRef: typeof element.nativeRef === "string" ? element.nativeRef : undefined,
          }));
        return { window, elements };
      } catch (error) {
        throw asDesktopUiError(error, "ACCESSIBILITY_UNAVAILABLE", "Linux AT-SPI inspection failed");
      }
    },

    async dispatch(action: NativeDesktopAction): Promise<void> {
      if (sessionType !== "x11") {
        throw new DesktopUiError(
          sessionType === "wayland" ? "WAYLAND_INPUT_UNAVAILABLE" : "INPUT_UNAVAILABLE",
          sessionType === "wayland"
            ? "Native input injection is disabled on Wayland without a compositor-approved integration."
            : "Native input injection is disabled until the Linux session is positively identified as X11.",
        );
      }

      const payload: Record<string, unknown> = {
        pid: action.target.pid,
        nativeId: action.target.nativeId,
        title: action.target.title,
        kind: action.kind,
      };
      if ("point" in action) {
        payload.x = action.point.x;
        payload.y = action.point.y;
      }
      if (action.kind === "type") payload.text = action.text;
      if (action.kind === "key") {
        payload.key = action.key;
        payload.modifiers = action.modifiers;
      }
      if (action.kind === "scroll") {
        payload.deltaX = action.deltaX;
        payload.deltaY = action.deltaY;
      }

      try {
        await runPython(PYTHON_INPUT_SCRIPT, payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("TARGET_NOT_ACTIVE")) {
          throw new DesktopUiError("TARGET_NOT_ACTIVE", "Linux input requires the scoped AT-SPI window to already be active.");
        }
        if (message.includes("TARGET_NOT_FOUND")) {
          throw new DesktopUiError("TARGET_NOT_FOUND", message);
        }
        throw asDesktopUiError(error, "INPUT_UNAVAILABLE", "Linux AT-SPI input failed");
      }
    },
  };
}
