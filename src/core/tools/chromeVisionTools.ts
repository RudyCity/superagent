/**
 * Vision-based Chrome automation via local OmniParser.
 *
 * Workflow:
 *  1. `parse_screenshot` — capture tab screenshot via CDP, send to the local
 *     OmniParser service (http://127.0.0.1:9333), get back a numbered list of
 *     UI elements with bounding boxes + labels (vision-based, no DOM needed).
 *  2. `click_label` — fuzzy-match an element by its label, click its center
 *     via CDP Input.dispatchMouseEvent.
 *  3. `type_label` — click an element by label, then type text via
 *     CDP Input.insertText.
 *
 * REQUIRES:
 *  - Chrome running with --remote-debugging-port=9222 (same as control_chrome_cdp).
 *  - OmniParser service: AUTO-STARTED by this tool on first use
 *    (spawns `python services/omniparser/omniparser_service.py` as a background
 *    process, listens on 127.0.0.1:9333).
 *  - FIRST TIME: model weights (~1.1GB) need a one-time download. If this tool
 *    returns OMNIPARSER_SETUP_NEEDED, the AGENT must ask the user via
 *    ask_question ("OmniParser needs ~1.1GB model download. Proceed?") and, on
 *    approval, run this tool's 'setup' command before retrying. Applies in ALL
 *    agent modes (CLI, chat, bridge).
 */
import { Tool } from "./types.js";
import { get as httpGet, request as httpRequest } from "http";
import { spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

function cdpHost(): string {
  return process.env.SUPERAGENT_CDP_HOST || "127.0.0.1";
}
function cdpPort(): number {
  return Number(process.env.SUPERAGENT_CDP_PORT) || 9222;
}
function cdpTimeoutMs(): number {
  return Number(process.env.SUPERAGENT_CDP_TIMEOUT_MS) || 20000;
}
function omniHost(): string {
  return process.env.SUPERAGENT_OMNI_HOST || "127.0.0.1";
}
function omniPort(): number {
  return Number(process.env.SUPERAGENT_OMNI_PORT) || 9333;
}

export const CDP_PORT_CLOSED_MSG =
  "Chrome is not running with --remote-debugging-port=9222. " +
  "Close ALL Chrome windows and reopen Chrome from the taskbar shortcut " +
  "(or run scripts/chrome-debug.bat), then retry. This tool needs no extension.";

export const OMNI_NOT_RUNNING_MSG =
  "OmniParser service could not be started automatically. " +
  "Start it manually with: python services/omniparser/omniparser_service.py " +
  "(from the superagent repo root). It loads YOLO + Florence-2 locally. " +
  "First-time setup: python services/omniparser/setup.py";

export const OMNIPARSER_SETUP_NEEDED_MSG =
  "OMNIPARSER_SETUP_NEEDED: OmniParser model weights (~1.1GB) are not installed yet. " +
  "AGENT INSTRUCTION (applies in ALL modes - CLI, chat, bridge): use the ask_question tool to ask the user " +
  "'OmniParser AI needs a one-time ~1.1GB model download to enable vision-based Chrome automation. Proceed with setup?'. " +
  "If the user approves, run this tool with command='setup' and wait for it to finish, then retry the original command. " +
  "If the user declines, explain that control_chrome_vision cannot be used without the models.";

/**
 * Find a usable Python interpreter. Tries `python`, `py`, `python3` in order.
 * Returns the command name, or null if none found.
 */
async function findPython(): Promise<string | null> {
  const { execFile } = await import("child_process");
  const candidates = ["python", "py", "python3"];
  for (const cmd of candidates) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(cmd, ["--version"], { timeout: 5000 }, (err: any) => {
          err ? reject(err) : resolve();
        });
      });
      return cmd;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Locate the OmniParser service script, starting from this file's directory
 * and walking up to find the repo root (services/omniparser/).
 */
function findServiceScript(): string | null {
  // __dirname in CJS, or import.meta.dirname in ESM
  let here: string;
  try {
    // @ts-ignore - ESM context
    here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "services", "omniparser", "omniparser_service.py");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: env override or cwd-relative
  const envPath = process.env.SUPERAGENT_OMNI_SERVICE;
  if (envPath && existsSync(envPath)) return envPath;
  const cwdCandidate = join(process.cwd(), "services", "omniparser", "omniparser_service.py");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return null;
}

