import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DesktopUiError, asDesktopUiError } from "../errors.js";
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

const OSASCRIPT = "/usr/bin/osascript";
const SCREENCAPTURE = "/usr/sbin/screencapture";

const PROBE_SCRIPT = String.raw`
ObjC.import("CoreGraphics");
const se = Application("System Events");
let accessibility = false;
let screenRecording = false;
try { accessibility = Boolean(se.UIElementsEnabled()); } catch (_) {}
try { screenRecording = Boolean($.CGPreflightScreenCaptureAccess()); } catch (_) {}
JSON.stringify({ accessibility, screenRecording });
`;

const DISCOVERY_SCRIPT = String.raw`
ObjC.import("stdlib");
ObjC.import("CoreGraphics");
const payload = JSON.parse(ObjC.unwrap($.getenv("SUPERAGENT_DESKTOP_UI_PAYLOAD")));
const limit = Number(payload.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  throw new Error("INVALID_ACTION: discovery limit must be between 1 and 100");
}
const se = Application("System Events");
if (!Boolean(se.UIElementsEnabled())) {
  throw new Error("OS_PERMISSION_REQUIRED: macOS Accessibility permission is required for window discovery");
}
if (!Boolean($.CGPreflightScreenCaptureAccess())) {
  throw new Error("OS_PERMISSION_REQUIRED: macOS Screen Recording permission is required for stable window discovery");
}
let infos = [];
try {
  infos = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(
    Number($.kCGWindowListOptionOnScreenOnly) | Number($.kCGWindowListExcludeDesktopElements),
    Number($.kCGNullWindowID)
  ));
} catch (_) {
  throw new Error("OS_PERMISSION_REQUIRED: CoreGraphics window enumeration is unavailable");
}
if (!Array.isArray(infos)) throw new Error("PROCESS_FAILED: CoreGraphics returned no window list");

function closeEnough(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 1;
}
function cgBounds(info) {
  const b = info.kCGWindowBounds || {};
  return { x:Number(b.X), y:Number(b.Y), width:Number(b.Width), height:Number(b.Height) };
}
function axFlag(win, name) {
  try {
    for (const attr of win.attributes()) {
      if (String(attr.name()) === name) return Boolean(attr.value());
    }
  } catch (_) {}
  return false;
}

const items = [];
let skippedAmbiguous = 0;
outer: for (const proc of se.applicationProcesses()) {
  let pid = 0, application = "", frontmost = false, windows = [];
  try {
    pid = Number(proc.unixId());
    application = String(proc.name() || "").slice(0, 256);
    frontmost = Boolean(proc.frontmost());
    windows = proc.windows();
  } catch (_) { continue; }
  if (!Number.isInteger(pid) || pid <= 0 || !application) continue;
  for (const win of windows) {
    if (items.length > limit) break outer;
    let title = "", pos = null, size = null;
    try {
      title = String(win.name() || "").slice(0, 512);
      pos = win.position();
      size = win.size();
    } catch (_) { continue; }
    if (!title || Number(size[0]) <= 0 || Number(size[1]) <= 0) continue;
    const bounds = { x:Number(pos[0]), y:Number(pos[1]), width:Number(size[0]), height:Number(size[1]) };
    const candidates = [];
    for (const info of infos) {
      try {
        if (Number(info.kCGWindowOwnerPID) !== pid) continue;
        if (Number(info.kCGWindowLayer || 0) !== 0) continue;
        const id = Number(info.kCGWindowNumber);
        if (!Number.isFinite(id) || id <= 0) continue;
        const b = cgBounds(info);
        if (closeEnough(b.x, bounds.x) && closeEnough(b.y, bounds.y)
          && closeEnough(b.width, bounds.width) && closeEnough(b.height, bounds.height)) {
          candidates.push({ id, bounds: b });
        }
      } catch (_) {}
    }
    if (candidates.length !== 1) {
      if (candidates.length > 1) skippedAmbiguous += 1;
      continue;
    }
    let focused = false;
    try { focused = Boolean(win.focused()); } catch (_) {}
    const main = axFlag(win, "AXMain");
    items.push({
      pid,
      nativeId: "cg:" + String(candidates[0].id),
      title,
      application,
      active: Boolean(frontmost && (focused || main)),
      bounds
    });
  }
}
const truncated = items.length > limit;
JSON.stringify({ windows: items.slice(0, limit), limit, truncated, skippedAmbiguous });
`;

