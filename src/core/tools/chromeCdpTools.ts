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

/**
 * Test hooks — read lazily so unit tests can point the tool at a mock CDP
 * server by setting env vars before each call.
 */
function cdpHost(): string {
  return process.env.SUPERAGENT_CDP_HOST || "127.0.0.1";
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
  "Close ALL Chrome windows and reopen Chrome from the taskbar shortcut " +
  "(the --remote-debugging-port=9222 flag is already installed there), " +
  "or launch Chrome via launch_chrome_profile(remoteDebuggingPort: 9222), " +
  "or run scripts/chrome-debug.bat, then retry. " +
  "This tool needs no extension.";

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `… [truncated, ${s.length} chars total]` : s;
}

function httpGetJson(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      { host: cdpHost(), port: cdpPort(), path, timeout: cdpTimeoutMs() },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          // Chrome 155+: the DevTools HTTP discovery endpoints (/json/version,
          // /json/list) answer "426 Upgrade Required" to plain HTTP instead of
          // 200 + JSON. Fall back to fetching the document over a WebSocket
          // handshake (the server upgrades, then sends the JSON as a message).
          if (res.statusCode === 426) {
            wsGetJson(path).then(resolve, reject);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`CDP endpoint ${path} returned HTTP ${res.statusCode}; expected 200 with a JSON body.`));
            return;
          }
          try {
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
    req.on("error", (err: any) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")) {
        reject(new Error(CDP_PORT_CLOSED_MSG));
      } else {
        reject(err);
      }
    });
  });
}

function httpPutJson(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: cdpHost(), port: cdpPort(), path, method: "PUT", timeout: cdpTimeoutMs() },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
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
    req.on("error", (err: any) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")) {
        reject(new Error(CDP_PORT_CLOSED_MSG));
      } else {
        reject(err);
      }
    });
    req.end();
  });
}

