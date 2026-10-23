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
  CdpTarget, SnapshotEntry, PageOverview, snapshotStore, snapshotPrevStore,
  SNAPSHOT_JS, READ_PAGE_JS, buildExtractLinksJs, READY_STATE_JS,
  buildClickJs, buildTypeJs, buildWaitForJs, parseActionResult, parseTimeoutMs,
  formatSnapshotEntry, formatSnapshotDiff, formatContextHeader, resolveActionSelector,
  waitForInPage, handleIncomingCdpEvent, getRecentDialogs, clearCdpDialogs,
  formatDialogEntry, executeGetDialogsCommand, executeHandleDialogCommand,
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
import { executeInspectMediaDevices, executeMockDisplayMedia, executeHandleScreenSharePrompt } from "./chromeCdpMedia.js";
import { executeCursorCommand, dispatchHumanMouseClick, resolveElementCenterPoint, executeDragAndDropCommand } from "./chromeCdpCursor.js";
import { executeDeviceEmulationCommand } from "./chromeCdpEmulation.js";
import { executeSelectOptionCommand, executeCheckFormCommand } from "./chromeCdpForm.js";
import { CDP_AUDIT_COMMANDS, executeCdpAuditCommand, type CdpAuditCommand } from "./chromeCdpAudits.js";
import { CDP_DIAGNOSTIC_COMMANDS, executeCdpDiagnosticsCommand, recordCdpDebugEvent, type CdpDiagnosticCommand } from "./chromeCdpDiagnostics.js";
import { saveCdpPdfArtifact } from "./chromeCdpArtifacts.js";

import { executeCdpTerminalCommand } from "./chromeCdpTerminalCommands.js";
import { discoverDesktopTargets } from "./chromeCdpDesktop.js";

import { AsyncLocalStorage } from "node:async_hooks";
import { claimCdpTarget, listCdpSessions, releaseCdpTarget, withCdpTargetWrite, withCdpTargetRead, cdpCoordinatorStatus, rebindCdpTarget,
  setCdpSharing, inviteCdpAgent, joinCdpTarget, leaveCdpTarget, revokeCdpAgent, handoverCdpTarget, getCdpParticipation,
  type CdpParticipantRole, heartbeatCdpSession, getCdpExecutionState } from "./chromeCdpSessionManager.js";
import { classifyCdpCommand } from "./chromeCdpCommandPolicy.js";

/**
 * Test hooks — read lazily so unit tests can point the tool at a mock CDP
 * server by setting env vars before each call.
 */
let resolvedHost: string | null = null;
const terminalCdpConfig = new AsyncLocalStorage<{ port: number }>();
const cdpAgentContext = new AsyncLocalStorage<{ agentId?: string; sessionToken?: string }>();
const snapshotKey = (targetId: string) =>
  `${cdpPort()}:${cdpAgentContext.getStore()?.agentId || "legacy"}:${targetId}:${getCdpExecutionState()?.revision ?? 0}`;


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
  return terminalCdpConfig.getStore()?.port || Number(process.env.SUPERAGENT_CDP_PORT) || 9222;
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
        if (!isRetry && !terminalCdpConfig.getStore()) {
          const started = await ensureCdpRunning(cdpHost(), cdpPort());
          if (started) {
            try {
              const retryRes = await httpGetJson(path, true);
              resolve(retryRes);
              return;
            } catch {}
          }
        }
        reject(new Error(terminalCdpConfig.getStore()
          ? "Configured local Electron/Chromium CDP port " + cdpPort() + " is not available; enable the app's remote debugging endpoint and retry. No process was started."
          : CDP_PORT_CLOSED_MSG));
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
        if (!isRetry && !terminalCdpConfig.getStore()) {
          const started = await ensureCdpRunning(cdpHost(), cdpPort());
          if (started) {
            try {
              const retryRes = await httpPutJson(path, true);
              resolve(retryRes);
              return;
            } catch {}
          }
        }
        reject(new Error(terminalCdpConfig.getStore()
          ? "Configured local Electron/Chromium CDP port " + cdpPort() + " is not available; enable the app's remote debugging endpoint and retry. No process was started."
          : CDP_PORT_CLOSED_MSG));
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

/** Public browser locator for the cross-IDE CDP coordinator.
 * Never accepts a caller-provided remote host. The CDP host is local only. */