const TARGET_HELPER = String.raw`
ObjC.import("stdlib");
ObjC.import("CoreGraphics");
const payload = JSON.parse(ObjC.unwrap($.getenv("SUPERAGENT_DESKTOP_UI_PAYLOAD")));
const se = Application("System Events");

function closeEnough(a, b) {
  return Math.abs(Number(a) - Number(b)) <= 1;
}

function cgBounds(info) {
  const b = info.kCGWindowBounds || {};
  return {
    x: Number(b.X),
    y: Number(b.Y),
    width: Number(b.Width),
    height: Number(b.Height)
  };
}

function resolveTarget() {
  const processes = se.applicationProcesses();
  let proc = null;
  for (const candidate of processes) {
    try {
      if (Number(candidate.unixId()) === Number(payload.pid)) { proc = candidate; break; }
    } catch (_) {}
  }
  if (!proc) throw new Error("TARGET_NOT_FOUND: application process not found");

  const matches = [];
  for (const candidate of proc.windows()) {
    try {
      const name = String(candidate.name() || "");
      const pos = candidate.position();
      const size = candidate.size();
      if (Number(size[0]) <= 0 || Number(size[1]) <= 0) continue;
      if (!payload.title || name === payload.title) {
        matches.push({
          win: candidate,
          title: name,
          bounds: {
            x: Number(pos[0]),
            y: Number(pos[1]),
            width: Number(size[0]),
            height: Number(size[1])
          }
        });
      }
    } catch (_) {}
  }
  if (matches.length !== 1) {
    throw new Error("TARGET_NOT_FOUND: AX window selection is absent or ambiguous");
  }

  const ax = matches[0];
  let infos = [];
  try {
    infos = ObjC.deepUnwrap($.CGWindowListCopyWindowInfo(
      Number($.kCGWindowListOptionOnScreenOnly) | Number($.kCGWindowListExcludeDesktopElements),
      Number($.kCGNullWindowID)
    ));
  } catch (_) {
    throw new Error("SCREENSHOT_UNAVAILABLE: CoreGraphics window enumeration failed");
  }
  if (!Array.isArray(infos)) {
    throw new Error("SCREENSHOT_UNAVAILABLE: CoreGraphics returned no window list");
  }

  const expectedId = typeof payload.nativeId === "string" && payload.nativeId.startsWith("cg:")
    ? Number(payload.nativeId.slice(3))
    : null;
  const candidates = [];
  for (const info of infos) {
    try {
      if (Number(info.kCGWindowOwnerPID) !== Number(payload.pid)) continue;
      if (Number(info.kCGWindowLayer || 0) !== 0) continue;
      const id = Number(info.kCGWindowNumber);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (expectedId !== null && id !== expectedId) continue;
      const b = cgBounds(info);
      if (
        closeEnough(b.x, ax.bounds.x)
        && closeEnough(b.y, ax.bounds.y)
        && closeEnough(b.width, ax.bounds.width)
        && closeEnough(b.height, ax.bounds.height)
      ) {
        candidates.push({ id, bounds: b });
      }
    } catch (_) {}
  }
  if (candidates.length !== 1) {
    throw new Error("TARGET_NOT_FOUND: CoreGraphics window identity is absent or ambiguous");
  }

  const cg = candidates[0];
  return {
    proc,
    win: ax.win,
    title: ax.title,
    bounds: ax.bounds,
    nativeId: "cg:" + String(cg.id),
    windowId: cg.id
  };
}
`;

const WINDOW_SCRIPT = TARGET_HELPER + String.raw`
const target = resolveTarget();
JSON.stringify({
  pid: Number(payload.pid),
  nativeId: target.nativeId,
  title: target.title,
  active: Boolean(target.proc.frontmost()),
  bounds: target.bounds
});
`;