/**
 * Chrome 155+ fallback for the 426 "Upgrade Required" returned by the DevTools
 * HTTP discovery endpoints. Performs a WebSocket handshake against the same
 * path (with the Origin header the DevTools WS origin check expects) and
 * reads the JSON discovery document from the first text message the server
 * sends. Plain-HTTP 200 responses are still preferred; this only runs when
 * the server answered 426, so older Chrome versions are unaffected.
 */
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
        const url = `ws://${cdpHost()}:${cdpPort()}${path}`;
        const ws = new WebSocket(url, {
          handshakeTimeout: cdpTimeoutMs(),
          origin: `http://${cdpHost()}:${cdpPort()}`,
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
  const pages = await listPageTargets();
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

/**
 * Last DOM snapshot per CDP target id. `snapshot` fills it; `click`/`type`
 * consume it by index so the LLM never needs element IDs, coordinates, or
 * screenshots. A snapshot belongs to the tab it was taken on.
 */
interface SnapshotEntry {
  index: number;
  tag: string;
  text: string;
  type?: string;
  placeholder?: string;
  ariaLabel?: string;
  selector: string;
}

const snapshotStore = new Map<string, SnapshotEntry[]>();

/** Previous snapshot per target id - powers `snapshot` with `diff: true`. */
const snapshotPrevStore = new Map<string, SnapshotEntry[]>();

/**
 * Walks the DOM and returns the interactive elements, each with a generated
 * unique selector. Runs inside the page via Runtime.evaluate.
 */
const SNAPSHOT_JS = `/*cdp-snapshot-walk*/(() => {
  const els = Array.from(document.querySelectorAll(
    'button, a, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [onclick], summary'
  ));
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const role = el.getAttribute('role');
    if (role === 'presentation' || role === 'none') return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && !el.getAttribute('href') && !el.getAttribute('onclick') && !role) return false;
    return true;
  }
  function genSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 5) {
      let seg = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
    }
    return parts.join(' > ');
  }
  function label(el) {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, 80);
  }
  return els.filter(visible).slice(0, 120).map((el, i) => ({
    index: i,
    tag: el.tagName.toLowerCase(),
    text: label(el),
    type: el.getAttribute('type') || undefined,
    placeholder: el.getAttribute('placeholder') || undefined,
    ariaLabel: el.getAttribute('aria-label') || undefined,
    selector: genSelector(el),
  }));
})()`;

/**
 * Builds page JS that clicks the element matching `selector`.
 * Returns a JSON string: {ok, tag?, text?, reason?}.
 */
function buildClickJs(selector: string): string {
  return `/*cdp-click*/(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: "no element matches selector" });
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    el.click();
    const t = (el.innerText || el.value || "").replace(/\\s+/g, " ").trim().slice(0, 80);
    return JSON.stringify({ ok: true, tag: el.tagName.toLowerCase(), text: t });
  })()`;
}

/**
 * Builds page JS that types `text` into the element matching `selector`.
 * Framework-friendly: uses the native value setter and dispatches
 * input/change events (React/Vue detect the change). Handles input,
 * textarea, and contenteditable. Returns a JSON string.
 */
function buildTypeJs(selector: string, text: string, clear: boolean): string {
  return `/*cdp-type*/(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ ok: false, reason: "no element matches selector" });
    try { el.scrollIntoView({ block: "center" }); } catch (e) {}
    el.focus();
    const tag = el.tagName.toLowerCase();
    const text = ${JSON.stringify(text)};
    const doClear = ${clear ? "true" : "false"};
    function fire() {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (tag === "input" || tag === "textarea") {
      const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      const setter = desc && desc.set;
      if (doClear) { if (setter) setter.call(el, ""); else el.value = ""; fire(); }
      if (setter) setter.call(el, text); else el.value = text;
      fire();
    } else if (el.isContentEditable) {
      const sel = window.getSelection();
      if (doClear) el.textContent = "";
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      let inserted = false;
      try { inserted = document.execCommand("insertText", false, text); } catch (e) {}
      if (!inserted) el.textContent = doClear ? text : el.textContent + text;
      fire();
    } else {
      return JSON.stringify({ ok: false, reason: "element is not editable (not input/textarea/contenteditable)" });
    }
    return JSON.stringify({ ok: true, tag: tag, typed: text.slice(0, 80) });
  })()`;
}

/** Parses the JSON string returned by the click/type page snippets. */
function parseActionResult(raw: string): {
  ok: boolean;
  tag?: string;
  text?: string;
  typed?: string;
  reason?: string;
} {
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") return o;
  } catch {
    /* fall through */
  }
  return { ok: false, reason: `unexpected result: ${truncate(raw, 200)}` };
}

/** Parses an optional timeout_ms payload field; falls back to `def` when missing/invalid. */
function parseTimeoutMs(v: unknown, def: number): number {
  if (v === undefined || v === null || v === "") return def;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 ? n : def;
}

/**
 * Builds page JS that waits (in-page polling, ~200ms interval) for a CSS
 * selector to match a visible element, or for a text to appear in the page.
 * Resolves to a JSON string: {ok, kind?, selector?, text?, tag?, foundText?, reason?}.
 * Must be run via Runtime.evaluate with awaitPromise: true so one CDP
 * round-trip covers the whole wait - no polling from the LLM side.
 */
function buildWaitForJs(opts: { selector?: string; text?: string; timeoutMs: number }): string {
  const optsJson = JSON.stringify(opts);
  return `/*cdp-wait-for*/(() => {
    const o = ${optsJson};
    return new Promise((resolve) => {
      const timeoutMs = o.timeoutMs;
      const deadline = Date.now() + timeoutMs;
      function visible(el) {
        if (!el || el.nodeType !== 1) return false;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return false;
        try {
          const cs = getComputedStyle(el);
          if (cs.visibility === "hidden" || cs.display === "none") return false;
        } catch (e) {}
        return true;
      }
      function finishOk(kind, el) {
        const t = el ? ((el.innerText || el.value || "").replace(/\\s+/g, " ").trim()).slice(0, 80) : "";
        resolve(JSON.stringify({
          ok: true, kind: kind,
          selector: o.selector || undefined, text: o.text || undefined,
          tag: el ? el.tagName.toLowerCase() : undefined, foundText: t || undefined
        }));
      }
      function finishTimeout() {
        const waiting = o.selector ? ("selector '" + o.selector + "'") : ("text '" + o.text + "'");
        resolve(JSON.stringify({ ok: false, reason: "timeout after " + timeoutMs + "ms waiting for " + waiting }));
      }
      function check() {
        if (o.selector) {
          let el = null;
          try { el = document.querySelector(o.selector); } catch (e) {}
          if (el && visible(el)) { finishOk("selector", el); return true; }
        }
        if (o.text) {
          try {
            const bodyText = (document.body && document.body.innerText) || "";
            if (bodyText.indexOf(o.text) !== -1) { finishOk("text", null); return true; }
          } catch (e) {}
        }
        return false;
      }
      if (check()) return;
      const iv = setInterval(() => {
        if (check()) { clearInterval(iv); return; }
        if (Date.now() >= deadline) { clearInterval(iv); finishTimeout(); }
      }, 200);
    });
  })()`;
}

/** Runs the in-page wait on the target and parses the JSON result. */
async function waitForInPage(
  target: CdpTarget,
  opts: { selector?: string; text?: string; timeoutMs: number }
): Promise<{
  ok: boolean;
  kind?: string;
  selector?: string;
  text?: string;
  tag?: string;
  foundText?: string;
  reason?: string;
}> {
  const res: any = await cdpSend(target, "Runtime.evaluate", {
    expression: buildWaitForJs(opts),
    awaitPromise: true,
    returnByValue: true,
  });
  const value = res && res.result ? res.result.value : undefined;
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === "object") return o;
  } catch {
    /* fall through */
  }
  return { ok: false, reason: `unexpected wait_for result: ${truncate(raw, 200)}` };
};

