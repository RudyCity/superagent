/**
 * Chrome Remote Debugging (CDP) automation — drives the user's REAL Chrome
 * browser directly via http://127.0.0.1:9222, WITHOUT the Superagent Chrome
 * Extension and without any isolated background tab.
 *
 * Requires Chrome to be started with --remote-debugging-port=9222
 * (close ALL Chrome windows, then reopen Chrome from the taskbar shortcut).
 *
 * Every network hop is timeout-guarded: a closed debug port, a dead target,
 * or a silent tab fails fast with an actionable message instead of hanging.
 */
import { Tool } from "./types.js";
import { get as httpGet, request as httpRequest } from "http";
import { ensureCdpRunning } from "./chromeCommon.js";
import {
  CdpTarget,
  SnapshotEntry,
  PageOverview,
  snapshotStore,
  snapshotPrevStore,
  SNAPSHOT_JS,
  READ_PAGE_JS,
  buildExtractLinksJs,
  READY_STATE_JS,
  buildClickJs,
  buildTypeJs,
  buildWaitForJs,
  parseActionResult,
  parseTimeoutMs,
  formatSnapshotEntry,
  formatSnapshotDiff,
  formatContextHeader,
  resolveActionSelector,
  waitForInPage,
  handleIncomingCdpEvent,
  getRecentDialogs,
  clearCdpDialogs,
  formatDialogEntry,
  executeGetDialogsCommand,
  executeHandleDialogCommand,
} from "./chromeCdpHelpers.js";
import {
  captureCdpScreenshot,
  formatScreenshotResult,
  attachScreenshotIfRequested,
} from "./chromeCdpScreenshot.js";
import {
  executeVerifyAction,
  captureDomState,
  observeActionTransition,
  formatTransitionSummary,
  DomStateSnapshot,
} from "./chromeCdpTransition.js";
import { executeInspectMediaDevices } from "./chromeCdpMedia.js";
import {
  executeCursorCommand,
  dispatchHumanMouseClick,
  resolveElementCenterPoint,
  executeDragAndDropCommand,
} from "./chromeCdpCursor.js";
import { executeDeviceEmulationCommand } from "./chromeCdpEmulation.js";

/**
 * Test hooks — read lazily so unit tests can point the tool at a mock CDP
 * server by setting env vars before each call.
 */
let resolvedHost: string | null = null;

function cdpHost(): string {
  if (process.env.SUPERAGENT_CDP_HOST) return process.env.SUPERAGENT_CDP_HOST;
  return resolvedHost || "127.0.0.1";
}

function alternateHost(current: string): string | null {
  if (process.env.SUPERAGENT_CDP_HOST) return null;
  if (current === "127.0.0.1") return "::1";
  if (current === "::1") return "127.0.0.1";
  return null;
}

function cdpPort(): number {
  return Number(process.env.SUPERAGENT_CDP_PORT) || 9222;
}

function cdpTimeoutMs(): number {
  return Number(process.env.SUPERAGENT_CDP_TIMEOUT_MS) || 20000;
}

/** Exact user-facing message when the Chrome debug port is not reachable. */
export const CDP_PORT_CLOSED_MSG =
  "Chrome is not running with --remote-debugging-port=9222. " +
  "Launch Chrome via launch_chrome_profile(remoteDebuggingPort: 9222) " +
  "or run scripts/chrome-debug.bat, then retry. " +
  "Note: launch_chrome_profile uses an isolated debug profile so it starts immediately without needing to close or kill running Chrome instances. " +
  "FORBIDDEN: Do NOT attempt to kill the user's running Chrome processes with taskkill or shell commands.";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `… [truncated, ${s.length} chars total]` : s;
}

function httpGetJson(path: string, isRetry = false, overrideHost?: string): Promise<any> {
  const host = overrideHost || cdpHost();
  return new Promise((resolve, reject) => {
    const req = httpGet(
      { host, port: cdpPort(), path, timeout: cdpTimeoutMs() },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode === 426) {
            wsGetJson(path).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`CDP endpoint ${path} returned HTTP ${res.statusCode}; expected 200 with a JSON body.`));
            return;
          }
          try {
            if (!overrideHost && !process.env.SUPERAGENT_CDP_HOST) {
              resolvedHost = host;
            }
            resolve(JSON.parse(data));
          } catch (e: any) {
            reject(new Error(`Invalid JSON from CDP endpoint ${path}: ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timed out after ${cdpTimeoutMs()}ms reaching the CDP endpoint ${path}.`));
    });
    req.on("error", async (err: any) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")) {
        const alt = alternateHost(host);
        if (alt && !overrideHost) {
          try {
            const altRes = await httpGetJson(path, isRetry, alt);
            resolvedHost = alt;
            resolve(altRes);
            return;
          } catch {
            // Alternate host also failed, proceed to auto-launch check
          }
        }
        if (!isRetry) {
          const started = await ensureCdpRunning(cdpHost(), cdpPort());
          if (started) {
            try {
              const retryRes = await httpGetJson(path, true);
              resolve(retryRes);
              return;
            } catch {}
          }
        }
        reject(new Error(CDP_PORT_CLOSED_MSG));
      } else {
        reject(err);
      }
    });
  });
}