/** Locate the services/omniparser directory (walk up from this file). */
function findOmniDir(): string | null {
  const script = findServiceScript();
  if (script) return dirname(script);
  let here: string;
  try {
    // @ts-ignore - ESM context
    here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "services", "omniparser");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** True if OmniParser model weights are already downloaded (setup done). */
function weightsReady(): boolean {
  const omniDir = findOmniDir();
  if (!omniDir) return false;
  // Marker file written by setup.py on success
  if (existsSync(join(omniDir, ".setup_done"))) return true;
  // Fallback: actual weight FILES must exist (an empty subdir does not count)
  try {
    const entries = readdirSync(join(omniDir, "weights"), { recursive: true }) as string[];
    return entries.some((e) => /\.(pt|bin|safetensors)$/i.test(e));
  } catch {
    return false;
  }
}

/** Locate services/omniparser/setup.py */
function findSetupScript(): string | null {
  const omniDir = findOmniDir();
  if (!omniDir) return null;
  const candidate = join(omniDir, "setup.py");
  return existsSync(candidate) ? candidate : null;
}

/** Quick check: is the OmniParser service responding on /health? */
async function omniHealth(): Promise<boolean> {
  try {
    const res: any = await httpGetJson(omniHost(), omniPort(), "/health");
    return res && (res.status === "ready" || typeof res.status === "string");
  } catch {
    return false;
  }
}

/**
 * Ensure the OmniParser service is running. If port 9333 refuses connections,
 * spawn `python services/omniparser/omniparser_service.py` as a detached
 * background process and poll /health until ready (up to 90s for first
 * model load). Throws a clear error if the service cannot be started.
 */
let omniStartInFlight: Promise<void> | null = null;
async function ensureOmniRunning(): Promise<void> {
  // Never auto-download ~1.1GB of models without the user's approval.
  // The agent must ask via ask_question and run the 'setup' command.
  if (!weightsReady()) {
    throw new Error(OMNIPARSER_SETUP_NEEDED_MSG);
  }
  if (await omniHealth()) return;
  // De-dupe concurrent start attempts
  if (omniStartInFlight) {
    await omniStartInFlight;
    if (await omniHealth()) return;
    throw new Error(OMNI_NOT_RUNNING_MSG);
  }
  omniStartInFlight = (async () => {
    const script = findServiceScript();
    if (!script) {
      throw new Error(
        "OmniParser service script not found (services/omniparser/omniparser_service.py). " +
        "Run: python services/omniparser/setup.py (first time) from the superagent repo root."
      );
    }
    const python = await findPython();
    if (!python) {
      throw new Error(
        "No Python interpreter found (tried python, py, python3). " +
        "Install Python 3.10+ to use control_chrome_vision."
      );
    }
    // Spawn detached so it survives after this call returns
    const child = spawn(python, [script], {
      detached: true,
      stdio: "ignore",
      cwd: dirname(script),
      windowsHide: true,
    });
    child.unref();
    // Poll /health until ready (model load takes 10-60s first time)
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await omniHealth()) return;
    }
    throw new Error(
      "OmniParser service started but did not become ready within 90s. " +
      "Check that models are downloaded: python services/omniparser/setup.py"
    );
  })();
  try {
    await omniStartInFlight;
  } finally {
    omniStartInFlight = null;
  }
}

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface VisionElement {
  id: number;
  x: number;
  y: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  label: string;
  type: string;
}

/** Minimal HTTP GET returning parsed JSON. Rejects with CDP_PORT_CLOSED_MSG on ECONNREFUSED. */
function httpGetJson(host: string, port: number, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = httpGet(
      { host, port, path, timeout: cdpTimeoutMs() },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e: any) {
            reject(new Error(`Invalid JSON from http://${host}:${port}${path}: ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timed out reaching http://${host}:${port}${path}.`));
    });
    req.on("error", (err: any) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")) {
        reject(new Error(port === cdpPort() ? CDP_PORT_CLOSED_MSG : OMNI_NOT_RUNNING_MSG));
      } else {
        reject(err);
      }
    });
  });
}

/** POST JSON, return parsed JSON response. */
function httpPostJson(host: string, port: number, path: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = httpRequest(
      {
        host,
        port,
        path,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: 120000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`OmniParser service returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e: any) {
            reject(new Error(`Invalid JSON from OmniParser service: ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timed out waiting for OmniParser service (model inference can take 10-30s on first run)."));
    });
    req.on("error", (err: any) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")) {
        reject(new Error(OMNI_NOT_RUNNING_MSG));
      } else {
        reject(err);
      }
    });
    req.write(body);
    req.end();
  });
}