/**
 * Resolves a click/type target from the payload: either {"index": N}
 * (from the last `snapshot` of this tab) or {"selector": "<css>"}.
 */
function resolveActionSelector(
  payload: Record<string, unknown>,
  targetId: string
): { selector: string } | { error: string } {
  if (typeof payload.index === "number" && Number.isInteger(payload.index)) {
    const entries = snapshotStore.get(targetId);
    if (entries === undefined) {
      return {
        error:
          'control_chrome_cdp failed: no snapshot for this tab yet. Run command \'snapshot\' first, then click/type with {"index": N}.',
      };
    }
    if (entries.length === 0) {
      return {
        error:
          "control_chrome_cdp failed: the snapshot for this tab is empty — 'snapshot' found no interactive elements on this page.",
      };
    }
    const idx: number = payload.index;
    const entry = entries[idx];
    if (!entry) {
      return {
        error:
          `control_chrome_cdp failed: index ${idx} out of range — snapshot has ${entries.length} element(s) ` +
          `(indices 0..${entries.length - 1}). Run 'snapshot' again to refresh.`,
      };
    }
    return { selector: entry.selector };
  }
  const selector = String(payload.selector || "");
  if (!selector) {
    return {
      error:
        'control_chrome_cdp failed: provide either {"index": N} (from \'snapshot\') or {"selector": "<css>"}.',
    };
  }
  return { selector };
}

/**
 * Persistent CDP connections, keyed by the target's webSocketDebuggerUrl.
 * One WebSocket serves many sequential (and parallel) commands - multiplexed
 * by CDP message id - instead of opening a new socket per command. Dead or
 * long-idle sockets are dropped and re-established on demand.
 */
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

/** Connections idle longer than this are closed and recreated on demand. */
const CDP_CONN_IDLE_MS = 60000;

/** Cached lazy `ws` module - this file stays light until it actually runs. */
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