function httpPutJson(path: string, isRetry = false, overrideHost?: string): Promise<any> {
  const host = overrideHost || cdpHost();
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host, port: cdpPort(), path, method: "PUT", timeout: cdpTimeoutMs() },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            if (!overrideHost && !process.env.SUPERAGENT_CDP_HOST) {
              resolvedHost = host;
            }
            resolve(data ? JSON.parse(data) : data);
          } catch {
            resolve(data);
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timed out after ${cdpTimeoutMs()}ms reaching the CDP endpoint ${path}.`));
    });
    req.on("error", async (err: any) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")) {
        const alt = alternateHost(host);
        if (alt && !overrideHost) {
          try {
            const altRes = await httpPutJson(path, isRetry, alt);
            resolvedHost = alt;
            resolve(altRes);
            return;
          } catch {}
        }
        if (!isRetry) {
          const started = await ensureCdpRunning(cdpHost(), cdpPort());
          if (started) {
            try {
              const retryRes = await httpPutJson(path, true);
              resolve(retryRes);
              return;
            } catch {}
          }
        }
        reject(new Error(CDP_PORT_CLOSED_MSG));
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

function wsGetJson(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };
    const fail = (msg: string): void => {
      done(() => reject(new Error(msg)));
    };
    (async () => {
      try {
        const { WebSocket } = await getWsModule();
        const host = cdpHost();
        const hostUrl = host.includes(":") ? `[${host}]` : host;
        const url = `ws://${hostUrl}:${cdpPort()}${path}`;
        const ws = new WebSocket(url, {
          handshakeTimeout: cdpTimeoutMs(),
          origin: `http://${hostUrl}:${cdpPort()}`,
        });
        const timer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          fail(
            `CDP discovery via WebSocket timed out for ${path}: the DevTools server answered HTTP 426 ` +
              `(Upgrade Required) but did not send the JSON document over the upgraded connection. ` +
              `This Chrome version may have removed plain discovery; try an older Chrome build.`
          );
        }, cdpTimeoutMs());
        ws.on("message", (data: any) => {
          clearTimeout(timer);
          const text = String(data);
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          done(() => {
            try {
              resolve(JSON.parse(text));
            } catch (e: any) {
              reject(new Error(`Invalid JSON from CDP WebSocket endpoint ${path}: ${e.message}`));
            }
          });
        });
        ws.on("error", (err: any) => {
          clearTimeout(timer);
          fail(
            `CDP discovery via WebSocket failed for ${path}: ${(err && err.message) || String(err)}. ` +
              `The DevTools server answered HTTP 426 (Upgrade Required) but the WebSocket fallback did not yield the JSON document.`
          );
        });
        ws.on("close", (code: number) => {
          clearTimeout(timer);
          fail(
            `CDP discovery via WebSocket closed (code ${code}) for ${path} without sending the JSON document. ` +
              `The DevTools server answered HTTP 426 (Upgrade Required); this Chrome version may require a different discovery mechanism.`
          );
        });
      } catch (e: any) {
        fail(`CDP discovery via WebSocket could not start for ${path}: ${(e && e.message) || String(e)}`);
      }
    })();
  });
}

async function listPageTargets(): Promise<CdpTarget[]> {
  const targets: any = await httpGetJson("/json/list");
  if (!Array.isArray(targets)) {
    throw new Error("Unexpected response from CDP /json/list (not an array).");
  }
  return targets.filter((t: any) => t && t.type === "page" && t.webSocketDebuggerUrl);
}

async function pickTarget(targetId?: string, autoActivate = true): Promise<CdpTarget> {
  let pages = await listPageTargets();
  if (pages.length === 0) {
    try {
      await httpPutJson("/json/new");
      pages = await listPageTargets();
    } catch {
      /* continue to check */
    }
  }
  if (pages.length === 0) {
    throw new Error("No page targets found on the Chrome remote-debugging endpoint. Open a tab in Chrome and retry.");
  }
  pruneCdpConnections(pages.map((p) => p.webSocketDebuggerUrl));
  const target = targetId ? pages.find((p) => p.id === targetId) : pages[0];
  if (!target) {
    throw new Error(`No page target with id '${targetId}'. Run command 'list_targets' to see available targets.`);
  }
  if (autoActivate && target.id) {
    httpPutJson(`/json/activate/${target.id}`).catch(() => {});
  }
  return target;
}

