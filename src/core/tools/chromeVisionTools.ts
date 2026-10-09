/**
 * Vision-based Chrome automation via local UI-DETR-1.
 *
 * Workflow:
 *  1. `parse_screenshot` — capture tab screenshot via CDP, send to local
 *     UI-DETR-1 vision service (http://127.0.0.1:8095/detect), get back UI
 *     elements with bounding boxes + center coordinates + labels (vision-based).
 *  2. `click_label` — match an element by label or visible text, click its center
 *     via CDP Input.dispatchMouseEvent.
 *  3. `type_label` — click an element by label/text, then type text via
 *     CDP Input.insertText.
 *
 * REQUIRES:
 *  - Chrome running with --remote-debugging-port=9222 (same as control_chrome_cdp).
 *  - UI-DETR-1 vision service: auto-started on demand on port 8095
 *    (spawns `python scripts/vision_server.py 8095` as a background process).
 */
import { Tool } from "./types.js";
import { get as httpGet, request as httpRequest } from "http";
import { spawn } from "child_process";
import { existsSync } from "fs";
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
function visionHost(): string {
  return process.env.SUPERAGENT_VISION_HOST || "127.0.0.1";
}
function visionPort(): number {
  return Number(process.env.SUPERAGENT_VISION_PORT) || 8095;
}

export const CDP_PORT_CLOSED_MSG =
  "Chrome is not running with --remote-debugging-port=9222. " +
  "Close ALL Chrome windows and reopen Chrome from the taskbar shortcut " +
  "(or run scripts/chrome-debug.bat), then retry. This tool needs no extension.";

export const VISION_NOT_RUNNING_MSG =
  "UI-DETR-1 Vision service could not be started automatically. " +
  "Start it manually with: python scripts/vision_server.py 8095 " +
  "(from the superagent repo root).";

export const UI_DETR_SETUP_NEEDED_MSG =
  "UI_DETR_SETUP_NEEDED: UI-DETR-1 model weights (~535MB) are not yet ready. " +
  "Run this tool with command='setup' to download the weights.";

/**
 * Find a usable Python interpreter. Tries `python`, `py`, `python3` in order.
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
 * Locate scripts/vision_server.py starting from this directory and walking up.
 */
function findVisionServerScript(): string | null {
  let here: string;
  try {
    // @ts-ignore - ESM context
    here = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url));
  } catch {
    here = process.cwd();
  }
  let dir = here;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "scripts", "vision_server.py");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const cwdCandidate = join(process.cwd(), "scripts", "vision_server.py");
  if (existsSync(cwdCandidate)) return cwdCandidate;
  return null;
}

/** Quick check: is the UI-DETR-1 service responding on /health? */
async function visionHealth(): Promise<boolean> {
  try {
    const res: any = await httpGetJson(visionHost(), visionPort(), "/health");
    return res && (res.status === "healthy" || typeof res.status === "string");
  } catch {
    return false;
  }
}