async function listPageTargets(): Promise<CdpTarget[]> {
  const targets: any = await httpGetJson(cdpHost(), cdpPort(), "/json/list");
  if (!Array.isArray(targets)) throw new Error("Unexpected /json/list response.");
  return targets.filter((t: any) => t && t.type === "page" && t.webSocketDebuggerUrl);
}

async function pickTarget(targetId?: string): Promise<CdpTarget> {
  const pages = await listPageTargets();
  if (!pages.length) throw new Error("No open Chrome tabs found.");
  if (targetId) {
    const t = pages.find((p) => p.id === targetId || p.id.startsWith(targetId));
    if (!t) throw new Error(`No tab matches targetId '${targetId}'.`);
    return t;
  }
  return pages[0];
}

/** Send one CDP command over a fresh WebSocket, return the result. */
async function cdpSend(wsUrl: string, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const { WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws: any = new WebSocket(wsUrl, { handshakeTimeout: cdpTimeoutMs() });
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`CDP '${method}' timed out after ${cdpTimeoutMs()}ms.`));
    }, cdpTimeoutMs());
    ws.on("open", () => ws.send(JSON.stringify({ id, method, params })));
    ws.on("message", (data: any) => {
      let msg: any;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg && msg.id === id) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        if (msg.error) reject(new Error(`CDP '${method}' error: ${msg.error.message || JSON.stringify(msg.error)}`));
        else resolve(msg.result || {});
      }
    });
    ws.on("error", (e: any) => {
      clearTimeout(timer);
      reject(new Error(`CDP WebSocket error: ${(e && e.message) || String(e)}`));
    });
  });
}

async function captureScreenshot(target: CdpTarget): Promise<string> {
  const res: any = await cdpSend(target.webSocketDebuggerUrl, "Page.captureScreenshot", { format: "png" });
  if (!res.data) throw new Error("Page.captureScreenshot returned no data.");
  return res.data as string;
}

async function clickAt(target: CdpTarget, x: number, y: number): Promise<void> {
  const wsUrl = target.webSocketDebuggerUrl;
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdpSend(wsUrl, "Input.dispatchMouseEvent", {
      type, x, y, button: "left", clickCount: 1,
    });
  }
}

async function typeText(target: CdpTarget, text: string): Promise<void> {
  await cdpSend(target.webSocketDebuggerUrl, "Input.insertText", { text });
}

/** Fuzzy match: all words of query appear in label (case-insensitive). */
function matchLabel(label: string, query: string): boolean {
  const l = (label || "").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => l.includes(w));
}

function formatElements(elements: VisionElement[]): string {
  if (!elements.length) return "No UI elements detected.";
  const lines = elements.map((e) => {
    const lbl = e.label ? ` "${e.label}"` : "";
    return `[${e.id}] (${e.x},${e.y}) ${e.type}${lbl} [${e.width}x${e.height}]`;
  });
  return `Detected ${elements.length} UI element(s) (vision-based):\n` + lines.join("\n");
}

/**
 * One-time setup: download OmniParser model weights (~1.1GB) + install deps.
 * ONLY call this after the user approves via ask_question.
 */
async function cmdSetup(): Promise<string> {
  const script = findSetupScript();
  if (!script) {
    throw new Error("OmniParser setup script not found (services/omniparser/setup.py).");
  }
  const python = await findPython();
  if (!python) {
    throw new Error("No Python interpreter found (tried python, py, python3). Install Python 3.10+ first.");
  }
  const { execFile } = await import("child_process");
  const output: string = await new Promise((resolve, reject) => {
    execFile(
      python,
      [script],
      { timeout: 30 * 60 * 1000, maxBuffer: 10 * 1024 * 1024, cwd: dirname(script), windowsHide: true },
      (err: any, stdout: string, stderr: string) => {
        const tail = String(stdout).slice(-2000) + "\n" + String(stderr).slice(-2000);
        if (err) reject(new Error(`OmniParser setup failed: ${err.message}\n${tail}`));
        else resolve(tail);
      }
    );
  });
  if (!weightsReady()) {
    throw new Error("OmniParser setup finished but weights are still missing. Output:\n" + output);
  }
  return "OmniParser setup complete - model weights downloaded. You can now use parse_screenshot / click_label / type_label.";
}

async function cmdParseScreenshot(payload: any): Promise<string> {
  const target = await pickTarget(payload?.targetId);
  // Auto-start the OmniParser service if not running
  await ensureOmniRunning();
  const pngBase64 = await captureScreenshot(target);
  const res: any = await httpPostJson(omniHost(), omniPort(), "/parse", { image_base64: pngBase64 });
  const elements: VisionElement[] = res.elements || [];
  return formatElements(elements);
}