interface PendingCdpCall {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

interface CdpConnection {
  ws: any;
  url: string;
  nextId: number;
  pending: Map<number, PendingCdpCall>;
  lastUsed: number;
}

const cdpConnections = new Map<string, CdpConnection>();
const CDP_CONN_IDLE_MS = 60000;
let wsModule: any = null;

async function getWsModule(): Promise<any> {
  if (!wsModule) wsModule = await import("ws");
  return wsModule;
}

function closeCdpConnection(url: string, reason: string): void {
  const conn = cdpConnections.get(url);
  if (!conn) return;
  cdpConnections.delete(url);
  for (const p of conn.pending.values()) {
    clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  conn.pending.clear();
  try {
    conn.ws.close();
  } catch {
    /* ignore */
  }
}

function pruneCdpConnections(liveUrls: string[]): void {
  const live = new Set(liveUrls);
  for (const url of Array.from(cdpConnections.keys())) {
    if (!live.has(url)) {
      closeCdpConnection(url, "CDP target is no longer open in Chrome; connection dropped.");
    }
  }
}

async function getCdpConnection(target: CdpTarget): Promise<CdpConnection> {
  let url = target.webSocketDebuggerUrl;
  if (resolvedHost === "::1" && url.includes("://127.0.0.1:")) {
    url = url.replace("://127.0.0.1:", "://[::1]:");
  } else if (resolvedHost === "127.0.0.1" && url.includes("://[::1]:")) {
    url = url.replace("://[::1]:", "://127.0.0.1:");
  }
  const existing = cdpConnections.get(url);
  if (existing) {
    let open = false;
    try {
      open = existing.ws.readyState === 1;
    } catch {
      open = false;
    }
    if (open && Date.now() - existing.lastUsed <= CDP_CONN_IDLE_MS) {
      existing.lastUsed = Date.now();
      return existing;
    }
    closeCdpConnection(
      url,
      "CDP connection to the target tab was closed or idle too long; it will be re-established on the next command."
    );
  }
  const { WebSocket } = await getWsModule();
  const timeoutMs = cdpTimeoutMs();
  const conn: CdpConnection = { ws: null as any, url, nextId: 1, pending: new Map(), lastUsed: Date.now() };
  const ws = new WebSocket(url, { handshakeTimeout: timeoutMs });
  conn.ws = ws;
  cdpConnections.set(url, conn);
  ws.on("message", (data: any) => {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg && typeof msg.id === "number") {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        p.reject(new Error(`CDP '${p.method}' error: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        p.resolve(msg.result !== undefined ? msg.result : {});
      }
    } else if (msg && msg.id === undefined && typeof msg.method === "string") {
      handleIncomingCdpEvent(target.id, msg.method, msg.params, (m, p) => {
        try {
          ws.send(JSON.stringify({ id: conn.nextId++, method: m, params: p }));
        } catch {}
      });
    }
  });
  const onDead = (why: string) => {
    if (cdpConnections.get(url) === conn) {
      if (conn.pending.size > 0) closeCdpConnection(url, why);
      else cdpConnections.delete(url);
    }
  };
  ws.on("error", (err: any) => onDead(`CDP WebSocket error: ${(err && err.message) || String(err)}`));
  ws.on("close", () => onDead("CDP WebSocket to the target tab closed unexpectedly."));
  const opened = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    ws.once("open", () => { clearTimeout(t); resolve(true); });
    ws.once("error", () => { clearTimeout(t); resolve(false); });
    ws.once("close", () => { clearTimeout(t); resolve(false); });
  });
  if (!opened || cdpConnections.get(url) !== conn) {
    closeCdpConnection(url, `Timed out after ${timeoutMs}ms opening CDP WebSocket to the target tab.`);
    throw new Error(`Timed out after ${timeoutMs}ms opening CDP WebSocket to the target tab.`);
  }
  try {
    ws.send(JSON.stringify({ id: conn.nextId++, method: "Page.enable", params: {} }));
  } catch {}
  conn.lastUsed = Date.now();
  return conn;
}

async function cdpSend(target: CdpTarget, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const conn = await getCdpConnection(target);
  const timeoutMs = cdpTimeoutMs();
  const id = conn.nextId++;
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      conn.pending.delete(id);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP '${method}' response from the target tab.`));
    }, timeoutMs);
    conn.pending.set(id, { resolve, reject, timer, method });
    conn.lastUsed = Date.now();
    try {
      conn.ws.send(JSON.stringify({ id, method, params }));
    } catch (e: any) {
      conn.pending.delete(id);
      clearTimeout(timer);
      const msg = `CDP WebSocket send failed for '${method}': ${(e && e.message) || String(e)}`;
      closeCdpConnection(conn.url, msg);
      reject(new Error(msg));
    }
  });
}

export const _cdpTestHooks = {
  connectionCount: (): number => cdpConnections.size,
  closeAll: (): void => {
    for (const url of Array.from(cdpConnections.keys())) {
      closeCdpConnection(url, "CDP test teardown: connection closed.");
    }
  },
  clearSnapshots: (): void => {
    snapshotStore.clear();
    snapshotPrevStore.clear();
    clearCdpDialogs();
  },
  resetResolvedHost: (): void => {
    resolvedHost = null;
  },
};

/**
 * Drive the real Chrome via remote debugging - no extension needed.
 */