export async function discoverCdpPages(port: number): Promise<Array<{ targetId: string; title: string; url: string }>> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid CDP port.");
  return terminalCdpConfig.run({ port }, async () => (await listPageTargets()).slice(0, 100)
    .map(t => ({ targetId: t.id, title: t.title.slice(0, 160), url: t.url.slice(0, 2048) })));
}
async function listPageTargets(): Promise<CdpTarget[]> {
  const targets: any = await httpGetJson("/json/list");
  if (!Array.isArray(targets)) {
    throw new Error("Unexpected response from CDP /json/list (not an array).");
  }
  return targets.filter((t: any) => t && (t.type === "page" || t.type === "webview") && t.webSocketDebuggerUrl);
}

async function pickTarget(targetId?: string, autoActivate = false, requireExplicitWhenMultiple = false): Promise<CdpTarget> {
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
  if ((requireExplicitWhenMultiple || !!cdpAgentContext.getStore()?.agentId) && !targetId && pages.length > 1) {
    throw new Error("Multiple Chrome/Electron CDP targets found. Specify targetId from list_targets before sending terminal input.");
  }
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
    // Connections on a different Electron CDP port belong to another target scope.
    try { if (Number(new URL(url).port) !== cdpPort()) continue; } catch { continue; }
    if (!live.has(url)) {
      closeCdpConnection(url, "CDP target is no longer open in Chrome; connection dropped.");
    }
  }
}