let visionStartInFlight: Promise<void> | null = null;
async function ensureVisionRunning(): Promise<void> {
  if (await visionHealth()) return;

  if (visionStartInFlight) {
    await visionStartInFlight;
    if (await visionHealth()) return;
    throw new Error(VISION_NOT_RUNNING_MSG);
  }

  visionStartInFlight = (async () => {
    const script = findVisionServerScript();
    if (!script) {
      throw new Error("Vision server script not found (scripts/vision_server.py).");
    }
    const python = await findPython();
    if (!python) {
      throw new Error("No Python interpreter found (tried python, py, python3). Install Python 3.10+.");
    }

    const child = spawn(python, [script, String(visionPort())], {
      detached: true,
      stdio: "ignore",
      cwd: dirname(dirname(script)),
      windowsHide: true,
    });
    child.unref();

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await visionHealth()) return;
    }
    throw new Error("UI-DETR-1 Vision service started but did not become ready within 60s.");
  })();

  try {
    await visionStartInFlight;
  } finally {
    visionStartInFlight = null;
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
  label: string;
  score: number;
  box: [number, number, number, number];
  center: [number, number];
  text?: string;
  domSelector?: string;
}

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
        reject(new Error(port === cdpPort() ? CDP_PORT_CLOSED_MSG : VISION_NOT_RUNNING_MSG));
      } else {
        reject(err);
      }
    });
  });
}

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
            reject(new Error(`Vision service returned HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (e: any) {
            reject(new Error(`Invalid JSON from Vision service: ${e.message}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timed out waiting for UI-DETR-1 Vision service."));
    });
    req.on("error", (err: any) => {
      if (err && (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")) {
        reject(new Error(VISION_NOT_RUNNING_MSG));
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

async function inspectElementAtPoint(target: CdpTarget, x: number, y: number): Promise<{ text: string; selector?: string }> {
  try {
    const expr = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return null;
      const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.placeholder || '').trim().slice(0, 50);
      let sel = el.id ? '#' + el.id : el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/)[0];
        if (cls) sel += '.' + cls;
      }
      return { text, selector: sel };
    })()`;
    const res: any = await cdpSend(target.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: expr,
      returnByValue: true,
    });
    return res.result?.value || { text: "" };
  } catch {
    return { text: "" };
  }
}

function matchLabel(candidate: string, query: string): boolean {
  const l = (candidate || "").toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => l.includes(w));
}

function formatElements(elements: VisionElement[]): string {
  if (!elements.length) return "No UI elements detected by UI-DETR-1.";
  const lines = elements.map((e) => {
    const textHint = e.text ? ` text="${e.text}"` : "";
    const selHint = e.domSelector ? ` (${e.domSelector})` : "";
    const [xmin, ymin, xmax, ymax] = e.box;
    const w = xmax - xmin;
    const h = ymax - ymin;
    return `[${e.id}] center:(${e.center[0]},${e.center[1]}) ${e.label}${textHint}${selHint} [${w}x${h}] score:${Math.round(e.score * 100)}%`;
  });
  return `Detected ${elements.length} UI element(s) via UI-DETR-1:\n` + lines.join("\n");
}

async function detectElements(target: CdpTarget, threshold = 0.35): Promise<VisionElement[]> {
  await ensureVisionRunning();
  const pngBase64 = await captureScreenshot(target);
  const res: any = await httpPostJson(visionHost(), visionPort(), "/detect", {
    image_base64: pngBase64,
    threshold,
  });

  const rawElements = res?.elements || [];
  const elements: VisionElement[] = [];

  for (let i = 0; i < rawElements.length; i++) {
    const raw = rawElements[i];
    const [cx, cy] = raw.center || [0, 0];
    const dom = await inspectElementAtPoint(target, cx, cy);
    elements.push({
      id: i + 1,
      label: raw.label,
      score: raw.score,
      box: raw.box,
      center: raw.center,
      text: dom.text,
      domSelector: dom.selector,
    });
  }

  return elements;
}

async function cmdParseScreenshot(payload: any): Promise<string> {
  const target = await pickTarget(payload?.targetId);
  const threshold = typeof payload?.threshold === "number" ? payload.threshold : 0.35;
  const elements = await detectElements(target, threshold);
  return formatElements(elements);
}

async function findByLabel(payload: any): Promise<{ target: CdpTarget; el: VisionElement }> {
  const query = payload?.label;
  if (!query || typeof query !== "string") {
    throw new Error("click_label/type_label need payload {\"label\": \"...\"}.");
  }
  const target = await pickTarget(payload?.targetId);
  const elements = await detectElements(target, 0.25);

  const matches = elements.filter(
    (e) => matchLabel(e.label, query) || (e.text && matchLabel(e.text, query))
  );

  if (!matches.length) {
    const available = elements
      .map((e) => (e.text ? `${e.label}("${e.text}")` : e.label))
      .slice(0, 20)
      .join(", ");
    throw new Error(`No UI-DETR-1 element matches label/text "${query}". Available: ${available || "(none)"}`);
  }

  // Sort by highest confidence score
  matches.sort((a, b) => b.score - a.score);
  return { target, el: matches[0] };
}

async function cmdClickLabel(payload: any): Promise<string> {
  const { target, el } = await findByLabel(payload);
  const [cx, cy] = el.center;
  await clickAt(target, cx, cy);
  const textHint = el.text ? ` ("${el.text}")` : "";
  return `Clicked UI-DETR element ${el.label}${textHint} at center (${cx}, ${cy}).`;
}

async function cmdTypeLabel(payload: any): Promise<string> {
  const text = payload?.text;
  if (typeof text !== "string") {
    throw new Error("type_label need payload {\"label\": \"...\", \"text\": \"...\"}.");
  }
  const { target, el } = await findByLabel(payload);
  const [cx, cy] = el.center;
  await clickAt(target, cx, cy);
  await new Promise((r) => setTimeout(r, 200));
  await typeText(target, text);
  const labelHint = el.text ? ` ("${el.text}")` : "";
  return `Clicked UI-DETR element ${el.label}${labelHint} at center (${cx}, ${cy}) and typed ${text.length} char(s).`;
}

async function cmdSetup(): Promise<string> {
  const python = await findPython();
  if (!python) {
    throw new Error("No Python interpreter found. Install Python 3.10+ first.");
  }
  const { execFile } = await import("child_process");
  const code = `
from huggingface_hub import hf_hub_download
print("Verifying/downloading racineai/UI-DETR-1 model.pth...")
path = hf_hub_download(repo_id="racineai/UI-DETR-1", filename="model.pth")
print(f"UI-DETR-1 model cached at: {path}")
`;
  return new Promise((resolve, reject) => {
    execFile(python, ["-c", code], { timeout: 10 * 60 * 1000 }, (err: any, stdout: string, stderr: string) => {
      if (err) reject(new Error(`UI-DETR setup failed: ${err.message}\n${stderr}`));
      else resolve(`UI-DETR-1 weights verified and ready.\n${stdout.trim()}`);
    });
  });
}

async function cmdStatus(): Promise<string> {
  let cdpOk = false;
  try {
    await httpGetJson(cdpHost(), cdpPort(), "/json/version");
    cdpOk = true;
  } catch {
    cdpOk = false;
  }
  const serviceUp = await visionHealth();
  const pythonCmd = await findPython();
  const lines = [
    "UI-DETR-1 Vision Status:",
    `- Chrome CDP (port ${cdpPort()}): ${cdpOk ? "connected" : "not reachable"}`,
    `- Vision daemon (port ${visionPort()}): ${serviceUp ? "running" : "stopped (auto-starts on demand)"}`,
    `- Model: racineai/UI-DETR-1 (~535MB RF-DETR Medium)`,
    `- Python runtime: ${pythonCmd || "not found in PATH"}`,
  ];
  return lines.join("\n");
}

export const controlChromeVisionTool: Tool = {
  name: "control_chrome_vision",
  description:
    "Vision-based Chrome automation using local UI-DETR-1 AI (no manual DOM selectors needed). " +
    "Takes a screenshot, detects UI elements (button, field, link, text, heading, image) with bounding boxes + center coordinates, then clicks or types by label. " +
    "REQUIRES: Chrome with --remote-debugging-port=9222 (same as control_chrome_cdp). " +
    "UI-DETR-1 Vision service is started AUTOMATICALLY on demand on port 8095. " +
    "Commands: status (check CDP and vision daemon readiness), parse_screenshot (list detected elements), click_label (payload {\"label\": \"Submit\"}), type_label (payload {\"label\": \"Search\", \"text\": \"...\"}), setup (verify model weights).",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: ["status", "parse_screenshot", "click_label", "type_label", "setup"],
        description: "Vision command to execute.",
      },
      payload: {
        type: "string",
        description:
          "JSON string. status: none. parse_screenshot: {\"threshold\": 0.35, \"targetId\": \"...\"} (optional). " +
          "click_label: {\"label\": \"Submit\", \"targetId\": \"...\" (optional)}. " +
          "type_label: {\"label\": \"Username\", \"text\": \"myname\", \"targetId\": \"...\" (optional)}. " +
          "setup: none.",
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
      case "status":
        return cmdStatus();
      case "parse_screenshot":
        return cmdParseScreenshot(payload);
      case "click_label":
        return cmdClickLabel(payload);
      case "type_label":
        return cmdTypeLabel(payload);
      case "setup":
        return cmdSetup();
      default:
        throw new Error(`Unknown vision command '${command}'. Use status, parse_screenshot, click_label, type_label, or setup.`);
    }
  },
};