export const controlChromeCdpTool: Tool = {
  name: "control_chrome_cdp",
  description:
    "Control the user's REAL Chrome browser directly via Chrome Remote Debugging (CDP) at http://127.0.0.1:9222 — no extension required and no isolated background tab. " +
    "REQUIRES Chrome to be running with --remote-debugging-port=9222 (close ALL Chrome windows, then reopen Chrome from the taskbar shortcut). " +
    "Commands: list_targets, new_tab, close_tab, activate, navigate, evaluate, snapshot, read_page, extract_links, click, type, wait_for, verify_action, get_dialogs, handle_dialog, screenshot, pdf, get_cookies, inspect_media_devices, move_cursor, drag_and_drop, emulate_device. " +
    "Supports device/viewport emulation (mobile, tablet, desktop, reset), human-like Bézier cursor movement, realistic drag-and-drop, visual pointer overlay, native dialog interception, and UI transition verification. " +
    "Arguments like url, index, text, selector, source, target, dx, dy, preset, device, orientation, screenshot, outputPath can be provided directly at top-level or inside payload.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: [
          "list_targets", "new_tab", "close_tab", "activate", "navigate", "evaluate",
          "snapshot", "read_page", "extract_links", "click", "type", "wait_for",
          "verify_action", "get_dialogs", "handle_dialog", "screenshot", "pdf",
          "get_cookies", "inspect_media_devices", "media_devices", "move_cursor",
          "move_mouse", "show_cursor", "hide_cursor", "get_cursor",
          "drag_and_drop", "drag", "drag_drop",
          "emulate_device", "set_device", "set_viewport", "emulate_viewport",
        ],
        description: "CDP command to execute on the real Chrome browser.",
      },
      payload: {
        type: "string",
        description:
          'JSON string or object payload. new_tab: {"url": "https://..."}. navigate: {"url": "https://...", "screenshot": true}. evaluate: {"expression": "document.title"}. snapshot: {} (numbered interactive-element list). read_page: {} (extract visible text/headings/alerts/emails). extract_links: {"pattern": "verify"}. click: {"index": 3, "observe": true, "smooth": true} or {"selector": "#login"}. drag_and_drop: {"source": "#card", "target": "#column"} or {"sourceIndex": 2, "targetIndex": 5, "mode": "mouse"|"html5", "screenshot": true}. verify_action: {"index": 3}. get_dialogs: {"clear": false}. handle_dialog: {"accept": true, "promptText": "..."}. inspect_media_devices: {"grantPermissions": true}. move_cursor: {"x": 400, "y": 300, "visualCursor": true}. type: {"index": 2, "text": "hello"}. screenshot: {"fullPage": true, "outputPath": "shot.png"}.',
      },
      url: { type: "string", description: "Optional top-level URL convenience shortcut for new_tab or navigate." },
      index: { type: "number", description: "Optional top-level element index convenience shortcut for click or type." },
      text: { type: "string", description: "Optional top-level text convenience shortcut for type or wait_for." },
      selector: { type: "string", description: "Optional top-level CSS selector convenience shortcut for click, type, or wait_for." },
      pattern: { type: "string", description: "Optional top-level keyword filter pattern for extract_links." },
      source: { type: "string", description: "Optional source selector or index for drag_and_drop." },
      target: { type: "string", description: "Optional target selector or index for drag_and_drop." },
      mode: { type: "string", enum: ["mouse", "html5", "both"], description: "Optional drag_and_drop mode ('mouse' [default], 'html5', or 'both')." },
      native: { type: "boolean", description: "Optional top-level flag to dispatch native CDP Input keystrokes." },
      screenshot: { type: "boolean", description: "Optional top-level flag to capture a visual screenshot alongside the action." },
      outputPath: { type: "string", description: "Optional custom file path to save the screenshot image PNG." },
      fullPage: { type: "boolean", description: "Optional flag to capture full scrollable page beyond current viewport." },
      format: { type: "string", enum: ["png", "jpeg", "webp"], description: "Optional image format for screenshot (default 'png')." },
      quality: { type: "number", description: "Optional compression quality for jpeg/webp screenshot (0-100)." },
      grantPermissions: { type: "boolean", description: "Optional flag to grant microphone, camera, and speakerSelection permissions via CDP." },
      resetPermissions: { type: "boolean", description: "Optional flag to reset permissions via CDP." },
      smooth: { type: "boolean", description: "Optional flag to glide cursor along a human-like Bezier curve before clicking." },
      x: { type: "number", description: "Optional x coordinate for cursor movement or positioning." },
      y: { type: "number", description: "Optional y coordinate for cursor movement or positioning." },
      steps: { type: "number", description: "Optional step count for cursor trajectory interpolation." },
      visualCursor: { type: "boolean", description: "Optional flag to display an animated virtual pointer overlay in the DOM." },
      targetId: { type: "string", description: "Optional CDP target id. Automatically defaults to the active tab." },
    },
    required: ["command"],
  },
  execute: async (args: Record<string, unknown>) => {
    const command = String(args.command || "");
    let payload: Record<string, unknown> = {};
    if (args.payload !== undefined && args.payload !== "") {
      if (typeof args.payload === "object" && args.payload !== null) {
        payload = { ...(args.payload as Record<string, unknown>) };
      } else {
        try {
          payload = JSON.parse(String(args.payload));
        } catch {
          return "control_chrome_cdp failed: 'payload' must be a valid JSON string.";
        }
      }
    }
    const convenienceKeys = [
      "url", "index", "text", "selector", "pattern", "query", "filter", "expression",
      "compact", "diff", "max_elements", "timeout_ms", "clear", "native", "wait_for_elements",
      "auto_snapshot", "screenshot", "auto_screenshot", "outputPath", "output_path",
      "fullPage", "full_page", "format", "quality", "verify", "observe", "debounce_ms",
      "accept", "promptText", "prompt_text", "grantPermissions", "grant_permissions",
      "resetPermissions", "reset_permissions", "smooth", "human", "realistic",
      "x", "y", "steps", "step_delay_ms", "visualCursor", "visual",
      "source", "target", "sourceIndex", "targetIndex", "source_index", "target_index",
      "sourceSelector", "targetSelector", "source_selector", "target_selector",
      "sourceX", "sourceY", "fromX", "fromY", "startX", "startY",
      "targetX", "targetY", "toX", "toY", "endX", "endY", "dx", "dy", "deltaX", "deltaY",
      "mode", "holdDurationMs", "hold_duration_ms", "dropDwellMs", "drop_dwell_ms",
      "preset", "device", "mode", "orientation", "screenOrientation", "width", "height",
      "scale", "deviceScaleFactor", "mobile", "touch", "userAgent", "platform", "list_presets",
    ];
    for (const key of convenienceKeys) {
      if (args[key] !== undefined && payload[key] === undefined) payload[key] = args[key];
    }
    const targetId = args.targetId
      ? String(args.targetId)
      : payload.targetId
        ? String(payload.targetId)
        : undefined;

    try {
      switch (command) {
        case "list_targets": {
          const pages = await listPageTargets();
          if (pages.length === 0) return "control_chrome_cdp: connected, but no page targets are open in Chrome.";
          return pages.map((t) => `- id: ${t.id}\n  title: ${t.title}\n  url: ${t.url}`).join("\n");
        }
        case "new_tab": {
          const url = String(payload.url || "about:blank");
          const path = `/json/new?${encodeURIComponent(url)}`;
          const res: any = await httpPutJson(path);
          const newId = res && res.id ? res.id : undefined;
          if (newId) httpPutJson(`/json/activate/${newId}`).catch(() => {});
          return `control_chrome_cdp: opened new tab '${url}'${newId ? ` (targetId: ${newId})` : ""}`;
        }
        case "close_tab": {
          const target = await pickTarget(targetId, false);
          await httpPutJson(`/json/close/${target.id}`);
          closeCdpConnection(target.webSocketDebuggerUrl, "Tab closed via close_tab command.");
          return `control_chrome_cdp: closed tab '${truncate(target.title, 80)}' (id: ${target.id})`;
        }
        case "activate": {
          const target = await pickTarget(targetId, false);
          await httpPutJson(`/json/activate/${target.id}`);
          return `control_chrome_cdp: activated tab '${truncate(target.title, 80)}' (id: ${target.id})`;
        }
        case "navigate": {
          const url = String(payload.url || "");
          if (!url) return 'control_chrome_cdp failed: command \'navigate\' needs payload {"url": "https://..."}.';
          const target = await pickTarget(targetId);
          await cdpSend(target, "Page.navigate", { url });

          const readyDeadline = Date.now() + 3000;
          while (Date.now() < readyDeadline) {
            try {
              const r = await cdpSend(target, "Runtime.evaluate", { expression: READY_STATE_JS, returnByValue: true });
              const state = r && r.result ? r.result.value : undefined;
              if (state === "complete" || state === "interactive" || (state && state !== "loading")) break;
            } catch {
              break;
            }
            await new Promise((res) => setTimeout(res, 100));
          }

          const skipSnapshot = payload.auto_snapshot === false || payload.autoSnapshot === false || payload.snapshot === false;
          let snapSuffix = "";
          if (!skipSnapshot) {
            try {
              const sRes: any = await cdpSend(target, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
              const sVal = sRes && sRes.result ? sRes.result.value : undefined;
              let fresh: SnapshotEntry[] = [];
              let pageOverview: PageOverview | null = null;
              if (Array.isArray(sVal)) {
                fresh = sVal;
              } else if (sVal && typeof sVal === "object" && Array.isArray((sVal as any).elements)) {
                fresh = (sVal as any).elements;
                pageOverview = sVal as any;
              }
              snapshotPrevStore.set(target.id, snapshotStore.get(target.id) ?? []);
              snapshotStore.set(target.id, fresh);
              const maxElements = 35;
              const entries = fresh.slice(0, maxElements);
              const contextHeader = formatContextHeader(pageOverview);
              if (entries.length > 0) {
                snapSuffix =
                  `\n\nInteractive elements (${entries.length}${fresh.length > maxElements ? ` of ${fresh.length}` : ""}):` +
                  (contextHeader ? `${contextHeader}\n` : "\n") +
                  entries.map((e) => formatSnapshotEntry(e, true)).join("\n") +
                  `\nUse click/type with {"index": N}.`;
              }
            } catch {
              /* keep navigate response clean even if auto-snapshot errors */
            }
          }
          const baseNavResult = `control_chrome_cdp: navigated tab '${truncate(target.title, 80)}' to ${url}${snapSuffix}`;
          return await attachScreenshotIfRequested(cdpSend, target, payload, baseNavResult, true);
        }
        case "evaluate": {
          const expression = String(payload.expression || "");
          if (!expression) return 'control_chrome_cdp failed: command \'evaluate\' needs payload {"expression": "..."}.';
          const target = await pickTarget(targetId);
          const evalStartTs = Date.now() - 2;
          const res: any = await cdpSend(target, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          const value = res && res.result ? res.result.value : undefined;
          const out = typeof value === "string" ? value : JSON.stringify(value);
          const recentDialogs = getRecentDialogs(target.id, evalStartTs);
          const dialogSuffix =
            recentDialogs.length > 0
              ? `\nIntercepted Native Dialog(s): ${recentDialogs.map(formatDialogEntry).join(" | ")}`
              : "";
          const baseResult = `control_chrome_cdp: evaluate result: ${truncate(out, 4000)}${dialogSuffix}`;
          return await attachScreenshotIfRequested(cdpSend, target, payload, baseResult, false);
        }
        case "snapshot": {
          const target = await pickTarget(targetId);
          const compact = payload.compact !== undefined ? Boolean(payload.compact) : true;
          const diff = Boolean(payload.diff);
          let maxElements: number = 100;
          if (payload.max_elements !== undefined && payload.max_elements !== null && payload.max_elements !== "") {
            maxElements = Math.floor(Number(payload.max_elements));
            if (!Number.isFinite(maxElements) || maxElements < 1) {
              return `control_chrome_cdp failed: 'max_elements' must be a positive integer.`;
            }
          }

          let res: any = await cdpSend(target, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
          let value = res && res.result ? res.result.value : undefined;
          let fresh: SnapshotEntry[] = [];
          let pageOverview: PageOverview | null = null;
          if (Array.isArray(value)) {
            fresh = value;
          } else if (value && typeof value === "object" && Array.isArray((value as any).elements)) {
            fresh = (value as any).elements;
            pageOverview = value as any;
          }

          if (fresh.length === 0 && payload.wait_for_elements) {
            const waitMs = parseTimeoutMs(payload.wait_for_elements, 2000);
            const deadline = Date.now() + waitMs;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 200));
              try {
                res = await cdpSend(target, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
                value = res && res.result ? res.result.value : undefined;
                if (Array.isArray(value)) {
                  fresh = value;
                } else if (value && typeof value === "object" && Array.isArray((value as any).elements)) {
                  fresh = (value as any).elements;
                  pageOverview = value as any;
                }
                if (fresh.length > 0) break;
              } catch {
                break;
              }
            }
          }

          const prev: SnapshotEntry[] = snapshotStore.get(target.id) ?? [];
          snapshotPrevStore.set(target.id, prev);
          snapshotStore.set(target.id, fresh);
          const entries = fresh.slice(0, maxElements);
          const title = `'${truncate(target.title, 60)}'`;

          if (diff) {
            const diffResult = formatSnapshotDiff(title, entries, prev, compact);
            return await attachScreenshotIfRequested(cdpSend, target, payload, diffResult, false);
          }
          if (entries.length === 0) {
            const emptyResult = "control_chrome_cdp: snapshot found no interactive elements on this page.";
            return await attachScreenshotIfRequested(cdpSend, target, payload, emptyResult, false);
          }
          const isLimited = (payload.max_elements !== undefined && payload.max_elements !== "") || fresh.length > maxElements;
          const contextHeader = formatContextHeader(pageOverview);
          const snapshotResult =
            `control_chrome_cdp: snapshot of ${title} - ${entries.length} interactive element(s)` +
            (compact ? " (compact)" : "") +
            (isLimited ? ` (limited to ${maxElements})` : "") +
            `.\n` +
            (contextHeader ? `${contextHeader}\n` : "") +
            `Use click/type with {"index": N}.\n${entries.map((e) => formatSnapshotEntry(e, compact)).join("\n")}`;
          return await attachScreenshotIfRequested(cdpSend, target, payload, snapshotResult, false);
        }
        case "read_page": {
          const target = await pickTarget(targetId);
          const res: any = await cdpSend(target, "Runtime.evaluate", {
            expression: READ_PAGE_JS,
            returnByValue: true,
          });
          const data = res && res.result ? res.result.value : undefined;
          if (!data || typeof data !== "object") {
            return `control_chrome_cdp: could not read page content from tab '${truncate(target.title, 80)}'.`;
          }
          const title = String(data.title || target.title);
          const url = String(data.url || target.url);
          const headings: Array<{ tag: string; text: string }> = Array.isArray(data.headings) ? data.headings : [];
          const domAlerts: string[] = Array.isArray(data.alerts) ? data.alerts : [];
          const nativeDialogs = getRecentDialogs(target.id).map(formatDialogEntry);
          const alerts = [...nativeDialogs, ...domAlerts];
          const bodyText: string = String(data.bodyText || "").trim();
          const links: Array<{ text: string; href: string }> = Array.isArray(data.links) ? data.links : [];

          const sections: string[] = [];
          sections.push(`control_chrome_cdp: page content for '${title}' (${url}):`);
          if (data.viewMode) sections.push(`View Mode: [${String(data.viewMode).toUpperCase()}]`);
          if (headings.length > 0) sections.push(`Headings:\n` + headings.map((h) => `- [${h.tag.toUpperCase()}] ${h.text}`).join("\n"));
          if (alerts.length > 0) sections.push(`Alerts / Status:\n` + alerts.map((a) => `- ${a}`).join("\n"));
          sections.push(bodyText ? `Visible Content:\n${truncate(bodyText, 5000)}` : `Visible Content: (no visible text)`);
          if (links.length > 0) {
            sections.push(`Key Links (${links.length}):\n` + links.slice(0, 20).map((l) => `- "${l.text || '(no text)'}" -> ${l.href}`).join("\n"));
          }
          return sections.join("\n\n");
        }
        case "extract_links": {
          const target = await pickTarget(targetId);
          const pattern = String(payload.pattern || payload.query || payload.filter || "");
          const res: any = await cdpSend(target, "Runtime.evaluate", {
            expression: buildExtractLinksJs(pattern),
            returnByValue: true,
          });
          const links: Array<{ text: string; href: string }> = res && res.result && Array.isArray(res.result.value) ? res.result.value : [];
          const title = truncate(target.title, 60);
          if (links.length === 0) {
            return `control_chrome_cdp: found 0 links on '${title}'${pattern ? ` matching '${pattern}'` : ""}.`;
          }
          const formatted = links.map((l) => `- "${l.text || '(no text)'}" -> ${l.href}`).join("\n");
          return `control_chrome_cdp: extracted ${links.length} link(s) on '${title}'${pattern ? ` matching '${pattern}'` : ""}:\n${formatted}`;
        }
        case "click": {
          const target = await pickTarget(targetId);
          const resolved = resolveActionSelector(payload, target.id);
          if ("error" in resolved) return resolved.error;
          const clickWaitMs = parseTimeoutMs(payload.timeout_ms, 10000);
          if (clickWaitMs > 0) {
            const w = await waitForInPage(cdpSend, target, { selector: resolved.selector, timeoutMs: clickWaitMs });
            if (!w.ok) {
              return (
                `control_chrome_cdp: click timed out after ${clickWaitMs}ms waiting for '${resolved.selector}' to appear and become visible. ` +
                `Run 'snapshot' to refresh the element list, or 'wait_for' with a longer timeout.`
              );
            }
          }
          let beforeState: DomStateSnapshot | undefined;
          if (payload.verify || payload.observe) {
            beforeState = await captureDomState(cdpSend, target);
          }
          let smoothInfo = "";
          if (payload.smooth || payload.human || payload.realistic) {
            const centerPt = await resolveElementCenterPoint(cdpSend, target, resolved.selector);
            if (centerPt) {
              const visual = Boolean(payload.visualCursor ?? payload.visual);
              const clickHuman = await dispatchHumanMouseClick(cdpSend, target, centerPt, { visualCursor: visual });
              smoothInfo = ` [human-like cursor at (${clickHuman.x}, ${clickHuman.y}) across ${clickHuman.steps} steps]`;
            }
          }
          const clickStartTs = Date.now() - 2;
          const res: any = await cdpSend(target, "Runtime.evaluate", {
            expression: buildClickJs(resolved.selector),
            returnByValue: true,
          });
          const value = res && res.result ? res.result.value : undefined;
          const parsed = parseActionResult(typeof value === "string" ? value : JSON.stringify(value));
          if (!parsed.ok) return `control_chrome_cdp: click failed - ${parsed.reason || "unknown reason"}.`;
          const textStr = parsed.text ? ` "${parsed.text}"` : "";
          let clickResult = `control_chrome_cdp: clicked <${parsed.tag}>${textStr}${smoothInfo}.`;
          const recentDialogs = getRecentDialogs(target.id, clickStartTs);
          if (recentDialogs.length > 0) {
            clickResult += `\nIntercepted Native Dialog(s): ${recentDialogs.map(formatDialogEntry).join(" | ")}`;
          }
          if (beforeState) {
            const debounceMs = parseTimeoutMs(payload.debounce_ms, 200);
            const diff = await observeActionTransition(cdpSend, target, beforeState, debounceMs, clickStartTs);
            clickResult += `\n${formatTransitionSummary(diff)}`;
          }
          return await attachScreenshotIfRequested(cdpSend, target, payload, clickResult, false);
        }
        case "type": {
          const text = String(payload.text ?? "");
          if (!text) {
            return 'control_chrome_cdp failed: command \'type\' needs payload {"text": "..."} plus {"index": N} (from \'snapshot\') or {"selector": "<css>"}.';
          }
          const clear = payload.clear === undefined ? true : Boolean(payload.clear);
          const target = await pickTarget(targetId);
          const resolved = resolveActionSelector(payload, target.id);
          if ("error" in resolved) return resolved.error;
          const typeWaitMs = parseTimeoutMs(payload.timeout_ms, 10000);
          if (typeWaitMs > 0) {
            const w = await waitForInPage(cdpSend, target, { selector: resolved.selector, timeoutMs: typeWaitMs });
            if (!w.ok) {
              return (
                `control_chrome_cdp: type timed out after ${typeWaitMs}ms waiting for '${resolved.selector}' to appear and become visible. ` +
                `Run 'snapshot' to refresh the element list, or 'wait_for' with a longer timeout.`
              );
            }
          }
          const res: any = await cdpSend(target, "Runtime.evaluate", {
            expression: buildTypeJs(resolved.selector, text, clear),
            returnByValue: true,
          });
          const value = res && res.result ? res.result.value : undefined;
          const parsed = parseActionResult(typeof value === "string" ? value : JSON.stringify(value));
          if (!parsed.ok) return `control_chrome_cdp: type failed - ${parsed.reason || "unknown reason"}.`;
          if (payload.native || payload.dispatch_keys) {
            try { await cdpSend(target, "Input.insertText", { text }); } catch {}
          }
          const typeResult = `control_chrome_cdp: typed into <${parsed.tag}>: "${truncate(parsed.typed || text, 80)}".`;
          return await attachScreenshotIfRequested(cdpSend, target, payload, typeResult, false);
        }
        case "wait_for": {
          const selector = String(payload.selector || "");
          const text = String(payload.text || "");
          if (!selector && !text) {
            return `control_chrome_cdp failed: command 'wait_for' needs payload {"selector": "<css>"} or {"text": "<teks>"} (optionally "timeout_ms").`;
          }
          const waitMs = parseTimeoutMs(payload.timeout_ms, 15000);
          const target = await pickTarget(targetId);
          const w = await waitForInPage(cdpSend, target, {
            selector: selector || undefined,
            text: text || undefined,
            timeoutMs: waitMs,
          });
          if (!w.ok) return `control_chrome_cdp: wait_for ${w.reason || "timed out"}.`;
          const what =
            w.kind === "text"
              ? `text "${w.text}"`
              : `selector '${selector}'` + (w.tag ? ` (<${w.tag}>${w.foundText ? ` "${w.foundText}"` : ""})` : "");
          const waitResult = `control_chrome_cdp: wait_for matched ${what}.`;
          return await attachScreenshotIfRequested(cdpSend, target, payload, waitResult, false);
        }
        case "verify_action": {
          const target = await pickTarget(targetId);
          return await executeVerifyAction(cdpSend, target, payload, attachScreenshotIfRequested);
        }
        case "get_dialogs": {
          const target = await pickTarget(targetId, false);
          return executeGetDialogsCommand(target, payload);
        }
        case "handle_dialog": {
          const target = await pickTarget(targetId, false);
          return await executeHandleDialogCommand(cdpSend, target, payload);
        }
        case "screenshot": {
          const target = await pickTarget(targetId);
          const outPath = payload.outputPath || payload.output_path;
          const format = payload.format as any;
          const quality = payload.quality !== undefined ? Number(payload.quality) : undefined;
          const fullPage = Boolean(payload.full_page || payload.fullPage);
          const shot = await captureCdpScreenshot(cdpSend, target, {
            outputPath: outPath ? String(outPath) : undefined,
            format,
            quality,
            fullPage,
          });
          return formatScreenshotResult(shot);
        }
        case "pdf": {
          const target = await pickTarget(targetId);
          const res: any = await cdpSend(target, "Page.printToPDF", {});
          const data = String((res && res.data) || "");
          if (!data) return "control_chrome_cdp: printToPDF returned no data.";
          return `control_chrome_cdp: PDF captured (${data.length} base64 chars):\n${data}`;
        }
        case "get_cookies": {
          const target = await pickTarget(targetId);
          const res: any = await cdpSend(target, "Storage.getCookies", {});
          const cookies = res && Array.isArray(res.cookies) ? res.cookies : [];
          const summary = cookies.map((c: any) => ({
            name: c.name,
            value: String(c.value).slice(0, 48),
            domain: c.domain,
          }));
          return `control_chrome_cdp: ${cookies.length} cookie(s):\n${JSON.stringify(summary, null, 1)}`;
        }
        case "inspect_media_devices":
        case "media_devices": {
          const target = await pickTarget(targetId);
          const grant = Boolean(payload.grantPermissions ?? payload.grant_permissions);
          const reset = Boolean(payload.resetPermissions ?? payload.reset_permissions);
          return await executeInspectMediaDevices(cdpSend, target, {
            grantPermissions: grant,
            resetPermissions: reset,
          });
        }
        case "move_cursor":
        case "move_mouse":
        case "show_cursor":
        case "hide_cursor":
        case "get_cursor": {
          const target = await pickTarget(targetId);
          return await executeCursorCommand(cdpSend, target, command, payload);
        }
        case "drag_and_drop":
        case "drag":
        case "drag_drop": {
          const target = await pickTarget(targetId);
          const dragResult = await executeDragAndDropCommand(cdpSend, target, payload);
          return await attachScreenshotIfRequested(cdpSend, target, payload, dragResult, false);
        }
        case "emulate_device":
        case "set_device":
        case "set_viewport":
        case "emulate_viewport": {
          const target = await pickTarget(targetId);
          const emuResult = await executeDeviceEmulationCommand(cdpSend, target, payload);
          return await attachScreenshotIfRequested(cdpSend, target, payload, emuResult, false);
        }
        default:
          return `control_chrome_cdp failed: unknown command '${command}'. Valid commands: list_targets, new_tab, close_tab, activate, navigate, evaluate, snapshot, read_page, extract_links, click, type, wait_for, verify_action, get_dialogs, handle_dialog, screenshot, pdf, get_cookies, inspect_media_devices, move_cursor, get_cursor, show_cursor, hide_cursor, drag_and_drop, emulate_device.`;
      }
    } catch (err: any) {
      return `control_chrome_cdp failed: ${(err && err.message) || String(err)}`;
    }
  },
};