const cdpConnectionOpenings = new Map<string, Promise<CdpConnection>>();
async function getCdpConnection(target: CdpTarget): Promise<CdpConnection> {
  const key = target.webSocketDebuggerUrl + "|" + cdpHost();
  const pending = cdpConnectionOpenings.get(key);
  if (pending) return pending;
  const opening = openCdpConnection(target);
  cdpConnectionOpenings.set(key, opening);
  try { return await opening; }
  finally {
    if (cdpConnectionOpenings.get(key) === opening) cdpConnectionOpenings.delete(key);
  }
}
async function openCdpConnection(target: CdpTarget): Promise<CdpConnection> {
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
      recordCdpDebugEvent(target.id, msg.method, msg.params);
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
    "Control the user's real Chrome via CDP port 9222 (--remote-debugging-port=9222); no extension required. Supports tabs/navigation, DOM snapshot/extraction, read_terminal for xterm.js/hterm, click/type/forms, dialogs, screenshots/PDF, cookies, media, cursor/drag-and-drop, device emulation, and UI transition verification. " +
    "Audits: page_audit, accessibility_audit, seo_audit, responsive_audit, performance_metrics. Diagnostics: start_debug_capture/read_debug_capture/stop_debug_capture/clear_debug_capture for bounded console, exception, and network metadata. " +
    "Use evaluate only for trusted, intentional page JavaScript. Cookie values and large artifacts are summarized by default. Arguments can be passed at top level or inside payload.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: [
          "list_targets", "claim_target", "release_target", "recover_session", "recover_target", "list_sessions", "coordinator_status",
          "heartbeat_session", "share_target", "stop_sharing", "invite_agent", "join_target", "leave_target", "revoke_agent", "handover_target", "session_participants", "shared_snapshot", "new_tab", "close_tab", "activate", "navigate", "evaluate", "snapshot", "read_page", "read_terminal", "read_terminal_delta", "write_terminal", "send_terminal_key", "list_terminal_sessions", "clear_terminal_sessions", "monitor_terminal_agents", "watch_terminal", "execute_terminal", "recover_terminal", "discover_desktop_targets", "extract_links", "click", "type", "wait_for",
          "select_option", "check_form", "verify_action", "get_dialogs", "handle_dialog", "screenshot", "pdf",
          "get_cookies", "inspect_media_devices", "mock_display_media", "handle_screen_share", "move_cursor", "show_cursor", "hide_cursor", "get_cursor",
          "drag_and_drop", "drag", "emulate_device", ...CDP_AUDIT_COMMANDS, ...CDP_DIAGNOSTIC_COMMANDS,
        ],
        description: "CDP command to execute on the real Chrome browser.",
      },
      payload: {
        type: "string",
        description:
          'JSON string or object payload. new_tab: {"url": "https://..."}. navigate: {"url": "https://...", "screenshot": true}. evaluate: {"expression": "document.title"}. snapshot: {} (numbered interactive-element list). read_page: {} (extract visible text/headings/alerts/emails). extract_links: {"pattern": "verify"}. click: {"index": 3, "observe": true, "smooth": true} or {"selector": "#login"}. select_option: {"index": 5, "option": "Paket Basic"} or {"selector": "[role=combobox]", "option": "Yes"}. check_form: {"selector": "form"} (pre-flight check for missing required fields & submit readiness). drag_and_drop: {"source": "#card", "target": "#column", "mode": "mouse"|"html5", "screenshot": true}. emulate_device: {"preset": "mobile"|"tablet"|"desktop"|"reset", "orientation": "portrait"|"landscape", "screenshot": true}. verify_action: {"index": 3}. get_dialogs: {"clear": false}. handle_dialog: {"accept": true, "promptText": "..."}. inspect_media_devices: {"grantPermissions": true}. move_cursor: {"x": 400, "y": 300, "visualCursor": true}. type: {"index": 2, "text": "hello"}. screenshot: {"fullPage": true, "outputPath": "shot.png"}.',
      },
      url: { type: "string", description: "Optional top-level URL convenience shortcut for new_tab or navigate." },
      index: { type: "number", description: "Optional top-level element index for click/type or terminal index for read/write_terminal." },
      text: { type: "string", description: "Optional top-level text convenience shortcut for type or wait_for." },
      selector: { type: "string", description: "Optional top-level CSS selector convenience shortcut for click, type, wait_for, select_option, check_form, or read_terminal." },
      max_lines: { type: "number", description: "read_terminal maximum lines per page (default 80, max 200)." },
      before_line: { type: "number", description: "read_terminal: exclusive zero-based end line; pass the previous startLine to fetch older scrollback." },
      enter: { type: "boolean", description: "write_terminal: explicitly send Enter after typing (default false)." },
      terminal_id: { type: "string", description: "Opaque terminal ID returned by read_terminal, remains stable across pane reordering until reload." },
      allow_dangerous: { type: "boolean", description: "Explicit acknowledgment for high-risk terminal shell commands." },
      multiline_mode: { type: "string", enum: ["reject", "bracketed", "base64", "raw"], description: "Terminal multiline input mode; base64 requires verify_shell:posix." },
      allow_visual_fallback: { type: "boolean", description: "Explicitly allow cropped screenshot for canvas-only terminal; no output verification." },
      auto_crop_screenshot: { type: "boolean", description: "Alias for allow_visual_fallback." },
      expected_output: { type: "string", description: "execute_terminal/watch_terminal: literal text to look for in fresh terminal output." },
      wait_ms: { type: "number", description: "watch_terminal/execute_terminal: bounded wait, max 15000ms." },
      verify_shell: { type: "string", enum: ["posix", "powershell"], description: "execute_terminal: opt-in shell-specific exit-code marker. Without it exit status remains unknown." },
      force_new_command: { type: "boolean", description: "Explicitly override a still-pending verified shell command on the same pane." },
      rebind_on_reload: { type: "boolean", description: "recover_terminal: reconnect to one uniquely detected terminal if the old terminal_id is stale after reload." },
      debug_port: { type: "number", description: "Local Chromium/Electron CDP port, e.g. 9222 or TLine's explicitly enabled port." },
      debug_ports: { type: "string", description: "discover_desktop_targets: comma-separated local debugging ports." },
      key: { type: "string", description: "send_terminal_key: Enter, Tab, Escape, Backspace, Delete, arrows, Home/End, PageUp/PageDown, Insert, Ctrl+A/C/D/E/K/L/R/U/W/Z, F1-F12." },
      viewport_only: { type: "boolean", description: "read_terminal: read only visible viewport from exposed xterm buffer." },
      option: { type: "string", description: "Optional option label, text, or value to select for select_option." },
      exact: { type: "boolean", description: "Optional exact match flag for select_option." },
      pattern: { type: "string", description: "Optional top-level keyword filter pattern for extract_links." },
      source: { type: "string", description: "Optional source selector or index for drag_and_drop." },
      target: { type: "string", description: "Optional target selector or index for drag_and_drop." },
      mode: { type: "string", enum: ["mouse", "html5", "both"], description: "Optional drag_and_drop mode ('mouse' [default], 'html5', or 'both')." },
      preset: { type: "string", description: "Optional device preset for emulate_device ('mobile', 'tablet', 'desktop', 'android', 'laptop', 'reset')." },
      device: { type: "string", description: "Alias for preset in emulate_device." },
      orientation: { type: "string", enum: ["portrait", "landscape"], description: "Optional screen orientation for emulate_device ('portrait' or 'landscape')." },
      width: { type: "number", description: "Optional custom viewport width in pixels for emulate_device or set_viewport." },
      height: { type: "number", description: "Optional custom viewport height in pixels for emulate_device or set_viewport." },
      scale: { type: "number", description: "Optional device pixel ratio scale factor (e.g. 1, 2, 3) for emulate_device." },
      touch: { type: "boolean", description: "Optional flag to enable or disable touch emulation for emulate_device." },
      userAgent: { type: "string", description: "Optional custom User-Agent override for emulate_device." },
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
      targetId: { type: "string", description: "Optional CDP target id. Pass explicitly when multiple agents control tabs." },
      agentId: { type: "string", description: "Stable agent identity for CDP tab ownership." },
      sessionToken: { type: "string", description: "Secret capability returned by claim_target. Required for actions on claimed tabs." },
      previousTargetId: { type: "string", description: "recover_target: previous owned tab ID; targetId is the explicitly selected replacement tab ID." },
      recoverByUrl: { type: "boolean", description: "Recover only when exactly one Chrome tab has expectedUrl; no ambiguous takeover." },
      expectedUrl: { type: "string", description: "Recover target only when actual target URL matches exactly." },
      memberId: { type: "string", description: "invite_agent/revoke_agent/handover_target: named participant agentId." },
      role: { type: "string", enum: ["observer", "contributor"], description: "invite_agent participant permission." },
      inviteId: { type: "string", description: "join_target: invitation identifier issued by owner." },
      invitationToken: { type: "string", description: "join_target: one-time secret invitation capability; never log." },
      priority: { type: "number", description: "Optional queue priority 0 (highest) through 9 (lowest), default 5." },
      expectedRevision: { type: "number", description: "Optimistic tab revision. Reject stale writes." },
      queue_wait_ms: { type: "number", description: "Maximum time to wait in the per-tab queue (0-120000ms)." },
      includeImageData: { type: "boolean", description: "Include screenshot data inline; disabled by default." }, includeValues: { type: "boolean", description: "Expose sensitive cookie values; disabled by default." }, includeBase64: { type: "boolean", description: "Include bounded PDF base64; disabled by default." },
 max_chars: { type: "number", description: "Bounded page/audit report output." }, max_links: { type: "number", description: "Maximum links returned by read_page." }, limit: { type: "number", description: "Maximum debug events returned (1-300)." }
    },
    required: ["command"],
  },
  execute: async (args: Record<string, unknown>) => {
    let command = String(args.command || args.cmd || "");
    if (!command) {
      if (args.preset || args.device || args.orientation) command = "emulate_device";
      else if (args.source && args.target) command = "drag_and_drop";
      else if (args.option || args.optionText) command = "select_option";
      else if (args.action === "accept" || args.action === "dismiss" || args.tabIndex !== undefined) command = "handle_screen_share";
    }
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
      "expectedRevision", "recoverByUrl", "expectedUrl", "url", "index", "text", "selector", "option", "optionText", "optionIndex", "exact", "wait_ms", "pattern", "query", "filter", "expression", "compact", "diff", "max_elements", "timeout_ms", "clear", "native", "wait_for_elements", "auto_snapshot", "screenshot", "auto_screenshot", "outputPath", "output_path", "fullPage", "full_page", "format", "quality", "verify", "observe", "debounce_ms", "accept", "promptText", "prompt_text", "max_lines", "before_line", "viewport_only", "enter", "key", "terminal_id", "allow_dangerous", "multiline_mode", "allow_visual_fallback", "auto_crop_screenshot", "expected_output", "verify_shell", "force_new_command", "wait_ms", "rebind_on_reload", "debug_port", "debug_ports",
      "grantPermissions", "grant_permissions", "resetPermissions", "reset_permissions", "smooth", "human", "realistic", "x", "y", "steps", "step_delay_ms", "visualCursor", "visual", "source", "target", "sourceIndex", "targetIndex", "source_index", "target_index", "sourceSelector", "targetSelector", "source_selector", "target_selector", "sourceX", "sourceY", "fromX", "fromY", "startX", "startY", "targetX", "targetY", "toX", "toY", "endX", "endY", "dx", "dy", "deltaX", "deltaY",
      "mode", "holdDurationMs", "hold_duration_ms", "dropDwellMs", "drop_dwell_ms", "preset", "device", "orientation", "screenOrientation", "width", "height", "scale", "deviceScaleFactor", "mobile", "touch", "userAgent", "platform", "list_presets", "action", "tabIndex", "tab_index", "includeAudio", "include_audio", "fps", "label", "includeImageData", "include_image_data", "includeValues", "include_values", "includeBase64", "include_base64", "max_chars", "maxChars", "max_links", "maxLinks", "limit",
    ];
    for (const key of convenienceKeys) {
      if (args[key] !== undefined && payload[key] === undefined) payload[key] = args[key];
    }
    const targetId = args.targetId ? String(args.targetId) : payload.targetId ? String(payload.targetId) : undefined;
    const agentId = args.agentId !== undefined ? args.agentId : payload.agentId;
    const sessionToken = args.sessionToken !== undefined ? args.sessionToken : payload.sessionToken;
    const revisionArg = payload.expectedRevision ?? args.expectedRevision;
    const expectedRevision = revisionArg === undefined ? undefined : Number(revisionArg);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))
      return "control_chrome_cdp failed: expectedRevision must be a nonnegative integer.";
    const opts = { sessionToken: sessionToken === undefined ? undefined : String(sessionToken),
      priority: Number(payload.priority ?? args.priority ?? 5),
      waitMs: Number(payload.queue_wait_ms ?? args.queue_wait_ms ?? 8000),
      expectedRevision };

    if (payload.debug_port !== undefined) {
      const port = Number(payload.debug_port);
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
        return "control_chrome_cdp failed: debug_port must be an explicitly selected local port between 1024 and 65535.";
      }
      const withoutPort = { ...payload };
      delete withoutPort.debug_port;
      return terminalCdpConfig.run({ port }, () =>
        controlChromeCdpTool.execute({ ...args, debug_port: undefined, payload: withoutPort }, {} as any));
    }
    if (!cdpAgentContext.getStore()) {
      const agent = agentId === undefined ? undefined : String(agentId);
      if (agent && ["handle_screen_share", "accept_screen_share", "dismiss_screen_share"].includes(command)) {
        return "control_chrome_cdp failed: global screen-share prompts cannot be safely controlled by an agent-scoped CDP session.";
      }
      const category = classifyCdpCommand(command, payload);
      if (category === "write") {
        try {
          const selected = await pickTarget(targetId, false, !!agent);
          const result = await withCdpTargetWrite(cdpPort(), selected.id, agent, () =>
            cdpAgentContext.run({ agentId: agent, sessionToken: opts.sessionToken }, () =>
              controlChromeCdpTool.execute({ ...args, targetId: selected.id, payload }, {} as any)),
              { ...opts, ownerOnly: command === "close_tab" || command === "activate" });
          if (command === "close_tab" && agent && typeof result === "string" &&
              result.startsWith("control_chrome_cdp: closed tab")) {
            await releaseCdpTarget(cdpPort(), selected.id, agent, opts.sessionToken);
          }
          return result;
        } catch (error: any) {
          return "control_chrome_cdp failed: " + error.message;
        }
      }
      if (command === "get_cookies" && (await listCdpSessions()).some(s => s.port === cdpPort())) {
        return "control_chrome_cdp failed: cookies are unavailable while multi-agent CDP sessions exist (browser-context scope).";
      }
      const openRead = new Set([
        "list_targets", "claim_target", "recover_session", "recover_target", "release_target",
        "list_sessions", "coordinator_status", "discover_desktop_targets", "new_tab",
        "share_target", "stop_sharing", "invite_agent", "join_target", "leave_target", "revoke_agent",
        "handover_target", "session_participants", "heartbeat_session",
      ]);
      if (!targetId && !agent && !openRead.has(command) &&
          (await listCdpSessions()).some(s => s.port === cdpPort())) {
        return "control_chrome_cdp failed: specify targetId for all operations while multi-agent sessions are active.";
      }
      if (!openRead.has(command) && (targetId || agent)) {
        try {
          const selected = await pickTarget(targetId, false, !!agent);
          return await withCdpTargetRead(cdpPort(), selected.id, { ...opts, agentId: agent, sharedOnly: command === "shared_snapshot" }, () =>
            cdpAgentContext.run({ agentId: agent, sessionToken: opts.sessionToken }, () =>
              controlChromeCdpTool.execute({ ...args, targetId: selected.id, payload }, {} as any)));
        } catch (error: any) { return "control_chrome_cdp failed: " + error.message; }
      }
      return cdpAgentContext.run({ agentId: agent, sessionToken: opts.sessionToken }, () =>
        controlChromeCdpTool.execute({ ...args, payload }, {} as any));
    }
    try {
      if (["share_target", "stop_sharing", "invite_agent", "join_target", "leave_target",
           "revoke_agent", "handover_target", "session_participants", "heartbeat_session"].includes(command)) {
        if (!targetId || !agentId) throw new Error("Shared tab command requires targetId and agentId.");
        const ownerId = String(agentId);
        const token = opts.sessionToken || "";
        const memberId = String(args.memberId || payload.memberId || "");
        switch (command) {
          case "heartbeat_session": return JSON.stringify(await heartbeatCdpSession(cdpPort(), targetId, ownerId, token));
          case "share_target": return JSON.stringify({ status: "shared", session: await setCdpSharing(cdpPort(), targetId, ownerId, token, true) });
          case "stop_sharing": return JSON.stringify({ status: "isolated", session: await setCdpSharing(cdpPort(), targetId, ownerId, token, false) });
          case "invite_agent": return JSON.stringify(await inviteCdpAgent(cdpPort(), targetId, ownerId, token, memberId, String(args.role || payload.role || "") as CdpParticipantRole));
          case "join_target": return JSON.stringify({ status: "joined", ...await joinCdpTarget(cdpPort(), targetId, ownerId,
            String(args.inviteId || payload.inviteId || ""), String(args.invitationToken || payload.invitationToken || "")) });
          case "leave_target": await leaveCdpTarget(cdpPort(), targetId, ownerId, token); return JSON.stringify({ status: "left", agentId: ownerId, targetId });
          case "revoke_agent": return JSON.stringify({ status: "revoked", session: await revokeCdpAgent(cdpPort(), targetId, ownerId, token, memberId) });
          case "handover_target": return JSON.stringify({ status: "handed_over", session: await handoverCdpTarget(cdpPort(), targetId, ownerId, token, memberId) });
          case "session_participants": return JSON.stringify({ session: await getCdpParticipation(cdpPort(), targetId, ownerId, token) });
        }
      }
      if (command === "recover_target") {
        const previousTargetId = String(args.previousTargetId || payload.previousTargetId || "");
        const expectedUrl = String(args.expectedUrl || payload.expectedUrl || "");
        const recoverByUrl = args.recoverByUrl === true || payload.recoverByUrl === true;
        if (!previousTargetId || !agentId || !opts.sessionToken || (!targetId && !recoverByUrl)) {
          return "control_chrome_cdp failed: recover_target requires previousTargetId, agentId, sessionToken and explicit targetId or recoverByUrl with exact expectedUrl.";
        }
        let selected;
        if (!targetId && recoverByUrl) {
          if (!expectedUrl) throw new Error("recoverByUrl requires exact expectedUrl.");
          const pages = await listPageTargets();
          const matching = pages.filter(t => t.url === expectedUrl);
          if (matching.length !== 1) throw new Error("Recovery target ambiguous or missing: expected one exact URL match.");
          selected = matching[0];
        } else {
          selected = await pickTarget(targetId, false, true);
          if (expectedUrl && selected.url !== expectedUrl)
            throw new Error("Recovery target URL mismatch; refusing unsafe rebind.");
        }
        const next = await rebindCdpTarget(cdpPort(), previousTargetId, selected.id, String(agentId), opts.sessionToken);
        return JSON.stringify({
          status: "rebound", verification: targetId ? "explicit_target" : "unique_exact_url",
          participantsReinviteRequired: true, ...next,
        });
      }
      if (["claim_target", "recover_session", "release_target"].includes(command)) {
        if (!targetId || !agentId) return "control_chrome_cdp failed: targetId and agentId are required.";
        const selected = await pickTarget(targetId, false, true);
        if (command === "release_target") {
          await releaseCdpTarget(cdpPort(), selected.id, String(agentId), opts.sessionToken);
          return `control_chrome_cdp: released target ${selected.id} for agent ${agentId}`;
        }
        const session = await claimCdpTarget(cdpPort(), selected.id, String(agentId), opts.sessionToken);
        return JSON.stringify({ status: command === "recover_session" ? "recovered" : "claimed", ...session });
      }
      if (command === "list_sessions") return JSON.stringify({ sessions: await listCdpSessions() });
      if (command === "coordinator_status") return JSON.stringify(await cdpCoordinatorStatus(cdpPort()));
      if (command === "discover_desktop_targets") {
        return JSON.stringify(await discoverDesktopTargets(
          String(payload.debug_ports || process.env.SUPERAGENT_ELECTRON_CDP_PORTS || cdpPort())));
      }
      if ([
        "read_terminal", "read_terminal_delta", "write_terminal", "send_terminal_key",
        "list_terminal_sessions", "clear_terminal_sessions", "monitor_terminal_agents",
        "watch_terminal", "execute_terminal", "recover_terminal",
      ].includes(command)) {
        return await executeCdpTerminalCommand(command, payload, targetId, {
          pickTarget, send: cdpSend,
          scopeTarget: (target) => "port" + cdpPort() + ":" + target.id,
        });
      }
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
          const issued = newId && agentId ? await claimCdpTarget(cdpPort(), newId, String(agentId)) : undefined;
          if (issued) return JSON.stringify({ status: "opened", url, targetId: newId, agentId, sessionToken: issued.sessionToken });
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
              const s = r?.result?.value;
              if (s === "complete" || s === "interactive" || (s && s !== "loading")) break;
            } catch { break; }
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
              snapshotPrevStore.set(snapshotKey(target.id), snapshotStore.get(snapshotKey(target.id)) ?? []);
              snapshotStore.set(snapshotKey(target.id), fresh);
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
          if (res?.exceptionDetails) {
            const errMsg = res.exceptionDetails.exception?.description || res.exceptionDetails.text || "Evaluation threw an exception";
            return `control_chrome_cdp: evaluate error: ${truncate(String(errMsg), 4000)}`;
          }
          const value = res && res.result ? res.result.value : undefined;
          const out = value === undefined ? "undefined" : typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
          const recentDialogs = getRecentDialogs(target.id, evalStartTs);
          const dialogSuffix = recentDialogs.length > 0 ? `\nIntercepted Native Dialog(s): ${recentDialogs.map(formatDialogEntry).join(" | ")}` : "";
          const baseResult = `control_chrome_cdp: evaluate result: ${truncate(out, 4000)}${dialogSuffix}`;
          return await attachScreenshotIfRequested(cdpSend, target, payload, baseResult, false);
        }
        case "shared_snapshot":
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
            const deadline = Date.now() + parseTimeoutMs(payload.wait_for_elements, 2000);
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 200));
              try {
                res = await cdpSend(target, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
                value = res?.result?.value;
                if (Array.isArray(value)) fresh = value;
                else if (value && typeof value === "object" && Array.isArray((value as any).elements)) {
                  fresh = (value as any).elements;
                  pageOverview = value as any;
                }
                if (fresh.length > 0) break;
              } catch { break; }
            }
          }

          const prev: SnapshotEntry[] = snapshotStore.get(snapshotKey(target.id)) ?? [];
          snapshotPrevStore.set(snapshotKey(target.id), prev);
          snapshotStore.set(snapshotKey(target.id), fresh);
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
            (getCdpExecutionState()?.mode === "shared" ? ` [tabRevision=${getCdpExecutionState()?.revision ?? 0}]` : "") +
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
          const requestedChars = Number(payload.max_chars ?? payload.maxChars ?? 5000);
          const maxChars = Number.isFinite(requestedChars) ? Math.max(500, Math.min(20000, Math.floor(requestedChars))) : 5000;
          sections.push(bodyText ? `Visible Content:\n${truncate(bodyText, maxChars)}` : `Visible Content: (no visible text)`);
          const requestedLinks = Number(payload.max_links ?? payload.maxLinks ?? 20);
          const maxLinks = Number.isFinite(requestedLinks) ? Math.max(0, Math.min(30, Math.floor(requestedLinks))) : 20;
          if (links.length > 0 && maxLinks > 0) {
            sections.push(`Key Links (showing ${Math.min(links.length, maxLinks)} of ${links.length}):\n` + links.slice(0, maxLinks).map((l) => `- "${truncate(l.text || '(no text)', 100)}" -> ${truncate(l.href, 500)}`).join("\n"));
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
          const resolved = resolveActionSelector(payload, snapshotKey(target.id));
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
          const resolved = resolveActionSelector(payload, snapshotKey(target.id));
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
            expression: buildTypeJs(resolved.selector, text, clear, Boolean(payload.native || payload.dispatch_keys)),
            returnByValue: true,
          });
          const value = res && res.result ? res.result.value : undefined;
          const parsed = parseActionResult(typeof value === "string" ? value : JSON.stringify(value));
          if (!parsed.ok) return `control_chrome_cdp: type failed - ${parsed.reason || "unknown reason"}.`;
          if (payload.native || payload.dispatch_keys) await cdpSend(target, "Input.insertText", { text });
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
          return formatScreenshotResult(shot, "control_chrome_cdp:", payload.includeImageData === true || payload.include_image_data === true);
        }
        case "pdf": {
          const target = await pickTarget(targetId);
          const res: any = await cdpSend(target, "Page.printToPDF", {});
          const data = String((res && res.data) || "");
          if (!data) return "control_chrome_cdp: printToPDF returned no data.";
          const outPath = payload.outputPath || payload.output_path;
          const artifact = await saveCdpPdfArtifact(data, outPath ? String(outPath) : undefined);
          const includeBase64 = payload.includeBase64 === true || payload.include_base64 === true;
          return `control_chrome_cdp: PDF saved to ${artifact.savedPath} (${artifact.byteSize} bytes). ${includeBase64 ? `Base64 (limited to 1,000,000 chars):\n${truncate(data, 1000000)}` : "Binary payload omitted by default."}`;
        }
        case "get_cookies": {
          const target = await pickTarget(targetId);
          const res: any = await cdpSend(target, "Storage.getCookies", {});
          const cookies = res && Array.isArray(res.cookies) ? res.cookies : [];
          const summary = cookies.map((c: any) => ({
            name: c.name,
            value: payload.includeValues === true || payload.include_values === true ? String(c.value).slice(0, 48) : "[REDACTED]",
            domain: c.domain,
          }));
          return `control_chrome_cdp: ${cookies.length} cookie(s)${payload.includeValues === true || payload.include_values === true ? "" : " (values redacted; set includeValues: true to expose them)"}:\n${JSON.stringify(summary, null, 1)}`;
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
        case "mock_display_media":
        case "mock_screen_share":
        case "bypass_screen_share": {
          const target = await pickTarget(targetId);
          return await executeMockDisplayMedia(cdpSend, target, payload);
        }
        case "handle_screen_share":
        case "accept_screen_share":
        case "dismiss_screen_share": {
          const action = command === "dismiss_screen_share" ? "dismiss" : ((payload.action as any) || "accept");
          const tabIndex = payload.tabIndex !== undefined ? payload.tabIndex : payload.tab_index;
          return await executeHandleScreenSharePrompt({ action, tabIndex: tabIndex as any });
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
        case "select_option":
        case "select_dropdown":
        case "pick_option": {
          const target = await pickTarget(targetId);
          const selResult = await executeSelectOptionCommand(cdpSend, target, payload);
          return await attachScreenshotIfRequested(cdpSend, target, payload, selResult, false);
        }
        case "check_form":
        case "check_form_readiness":
        case "audit_form": {
          const target = await pickTarget(targetId);
          const formResult = await executeCheckFormCommand(cdpSend, target, payload);
          return await attachScreenshotIfRequested(cdpSend, target, payload, formResult, false);
        }
        case "page_audit": case "accessibility_audit": case "seo_audit": case "responsive_audit": case "performance_metrics": {
          const target = await pickTarget(targetId);
          return await executeCdpAuditCommand(cdpSend, target, command as CdpAuditCommand, payload);
        }
        case "start_debug_capture": case "read_debug_capture": case "stop_debug_capture": case "clear_debug_capture": {
          const target = await pickTarget(targetId, false);
          return await executeCdpDiagnosticsCommand(cdpSend, target, command as CdpDiagnosticCommand, payload);
        }
        default:
          const validCommands = (controlChromeCdpTool.parameters as any).properties.command.enum as string[];
          return "control_chrome_cdp failed: unknown command '" + command + "'. Valid commands: " + validCommands.join(", ") + ".";
      }
    } catch (err: any) {
      return `control_chrome_cdp failed: ${(err && err.message) || String(err)}`;
    }
  },
};
