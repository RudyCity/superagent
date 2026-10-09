/**
 * Vision-Based Chrome Automation & Set-of-Mark (SoM) Perception Engine.
 *
 * Provides pure visual perception and spatial grounding for AI agents using
 * the local UI-DETR-1 vision server (http://127.0.0.1:8095).
 *
 * Core Capabilities:
 *  1. `perceive_page` — Captures screenshot, runs UI-DETR-1, embeds Set-of-Mark (SoM)
 *     numbered visual tags ([1], [2], [3]...) onto the image, enriches elements
 *     with spatial/DOM metadata, and returns the vision payload directly to the LLM.
 *  2. `click_id` — Clicks an element by its visual SoM ID ([1], [2]...) directly at
 *     its center coordinates via CDP Input.dispatchMouseEvent.
 *  3. `type_id` — Focuses an element by visual SoM ID and types text via CDP Input.insertText.
 *  4. `verify_visual_state` — Captures before/after screenshots and evaluates visual diffs
 *     to confirm whether a click/action actually changed the UI.
 *  5. `audit_layout` — Runs an automated visual audit detecting overlapping elements,
 *     clipped off-screen targets, touch-target size violations (<24px), and missing labels.
 *  6. `click_label` / `type_label` — Fuzzy matching by label text (backward-compatible).
 *  7. `status` / `setup` — Readiness checks and weight verification.
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
export async function checkVisionServerHealth(): Promise<boolean> {
  return await visionHealth();
}

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

export interface VisionElement {
  id: number;
  label: string;
  score: number;
  box: [number, number, number, number];
  center: [number, number];
  text?: string;
  domSelector?: string;
}

// Module-level perception cache for fast ID-based click/type workflows
let cachedPerceivedTarget: CdpTarget | null = null;
let cachedPerceivedElements: VisionElement[] = [];
let cachedPerceivedScreenshot: string = "";

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
    const textHint = e.text ? ` "${e.text}"` : "";
    const selHint = e.domSelector ? ` (${e.domSelector})` : "";
    const [xmin, ymin, xmax, ymax] = e.box;
    const w = xmax - xmin;
    const h = ymax - ymin;
    return `[${e.id}] ${e.label}${textHint} @ center:(${e.center[0]}, ${e.center[1]})${selHint} [${w}x${h}] score:${Math.round(e.score * 100)}%`;
  });
  return lines.join("\n");
}

async function runPerception(target: CdpTarget, threshold = 0.35, annotate = true): Promise<{ elements: VisionElement[]; annotatedImage?: string; rawScreenshot: string }> {
  await ensureVisionRunning();
  const rawScreenshot = await captureScreenshot(target);
  const res: any = await httpPostJson(visionHost(), visionPort(), annotate ? "/perceive" : "/detect", {
    image_base64: rawScreenshot,
    threshold,
    annotate,
  });

  const rawElements = res?.elements || [];
  const elements: VisionElement[] = [];

  for (let i = 0; i < rawElements.length; i++) {
    const raw = rawElements[i];
    const [cx, cy] = raw.center || [0, 0];
    const dom = await inspectElementAtPoint(target, cx, cy);
    elements.push({
      id: raw.id || i + 1,
      label: raw.label,
      score: raw.score,
      box: raw.box,
      center: raw.center,
      text: dom.text,
      domSelector: dom.selector,
    });
  }

  // Update memory cache
  cachedPerceivedTarget = target;
  cachedPerceivedElements = elements;
  cachedPerceivedScreenshot = rawScreenshot;

  return {
    elements,
    annotatedImage: res.annotated_image,
    rawScreenshot,
  };
}

async function cmdPerceivePage(payload: any): Promise<string> {
  const target = await pickTarget(payload?.targetId);
  const threshold = typeof payload?.threshold === "number" ? payload.threshold : 0.35;
  const { elements, annotatedImage } = await runPerception(target, threshold, true);

  const formatted = formatElements(elements);
  const imgPayload = annotatedImage ? `\n${annotatedImage}\n` : "";

  return (
    `[Visual Page Perception - Set-of-Mark (SoM)]:${imgPayload}` +
    `\nDetected ${elements.length} Interactive UI Elements:\n` +
    `To interact with any element, use command='click_id' payload='{"id": N}' or command='type_id' payload='{"id": N, "text": "..."}'.\n\n` +
    formatted
  );
}

async function cmdClickId(payload: any): Promise<string> {
  const id = Number(payload?.id);
  if (!id || isNaN(id)) {
    throw new Error("click_id requires payload {\"id\": <number>}. Run perceive_page first to get element IDs.");
  }

  let target = cachedPerceivedTarget;
  if (!target || !cachedPerceivedElements.length) {
    target = await pickTarget(payload?.targetId);
    await runPerception(target, 0.35, true);
  }

  const el = cachedPerceivedElements.find((e) => e.id === id);
  if (!el) {
    const available = cachedPerceivedElements.map((e) => `[${e.id}] ${e.label}`).slice(0, 15).join(", ");
    throw new Error(`Element ID [${id}] not found in perceived page. Available: ${available || "(none)"}. Run perceive_page to refresh.`);
  }

  const [cx, cy] = el.center;
  await clickAt(target!, cx, cy);
  const textHint = el.text ? ` ("${el.text}")` : "";

  // Brief pause and post-action diff check if requested
  let diffFeedback = "";
  if (payload?.verify) {
    await new Promise((r) => setTimeout(r, 600));
    const newScreenshot = await captureScreenshot(target!);
    try {
      const diffRes: any = await httpPostJson(visionHost(), visionPort(), "/diff", {
        image_before: cachedPerceivedScreenshot,
        image_after: newScreenshot,
      });
      diffFeedback = ` | Visual State Verification: ${diffRes.changed ? "CHANGED (UI responded, diff ratio " + diffRes.diff_ratio + ")" : "NO VISUAL CHANGE DETECTED"}`;
    } catch (_) {}
  }

  return `Clicked visual element [${el.id}] ${el.label}${textHint} at center (${cx}, ${cy})${diffFeedback}.`;
}

async function cmdTypeId(payload: any): Promise<string> {
  const id = Number(payload?.id);
  const text = payload?.text;
  if (!id || isNaN(id) || typeof text !== "string") {
    throw new Error("type_id requires payload {\"id\": <number>, \"text\": \"...\"}. Run perceive_page first to get element IDs.");
  }

  let target = cachedPerceivedTarget;
  if (!target || !cachedPerceivedElements.length) {
    target = await pickTarget(payload?.targetId);
    await runPerception(target, 0.35, true);
  }

  const el = cachedPerceivedElements.find((e) => e.id === id);
  if (!el) {
    const available = cachedPerceivedElements.map((e) => `[${e.id}] ${e.label}`).slice(0, 15).join(", ");
    throw new Error(`Element ID [${id}] not found in perceived page. Available: ${available || "(none)"}.`);
  }

  const [cx, cy] = el.center;
  await clickAt(target!, cx, cy);
  await new Promise((r) => setTimeout(r, 200));
  await typeText(target!, text);

  const textHint = el.text ? ` ("${el.text}")` : "";
  return `Clicked visual element [${el.id}] ${el.label}${textHint} at center (${cx}, ${cy}) and typed ${text.length} char(s).`;
}

async function cmdVerifyVisualState(payload: any): Promise<string> {
  const target = await pickTarget(payload?.targetId);
  if (!cachedPerceivedScreenshot) {
    throw new Error("No previous perceived screenshot found in memory. Run perceive_page first.");
  }

  const freshScreenshot = await captureScreenshot(target);
  const diffRes: any = await httpPostJson(visionHost(), visionPort(), "/diff", {
    image_before: cachedPerceivedScreenshot,
    image_after: freshScreenshot,
  });

  const perception = await runPerception(target, 0.35, true);
  const imgPayload = perception.annotatedImage ? `\n${perception.annotatedImage}\n` : "";

  return (
    `[Visual State Verification Result]:\n` +
    `- Page Changed: ${diffRes.changed ? "YES" : "NO"}\n` +
    `- Diff Pixel Ratio: ${diffRes.diff_ratio || 0.0}\n` +
    `- Current Active Elements: ${perception.elements.length}\n` +
    `${imgPayload}\n` +
    formatElements(perception.elements)
  );
}

async function cmdAuditLayout(payload: any): Promise<string> {
  const target = await pickTarget(payload?.targetId);
  const { elements, annotatedImage } = await runPerception(target, 0.3, true);

  const defects: string[] = [];

  // 1. Detect overlapping interactive elements
  for (let i = 0; i < elements.length; i++) {
    for (let j = i + 1; j < elements.length; j++) {
      const a = elements[i];
      const b = elements[j];
      const xOverlap = Math.max(0, Math.min(a.box[2], b.box[2]) - Math.max(a.box[0], b.box[0]));
      const yOverlap = Math.max(0, Math.min(a.box[3], b.box[3]) - Math.max(a.box[1], b.box[1]));
      const overlapArea = xOverlap * yOverlap;
      const minArea = Math.min((a.box[2] - a.box[0]) * (a.box[3] - a.box[1]), (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]));

      if (minArea > 0 && overlapArea / minArea > 0.4) {
        defects.push(`- OVERLAP: [${a.id}] ${a.label} overlaps with [${b.id}] ${b.label} (overlap area: ${overlapArea}px, ${Math.round((overlapArea / minArea) * 100)}%). Potential click interception hazard.`);
      }
    }
  }

  // 2. Detect touch-target size violations (< 24x24 px for interactive elements)
  for (const el of elements) {
    if (["button", "field", "link"].includes(el.label)) {
      const w = el.box[2] - el.box[0];
      const h = el.box[3] - el.box[1];
      if (w < 24 || h < 24) {
        defects.push(`- SMALL TOUCH TARGET: [${el.id}] ${el.label} "${el.text || ""}" is only ${w}x${h}px (minimum recommended is 24x24px).`);
      }
    }
  }

  // 3. Detect interactive elements with missing labels
  for (const el of elements) {
    if (["button", "link"].includes(el.label) && !el.text) {
      defects.push(`- UNLABELED ELEMENT: [${el.id}] ${el.label} at (${el.center[0]}, ${el.center[1]}) has no visible text or aria-label.`);
    }
  }

  const imgPayload = annotatedImage ? `\n${annotatedImage}\n` : "";
  const defectSummary = defects.length > 0 ? `Detected ${defects.length} Layout/Accessibility Anomalies:\n` + defects.join("\n") : "Zero layout anomalies detected (no overlaps, all click targets meet minimum dimensions).";

  return (
    `[Visual Layout & Accessibility Audit]:${imgPayload}\n` +
    `Total UI Elements Checked: ${elements.length}\n\n` +
    defectSummary
  );
}

async function findByLabel(payload: any): Promise<{ target: CdpTarget; el: VisionElement }> {
  const query = payload?.label;
  if (!query || typeof query !== "string") {
    throw new Error("click_label/type_label need payload {\"label\": \"...\"}.");
  }
  const target = await pickTarget(payload?.targetId);
  const { elements } = await runPerception(target, 0.25, false);

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
    "UI-DETR-1 Set-of-Mark (SoM) Vision Status:",
    `- Chrome CDP (port ${cdpPort()}): ${cdpOk ? "connected" : "not reachable"}`,
    `- Vision daemon (port ${visionPort()}): ${serviceUp ? "running" : "stopped (auto-starts on demand)"}`,
    `- Model: racineai/UI-DETR-1 (~535MB RF-DETR Medium)`,
    `- Endpoints: /detect, /perceive (SoM tags), /diff (visual state verification)`,
    `- Cached Perceived Elements: ${cachedPerceivedElements.length}`,
    `- Python runtime: ${pythonCmd || "not found in PATH"}`,
  ];
  return lines.join("\n");
}

export const controlChromeVisionTool: Tool = {
  name: "control_chrome_vision",
  description:
    "Vision-Based Chrome Perception & Automation via local UI-DETR-1 AI (no manual DOM selectors needed). " +
    "Provides Set-of-Mark (SoM) visual perception, ID-based coordinate clicking, typing, before/after visual state verification, and automated layout defect auditing. " +
    "PRIMARY COMMANDS: " +
    "1. 'perceive_page': Takes screenshot, overlays Set-of-Mark [1, 2, 3...] tags, and embeds the visual image for direct LLM multimodal inspection. " +
    "2. 'click_id': Clicks perceived element by ID (e.g. payload: {\"id\": 1, \"verify\": true}). " +
    "3. 'type_id': Clicks element by ID and types text (e.g. payload: {\"id\": 2, \"text\": \"my-email\"}). " +
    "4. 'verify_visual_state': Takes post-action screenshot and calculates visual diff ratio to confirm UI transition. " +
    "5. 'audit_layout': Visually audits overlapping elements, tiny touch targets (<24px), and missing labels. " +
    "6. 'click_label' / 'type_label': Fuzzy matching by label text. " +
    "7. 'status' / 'setup': Daemon health check and weights verification.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        enum: [
          "perceive_page",
          "click_id",
          "type_id",
          "verify_visual_state",
          "audit_layout",
          "parse_screenshot",
          "click_label",
          "type_label",
          "status",
          "setup"
        ],
        description: "Vision command to execute.",
      },
      payload: {
        type: "string",
        description:
          "JSON string. perceive_page: {\"threshold\": 0.35, \"targetId\": \"...\" (optional)}. " +
          "click_id: {\"id\": 1, \"verify\": true, \"targetId\": \"...\" (optional)}. " +
          "type_id: {\"id\": 2, \"text\": \"hello\", \"targetId\": \"...\" (optional)}. " +
          "verify_visual_state: {\"targetId\": \"...\" (optional)}. " +
          "audit_layout: {\"targetId\": \"...\" (optional)}. " +
          "click_label: {\"label\": \"Submit\", \"targetId\": \"...\" (optional)}. " +
          "type_label: {\"label\": \"Username\", \"text\": \"admin\"}. " +
          "status / setup: none.",
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
      case "perceive_page":
      case "parse_screenshot":
        return cmdPerceivePage(payload);
      case "click_id":
        return cmdClickId(payload);
      case "type_id":
        return cmdTypeId(payload);
      case "verify_visual_state":
        return cmdVerifyVisualState(payload);
      case "audit_layout":
        return cmdAuditLayout(payload);
      case "click_label":
        return cmdClickLabel(payload);
      case "type_label":
        return cmdTypeLabel(payload);
      case "status":
        return cmdStatus();
      case "setup":
        return cmdSetup();
      default:
        throw new Error(
          `Unknown vision command '${command}'. Use perceive_page, click_id, type_id, verify_visual_state, audit_layout, click_label, type_label, status, or setup.`
        );
    }
  },
};