/** Drops pooled connections whose target no longer exists in Chrome. */
function pruneCdpConnections(liveUrls: string[]): void {
  const live = new Set(liveUrls);
  for (const url of Array.from(cdpConnections.keys())) {
    if (!live.has(url)) {
      closeCdpConnection(url, "CDP target is no longer open in Chrome; connection dropped.");
    }
  }
}

/**
 * Returns a healthy shared WebSocket for the target, opening (and
 * handshaking) one when needed. A dead or long-idle socket is discarded and
 * replaced; a socket that fails to open raises a clear error - never a hang.
 */
async function getCdpConnection(target: CdpTarget): Promise<CdpConnection> {
  const url = target.webSocketDebuggerUrl;
  const existing = cdpConnections.get(url);
  if (existing) {
    let open = false;
    try {
      open = existing.ws.readyState === 1; // 1 = OPEN
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
    }
  });
  const onDead = (why: string) => {
    if (cdpConnections.get(url) === conn) {
      if (conn.pending.size > 0) {
        closeCdpConnection(url, why);
      } else {
        cdpConnections.delete(url);
      }
    }
  };
  ws.on("error", (err: any) => {
    onDead(`CDP WebSocket error: ${(err && err.message) || String(err)}`);
  });
  ws.on("close", () => {
    onDead("CDP WebSocket to the target tab closed unexpectedly.");
  });
  const opened = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), timeoutMs);
    ws.once("open", () => {
      clearTimeout(t);
      resolve(true);
    });
    ws.once("error", () => {
      clearTimeout(t);
      resolve(false);
    });
    ws.once("close", () => {
      clearTimeout(t);
      resolve(false);
    });
  });
  if (!opened || cdpConnections.get(url) !== conn) {
    closeCdpConnection(url, `Timed out after ${timeoutMs}ms opening CDP WebSocket to the target tab.`);
    throw new Error(`Timed out after ${timeoutMs}ms opening CDP WebSocket to the target tab.`);
  }
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

