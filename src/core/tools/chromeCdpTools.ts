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
import { get as httpGet } from "http";

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
  "(the --remote-debugging-port=9222 flag is already installed there), then retry. " +
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

async function listPageTargets(): Promise<CdpTarget[]> {
  const targets: any = await httpGetJson("/json/list");
  if (!Array.isArray(targets)) {
    throw new Error("Unexpected response from CDP /json/list (not an array).");
  }
  return targets.filter((t: any) => t && t.type === "page" && t.webSocketDebuggerUrl);
}

async function pickTarget(targetId?: string): Promise<CdpTarget> {
  const pages = await listPageTargets();
  if (pages.length === 0) {
    throw new Error("No page targets found on the Chrome remote-debugging endpoint. Open a tab in Chrome and retry.");
  }
  if (targetId) {
    const found = pages.find((p) => p.id === targetId);
    if (!found) {
      throw new Error(`No page target with id '${targetId}'. Run command 'list_targets' to see available targets.`);
    }
    return found;
  }
  return pages[0];
}

async function cdpSend(target: CdpTarget, method: string, params: Record<string, unknown> = {}): Promise<any> {
  // PERF: lazy-load `ws` — this tool file stays light until it actually runs.
  const { WebSocket } = await import("ws");
  const timeoutMs = cdpTimeoutMs();
  return new Promise<any>((resolve, reject) => {
    let settled = false;
    let ws: any = undefined;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try {
          if (ws) ws.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP '${method}' response from the target tab.`));
      }
    }, timeoutMs);
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: timeoutMs });
    } catch (e: any) {
      done(() => reject(e));
      return;
    }
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    ws.on("message", (data: any) => {
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg && msg.id === 1) {
        done(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          if (msg.error) {
            reject(new Error(`CDP '${method}' error: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result !== undefined ? msg.result : {});
          }
        });
      }
    });
    ws.on("error", (err: any) => {
      done(() => reject(new Error(`CDP WebSocket error for '${method}': ${(err && err.message) || String(err)}`)));
    });
    ws.on("close", () => {
      done(() => reject(new Error(`CDP WebSocket closed before '${method}' responded.`)));
    });
  });
}

/**
 * Drive the real Chrome via remote debugging — no extension needed.
 */
export const controlChromeCdpTool: Tool = {
  name: "control_chrome_cdp",
  description:
    "Control the user's REAL Chrome browser directly via Chrome Remote Debugging (CDP) at http://127.0.0.1:9222 — no extension required and no isolated background tab. " +
    "REQUIRES Chrome to be running with --remote-debugging-port=9222 (close ALL Chrome windows, then reopen Chrome from the taskbar shortcut). " +
    "Without it, this tool fails fast with an explicit error. " +
    "Commands: list_targets, navigate, evaluate (run JS in the tab to click, type, or read the DOM), screenshot, pdf, get_cookies.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["list_targets", "navigate", "evaluate", "screenshot", "pdf", "get_cookies"],
        description: "CDP command to execute on the real Chrome browser.",
      },
      payload: {
        type: "string",
        description:
          'JSON string payload. navigate: {"url": "https://..."}. evaluate: {"expression": "document.title"} (any JavaScript). screenshot/pdf/get_cookies take {} or may be omitted. Any command also accepts {"targetId": "..."} to pick a tab from list_targets.',
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
          const res: any = await cdpSend(target, "Runtime.evaluate", { expression, returnByValue: true });
          const value = res && res.result ? res.result.value : undefined;
          const out = typeof value === "string" ? value : JSON.stringify(value);
          return `control_chrome_cdp: evaluate result: ${truncate(out, 4000)}`;
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
          return `control_chrome_cdp failed: unknown command '${command}'. Valid commands: list_targets, navigate, evaluate, screenshot, pdf, get_cookies.`;
      }
    } catch (err: any) {
      return `control_chrome_cdp failed: ${(err && err.message) || String(err)}`;
    }
  },
};