async function findByLabel(payload: any): Promise<{ target: CdpTarget; el: VisionElement }> {
  const label = payload?.label;
  if (!label || typeof label !== "string") throw new Error("click_label/type_label need payload {\"label\": \"...\"}.");
  const target = await pickTarget(payload?.targetId);
  // Auto-start the OmniParser service if not running
  await ensureOmniRunning();
  const pngBase64 = await captureScreenshot(target);
  const res: any = await httpPostJson(omniHost(), omniPort(), "/parse", { image_base64: pngBase64 });
  const elements: VisionElement[] = res.elements || [];
  const matches = elements.filter((e) => matchLabel(e.label, label));
  if (!matches.length) {
    const available = elements.map((e) => e.label).filter(Boolean).slice(0, 15).join("; ");
    throw new Error(`No element matches label "${label}". Available labels: ${available || "(none)"}`);
  }
  // Prefer smallest matching element (most specific)
  matches.sort((a, b) => a.width * a.height - b.width * b.height);
  return { target, el: matches[0] };
}

async function cmdClickLabel(payload: any): Promise<string> {
  const { target, el } = await findByLabel(payload);
  await clickAt(target, el.x, el.y);
  return `Clicked "${el.label || el.type}" at (${el.x}, ${el.y}).`;
}

async function cmdTypeLabel(payload: any): Promise<string> {
  const text = payload?.text;
  if (typeof text !== "string") throw new Error("type_label need payload {\"label\": \"...\", \"text\": \"...\"}.");
  const { target, el } = await findByLabel(payload);
  await clickAt(target, el.x, el.y);
  await new Promise((r) => setTimeout(r, 300));
  await typeText(target, text);
  return `Clicked "${el.label || el.type}" at (${el.x}, ${el.y}) and typed ${text.length} char(s).`;
}

export const controlChromeVisionTool: Tool = {
  name: "control_chrome_vision",
  description:
    "Vision-based Chrome automation using a local OmniParser AI (no DOM selectors needed). " +
    "Takes a screenshot, detects UI elements (buttons, inputs, icons) with bounding boxes + labels via a local GPU model, then clicks/types by label. " +
    "REQUIRES: (1) Chrome with --remote-debugging-port=9222 (same as control_chrome_cdp). " +
    "(2) OmniParser AI service: started AUTOMATICALLY by this tool when needed (local GPU, 127.0.0.1:9333). " +
    "FIRST TIME (applies in ALL agent modes - CLI, chat, bridge): model weights (~1.1GB) need a one-time download. " +
    "If this tool returns OMNIPARSER_SETUP_NEEDED, use the ask_question tool to ask the user " +
    "'OmniParser AI needs a one-time ~1.1GB model download to enable vision-based Chrome automation. Proceed with setup?'. " +
    "If the user approves, run this tool with command='setup' and wait for it to finish, then retry the original command. " +
    "Commands: parse_screenshot (list detected elements with [id] (x,y) type \"label\"), click_label (payload {\"label\": \"Post\"}), type_label (payload {\"label\": \"Title\", \"text\": \"...\"}), setup (one-time model download - only after user approves via ask_question). " +
    "Labels are fuzzy-matched (all query words must appear in the element label).",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["parse_screenshot", "click_label", "type_label", "setup"],
        description: "Vision command to execute.",
      },
      payload: {
        type: "string",
        description:
          "JSON string. parse_screenshot: {\"targetId\": \"...\"} (optional). " +
          "click_label: {\"label\": \"Post\", \"targetId\": \"...\" (optional)}. " +
          "type_label: {\"label\": \"Title\", \"text\": \"hello\", \"targetId\": \"...\" (optional)}. " +
          "setup: no payload needed (one-time model download, needs user approval first).",
      },
    },
    required: ["command"],
  },
  execute: async (args: any) => {
    const command = args?.command;
    let payload: any = {};
    if (args?.payload) {
      try {
        payload = JSON.parse(args.payload);
      } catch {
        throw new Error("'payload' must be a valid JSON string.");
      }
    }
    switch (command) {
      case "parse_screenshot":
        return cmdParseScreenshot(payload);
      case "click_label":
        return cmdClickLabel(payload);
      case "type_label":
        return cmdTypeLabel(payload);
      case "setup":
        return cmdSetup();
      default:
        throw new Error(`Unknown vision command '${command}'. Use parse_screenshot, click_label, type_label, or setup.`);
    }
  },
};