const ACCESSIBILITY_SCRIPT = TARGET_HELPER + String.raw`
const target = resolveTarget();
const win = target.win;
const items = [];
const stack = [{ node: win, depth: 0, path: "0" }];
while (stack.length && items.length < 2000) {
  const entry = stack.pop();
  const node = entry.node;
  try {
    const p = node.position();
    const s = node.size();
    const width = Number(s[0]), height = Number(s[1]);
    if (width > 0 && height > 0) {
      let role = "unknown";
      let subrole = "";
      let label = null;
      let description = null;
      let value = null;
      try { role = String(node.role() || "unknown").replace(/^AX/, "").toLowerCase(); } catch (_) {}
      try { subrole = String(node.subrole() || "").toLowerCase(); } catch (_) {}
      try { const v = String(node.name() || ""); if (v) label = v; } catch (_) {}
      try { const v = String(node.description() || ""); if (v) description = v; } catch (_) {}
      const protectedValue = role.includes("secure") || subrole.includes("secure") || role.includes("password") || subrole.includes("password");
      if (!protectedValue) {
        try {
          const raw = node.value();
          if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") value = String(raw);
        } catch (_) {}
      }
      let focused = false;
      try { focused = Boolean(node.focused()); } catch (_) {}
      items.push({
        role,
        label,
        description,
        value,
        focused,
        bounds: { x:Number(p[0]), y:Number(p[1]), width, height },
        actionable: ["button","textfield","checkbox","radiobutton","link","menuitem","combobox","slider"].includes(role),
        nativeRef: "axpath:" + entry.path
      });
    }
  } catch (_) {}
  if (entry.depth < 12) {
    try {
      const children = node.uiElements();
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ node: children[i], depth: entry.depth + 1, path: entry.path + "." + i });
      }
    } catch (_) {}
  }
}
JSON.stringify({
  window: {
    pid: Number(payload.pid),
    nativeId: target.nativeId,
    title: target.title,
    active: Boolean(target.proc.frontmost()),
    bounds: target.bounds
  },
  elements: items
});
`;