/**
 * Test-only hooks (not part of the tool surface): lets unit tests observe
 * and reset the persistent-connection pool.
 */
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
    "Without it, this tool fails fast with an explicit error. " +
    "Commands: list_targets, new_tab (open new tab with optional url), close_tab (close tab by targetId), activate (bring tab to front/unthrottle), navigate, evaluate (run any JS in the tab; auto-awaits Promises), snapshot (numbered list of interactive elements; options: compact, max_elements, diff), click (click by index or CSS selector, auto-waits for the element), type (type by index or CSS selector, auto-waits for the element), wait_for (wait for a selector or text to appear), screenshot, pdf, get_cookies. " +
    "RECOMMENDED WORKFLOW for page interaction (no element IDs, no coordinates, no screenshots needed): 1) run 'snapshot' to get a numbered list of interactive elements, 2) 'click' with {\"index\": N} or 'type' with {\"index\": N, \"text\": \"...\"}. " +
    "click/type also accept {\"selector\": \"<css>\"} instead of an index. 'type' clears the field first by default (\"clear\": false to append) and dispatches input/change events so reactive frameworks detect the change. " +
    "click/type auto-wait for the element to appear (payload \"timeout_ms\", default 10000, 0 disables). 'wait_for' with {\"selector\": \"<css>\"} or {\"text\": \"<teks>\"} waits for content to appear without acting.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["list_targets", "new_tab", "close_tab", "activate", "navigate", "evaluate", "snapshot", "click", "type", "wait_for", "screenshot", "pdf", "get_cookies"],
        description: "CDP command to execute on the real Chrome browser.",
      },
      payload: {
        type: "string",
        description:
          'JSON string payload. new_tab: {"url": "https://..."}. navigate: {"url": "https://..."}. evaluate: {"expression": "document.title"} (any JavaScript; awaits Promises). snapshot: {} (numbered interactive-element list). click: {\"index\": 3} or {\"selector\": \"#login\"}. type: {\"index\": 2, \"text\": \"hello\", \"clear\": true} (\"clear\" defaults true) or {\"selector\": \"input[name=q]\", \"text\": \"...\"}. screenshot/pdf/get_cookies/snapshot/activate/close_tab take {} or may be omitted. Any command also accepts {"targetId": "..."} to pick a tab from list_targets.',
      },
      targetId: {
        type: "string",
        description: "Optional CDP target id (from list_targets). Defaults to the first open page tab.",
      },
    },
    required: ["command"],
  },
  execute: async (args: Record<string, unknown>) => {
    const command = String(args.command || "");
    let payload: Record<string, unknown> = {};
    if (args.payload !== undefined && args.payload !== "") {
      try {
        payload = JSON.parse(String(args.payload));
      } catch {
        return "control_chrome_cdp failed: 'payload' must be a valid JSON string.";
      }
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
          return `control_chrome_cdp: navigated tab '${truncate(target.title, 80)}' to ${url}`;
        }
        case "evaluate": {
          const expression = String(payload.expression || "");
          if (!expression) return 'control_chrome_cdp failed: command \'evaluate\' needs payload {"expression": "..."}.';
          const target = await pickTarget(targetId);
          const res: any = await cdpSend(target, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          const value = res && res.result ? res.result.value : undefined;
          const out = typeof value === "string" ? value : JSON.stringify(value);
          return `control_chrome_cdp: evaluate result: ${truncate(out, 4000)}`;
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
          const res: any = await cdpSend(target, "Runtime.evaluate", { expression: SNAPSHOT_JS, returnByValue: true });
          const value = res && res.result ? res.result.value : undefined;
          const fresh: SnapshotEntry[] = Array.isArray(value) ? value : [];
          const prev: SnapshotEntry[] = snapshotStore.get(target.id) ?? [];
          snapshotPrevStore.set(target.id, prev);
          snapshotStore.set(target.id, fresh);
          const entries = fresh.slice(0, maxElements);
          const title = `'${truncate(target.title, 60)}'`;
          const fmt = (e: SnapshotEntry): string => {
            const labelText = e.text || e.placeholder || e.ariaLabel || "";
            const textStr = labelText ? ` "${labelText}"` : "";
            if (compact) return `[${e.index}] <${e.tag}>${textStr}`;
            const attrs: string[] = [];
            if (e.type) attrs.push(`type="${e.type}"`);
            if (e.placeholder) attrs.push(`placeholder="${e.placeholder}"`);
            if (e.ariaLabel) attrs.push(`aria-label="${e.ariaLabel}"`);
            const attrStr = attrs.length > 0 ? " " + attrs.join(" ") : "";
            return `[${e.index}] <${e.tag}${attrStr}>${textStr}`;
          };
          if (diff) {
            if (prev.length === 0) {
              return (
                `control_chrome_cdp: snapshot diff of ${title} - no previous snapshot, showing full list ` +
                `(${entries.length} interactive element(s)).\n` +
                `Use click/type with {"index": N}.\n${entries.map(fmt).join("\n")}`
              );
            }
            const prevBySel = new Map(prev.map((e) => [e.selector, e] as [string, SnapshotEntry]));
            const curBySel = new Map(fresh.map((e) => [e.selector, e] as [string, SnapshotEntry]));
            const added = entries.filter((e) => !prevBySel.has(e.selector));
            const removed = prev.filter((e) => !curBySel.has(e.selector));
            const changed = entries.filter((e) => {
              const p = prevBySel.get(e.selector);
              return !!p && (p.text !== e.text || p.tag !== e.tag);
            });
            const dlines: string[] = [];
            for (const e of added) dlines.push(`+ ${fmt(e)}`);
            for (const e of removed) dlines.push(`- ${fmt(e)}`);
            for (const e of changed) {
              const p = prevBySel.get(e.selector)!;
              dlines.push(`~ ${fmt(e)} (was "${p.text}")`);
            }
            return (
              `control_chrome_cdp: snapshot diff of ${title} - ` +
              `+${added.length} added, -${removed.length} removed, ~${changed.length} changed.\n` +
              (dlines.length > 0 ? dlines.join("\n") : "(no changes)")
            );
          }
          if (entries.length === 0) {
            return "control_chrome_cdp: snapshot found no interactive elements on this page.";
          }
          const isLimited = (payload.max_elements !== undefined && payload.max_elements !== "") || fresh.length > maxElements;
          return (
            `control_chrome_cdp: snapshot of ${title} - ${entries.length} interactive element(s)` +
            (compact ? " (compact)" : "") +
            (isLimited ? ` (limited to ${maxElements})` : "") +
            `.\n` +
            `Use click/type with {"index": N}.\n${entries.map(fmt).join("\n")}`
          );
        }
        case "click": {
          const target = await pickTarget(targetId);
          const resolved = resolveActionSelector(payload, target.id);
          if ("error" in resolved) return resolved.error;
          const clickWaitMs = parseTimeoutMs(payload.timeout_ms, 10000);
          if (clickWaitMs > 0) {
            const w = await waitForInPage(target, { selector: resolved.selector, timeoutMs: clickWaitMs });
            if (!w.ok) {
              return (
                `control_chrome_cdp: click timed out after ${clickWaitMs}ms waiting for '${resolved.selector}' to appear and become visible. ` +
                `Run 'snapshot' to refresh the element list, or 'wait_for' with a longer timeout.`
              );
            }
          }
          const res: any = await cdpSend(target, "Runtime.evaluate", {
            expression: buildClickJs(resolved.selector),
            returnByValue: true,
          });
          const value = res && res.result ? res.result.value : undefined;
          const parsed = parseActionResult(typeof value === "string" ? value : JSON.stringify(value));
          if (!parsed.ok) return `control_chrome_cdp: click failed - ${parsed.reason || "unknown reason"}.`;
          const textStr = parsed.text ? ` "${parsed.text}"` : "";
          return `control_chrome_cdp: clicked <${parsed.tag}>${textStr}.`;
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
            const w = await waitForInPage(target, { selector: resolved.selector, timeoutMs: typeWaitMs });
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
          return `control_chrome_cdp: typed into <${parsed.tag}>: "${truncate(parsed.typed || text, 80)}".`;
        }
        case "wait_for": {
          const selector = String(payload.selector || "");
          const text = String(payload.text || "");
          if (!selector && !text) {
            return `control_chrome_cdp failed: command 'wait_for' needs payload {"selector": "<css>"} or {"text": "<teks>"} (optionally "timeout_ms").`;
          }
          const waitMs = parseTimeoutMs(payload.timeout_ms, 15000);
          const target = await pickTarget(targetId);
          const w = await waitForInPage(target, {
            selector: selector || undefined,
            text: text || undefined,
            timeoutMs: waitMs,
          });
          if (!w.ok) {
            return `control_chrome_cdp: wait_for ${w.reason || "timed out"}.`;
          }
          const what =
            w.kind === "text"
              ? `text "${w.text}"`
              : `selector '${selector}'` + (w.tag ? ` (<${w.tag}>${w.foundText ? ` "${w.foundText}"` : ""})` : "");
          return `control_chrome_cdp: wait_for matched ${what}.`;
        }
        case "screenshot": {
          const target = await pickTarget(targetId);
          const res: any = await cdpSend(target, "Page.captureScreenshot", { format: "png" });
          const data = String((res && res.data) || "");
          if (!data) return "control_chrome_cdp: screenshot returned no data.";
          return `control_chrome_cdp: PNG screenshot captured (${data.length} base64 chars):\n${data}`;
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
        default:
          return `control_chrome_cdp failed: unknown command '${command}'. Valid commands: list_targets, new_tab, close_tab, activate, navigate, evaluate, snapshot, click, type, wait_for, screenshot, pdf, get_cookies.`;
      }
    } catch (err: any) {
      return `control_chrome_cdp failed: ${(err && err.message) || String(err)}`;
    }
  },
};