const INPUT_SCRIPT = TARGET_HELPER + String.raw`
const target = resolveTarget();
const proc = target.proc;
const win = target.win;
if (!proc.frontmost()) throw new Error("TARGET_NOT_ACTIVE: target application must already be frontmost");
let focused = false;
try { focused = Boolean(win.focused()); } catch (_) {
  throw new Error("TARGET_NOT_ACTIVE: unable to prove the selected AX window is focused");
}
if (!focused) throw new Error("TARGET_NOT_ACTIVE: selected AX window must already be focused");
const pos = [target.bounds.x, target.bounds.y];
const size = [target.bounds.width, target.bounds.height];
function assertPoint(x, y) {
  if (x < pos[0] || y < pos[1] || x >= pos[0] + size[0] || y >= pos[1] + size[1]) {
    throw new Error("INVALID_ACTION: target point outside scoped AX window");
  }
}
const keyCodes = {
  ENTER:36, TAB:48, ESCAPE:53, BACKSPACE:51, DELETE:117,
  ARROW_UP:126, ARROW_DOWN:125, ARROW_LEFT:123, ARROW_RIGHT:124,
  HOME:115, END:119, PAGE_UP:116, PAGE_DOWN:121, SPACE:49
};
if (payload.kind === "click" || payload.kind === "type") {
  assertPoint(Number(payload.x), Number(payload.y));
  proc.click({ at: [Math.round(Number(payload.x)), Math.round(Number(payload.y))] });
  if (payload.kind === "type") proc.keystroke(String(payload.text));
} else if (payload.kind === "key") {
  if (payload.modifiers && payload.modifiers.length) {
    throw new Error("INVALID_ACTION: macOS modifier chords are not enabled in this adapter");
  }
  if (!(payload.key in keyCodes)) throw new Error("INVALID_ACTION: unsupported key");
  proc.keyCode(keyCodes[payload.key]);
} else {
  throw new Error("INVALID_ACTION: macOS scroll is unsupported by the native adapter");
}
JSON.stringify({ ok:true });
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
    || !/^cg:\d+$/.test(value.nativeId)
    || !validBounds(value.bounds)
  ) {
    throw new DesktopUiError("PROCESS_FAILED", "macOS adapter returned an invalid window descriptor.");
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
    throw new DesktopUiError("PROCESS_FAILED", "macOS discovery returned a window without an application name.");
  }
  return { ...window, application: value.application };
}

function discoveryResultFrom(value: any, limit: number): DesktopWindowDiscoveryResult {
  const windows = Array.isArray(value?.windows) ? value.windows.map(discoveredWindowFrom) : [];
  const seen = new Set<string>();
  for (const window of windows) {
    const identity = `${window.pid}:${window.nativeId}`;
    if (seen.has(identity)) {
      throw new DesktopUiError("PROCESS_FAILED", "macOS discovery returned a duplicate CoreGraphics window identity.");
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

function windowId(nativeId: string): number {
  const match = /^cg:(\d+)$/.exec(nativeId);
  if (!match) {
    throw new DesktopUiError("TARGET_NOT_FOUND", "macOS target does not have an unambiguous CoreGraphics window ID.");
  }
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new DesktopUiError("TARGET_NOT_FOUND", "macOS CoreGraphics window ID is invalid.");
  }
  return id;
}

function mapMacError(
  error: unknown,
  fallbackCode: "OS_PERMISSION_REQUIRED" | "ACCESSIBILITY_UNAVAILABLE" | "INPUT_UNAVAILABLE",
  fallbackMessage: string,
): DesktopUiError {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("TARGET_NOT_FOUND")) return new DesktopUiError("TARGET_NOT_FOUND", message);
  if (message.includes("TARGET_NOT_ACTIVE")) return new DesktopUiError("TARGET_NOT_ACTIVE", message);
  if (message.includes("SCREENSHOT_UNAVAILABLE")) return new DesktopUiError("SCREENSHOT_UNAVAILABLE", message);
  if (message.includes("OS_PERMISSION_REQUIRED")) return new DesktopUiError("OS_PERMISSION_REQUIRED", message);
  return asDesktopUiError(error, fallbackCode, fallbackMessage);
}

export function createMacOsDesktopUiAdapter(
  runner: DesktopProcessRunner = createRestrictedProcessRunner([
    OSASCRIPT,
    SCREENCAPTURE,
  ]),
): DesktopUiAdapter {
  const runJxa = (script: string, payload?: unknown) =>
    runner.run({
      executable: OSASCRIPT,
      args: ["-l", "JavaScript", "-e", script],
      env: payload === undefined ? undefined : { SUPERAGENT_DESKTOP_UI_PAYLOAD: JSON.stringify(payload) },
      timeoutMs: 15_000,
    });

  const getWindow = async (target: DesktopWindowTarget) => {
    const result = await runJxa(WINDOW_SCRIPT, target);
    return windowFrom(parseJson(result.stdout, "macOS AX/CoreGraphics window lookup"));
  };

  return {
    platform: "darwin",

    async probe(): Promise<DesktopUiCapabilities> {
      try {
        const result = await runJxa(PROBE_SCRIPT);
        const payload = parseJson<{ accessibility: boolean; screenRecording: boolean }>(result.stdout, "macOS capability probe");
        const accessibility = payload.accessibility === true;
        const screenshot = payload.screenRecording === true;
        return {
          platform: "darwin",
          available: accessibility && screenshot,
          screenshot,
          accessibility,
          input: accessibility,
          scroll: false,
          prerequisites: ["macOS Accessibility permission for the SuperAgent host", "Screen Recording permission", "/usr/bin/osascript", "/usr/sbin/screencapture"],
          limitations: [
            "Window capture requires an unambiguous CoreGraphics window ID owned by the requested PID.",
            "Input is restricted to the already-frontmost and focused target AX window.",
            "Modifier key chords and native scrolling are intentionally not enabled.",
          ],
          errors: [
            ...(!accessibility ? ["macOS Accessibility permission is not enabled for the SuperAgent host."] : []),
            ...(!screenshot ? ["macOS Screen Recording permission is not enabled for the SuperAgent host."] : []),
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          platform: "darwin",
          available: false,
          screenshot: false,
          accessibility: false,
          input: false,
          scroll: false,
          prerequisites: ["macOS Accessibility permission for the SuperAgent host", "Screen Recording permission", "/usr/bin/osascript", "/usr/sbin/screencapture"],
          limitations: [],
          errors: [message],
        };
      }
    },


    async listWindows(limit: number): Promise<DesktopWindowDiscoveryResult> {
      const boundedLimit = requireDiscoveryLimit(limit);
      try {
        const result = await runJxa(DISCOVERY_SCRIPT, { limit: boundedLimit });
        return discoveryResultFrom(parseJson(result.stdout, "macOS window discovery"), boundedLimit);
      } catch (error) {
        throw mapMacError(error, "OS_PERMISSION_REQUIRED", "macOS window discovery failed");
      }
    },

    async getActiveWindow(): Promise<DesktopDiscoveredWindow | null> {
      const discovery = await this.listWindows!(100);
      const active = discovery.windows.filter((window) => window.active);
      return active.length === 1 ? active[0] : null;
    },

    openVerifiedCapture: process.env.SUPERAGENT_DESKTOP_LIVE_SCK === "1"
      ? async (window: DesktopDiscoveredWindow) => {
          if (process.platform !== "darwin" || process.arch !== "arm64" ||
              !/^cg:[1-9][0-9]*$/.test(window.nativeId) ||
              !Number.isSafeInteger(window.pid) || window.pid <= 0 ||
              !window.title || !window.application) {
            throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "ScreenCaptureKit requires a macOS ARM64 exact window.");
          }
          const { locateVerifiedMacSckHelper, SCK_HELPER_BACKEND } = await import("./macSckArtifact.js");
          const binary = locateVerifiedMacSckHelper();
          if (!binary) {
            throw new DesktopUiError("SCREENSHOT_UNAVAILABLE", "ScreenCaptureKit was selected but the verified helper is not installed.");
          }
          const { openFixedWindowPreviewWorker } = await import("./scopedNativePreviewWorker.js");
          return openFixedWindowPreviewWorker(binary, window, SCK_HELPER_BACKEND);
        }
      : undefined,

    async capture(target): Promise<NativeCapture> {
      const targetWindow = await getWindow(target);
      const id = windowId(targetWindow.nativeId);
      const dir = await mkdtemp(path.join(os.tmpdir(), "superagent-desktop-ui-"));
      const outputPath = path.join(dir, "capture.png");
      try {
        await runner.run({
          executable: SCREENCAPTURE,
          args: ["-x", `-l${id}`, "-t", "png", outputPath],
          timeoutMs: 15_000,
        });

        const confirmation = await getWindow({
          pid: targetWindow.pid,
          nativeId: targetWindow.nativeId,
          title: targetWindow.title,
        });
        if (!sameWindow(targetWindow, confirmation)) {
          throw new DesktopUiError(
            "STALE_SCREENSHOT",
            "macOS target window identity or bounds changed during window-ID capture.",
          );
        }

        return {
          image: await readFile(outputPath),
          capturedAt: new Date().toISOString(),
          targetWindow: confirmation,
        };
      } catch (error) {
        if (error instanceof DesktopUiError) throw error;
        throw mapMacError(
          error,
          "OS_PERMISSION_REQUIRED",
          "macOS target-window capture failed; Screen Recording permission may be missing",
        );
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },

    async inspectAccessibility(target, capture): Promise<AccessibilitySnapshot> {
      try {
        const result = await runJxa(ACCESSIBILITY_SCRIPT, {
          ...target,
          nativeId: capture.targetWindow.nativeId,
          title: capture.targetWindow.title,
        });
        const payload = parseJson<any>(result.stdout, "macOS AX inspection");
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
        throw mapMacError(error, "ACCESSIBILITY_UNAVAILABLE", "macOS AX inspection failed");
      }
    },

    async dispatch(action: NativeDesktopAction): Promise<void> {
      if (action.kind === "scroll") {
        throw new DesktopUiError("INPUT_UNAVAILABLE", "macOS native scrolling is not enabled by this adapter.");
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
      try {
        await runJxa(INPUT_SCRIPT, payload);
      } catch (error) {
        throw mapMacError(error, "INPUT_UNAVAILABLE", "macOS native input failed");
      }
    },
  };
}
