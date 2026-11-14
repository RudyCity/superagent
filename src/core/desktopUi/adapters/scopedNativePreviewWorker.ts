/**
 * Private fixed-binary native worker protocol, used by macOS ScreenCaptureKit.
 * One process per explicitly consented local preview; no remote input,
 * arbitrary command execution, desktop fallback, or screenshot logging.
 */
import { spawn } from "node:child_process";
import { DesktopUiError } from "../errors.js";
import type { DesktopDiscoveredWindow, DesktopWindowCaptureSource, NativeCapture } from "../types.js";

const MAX_LINE_BUFFER = 11_200_000;
const FAILURE = new DesktopUiError("SCREENSHOT_UNAVAILABLE", "Verified native window preview stopped.");

export async function openFixedWindowPreviewWorker(
  executable: string,
  target: DesktopDiscoveredWindow,
  backend: string,
  fixedArgs: readonly string[] = [],
): Promise<DesktopWindowCaptureSource> {
  const child = spawn(executable, [...fixedArgs], {
    shell: false, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SUPERAGENT_DESKTOP_UI_PREVIEW_TARGET: JSON.stringify({
        pid: target.pid, nativeId: target.nativeId, title: target.title,
        application: target.application, bounds: target.bounds,
      }),
    },
  });
  // Drain native stderr, never log it: it may include sensitive window data.
  child.stderr?.resume();
  let alive = true;
  let lineBuffer = "";
  let waiter: {
    resolve: (line: string) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  const queued: string[] = [];
  let sessionExpiry: ReturnType<typeof setTimeout> | null = null;
  let busy = false;

  const close = () => {
    if (!alive) return;
    alive = false;
    if (sessionExpiry) clearTimeout(sessionExpiry);
    child.kill();
    child.stdin?.destroy();
    child.stdout?.destroy();
    lineBuffer = "";
    queued.length = 0;
    if (waiter) {
      const pending = waiter;
      waiter = null;
      clearTimeout(pending.timer);
      pending.reject(FAILURE);
    }
  };
  child.on("error", close);
  child.on("exit", close);
  child.stdout.on("data", (chunk: Buffer) => {
    if (!alive) return;
    lineBuffer += chunk.toString("utf8");
    if (lineBuffer.length > MAX_LINE_BUFFER) { close(); return; }
    for (;;) {
      const end = lineBuffer.indexOf("\n");
      if (end < 0) break;
      const next = lineBuffer.slice(0, end).trim();
      lineBuffer = lineBuffer.slice(end + 1);
      if (waiter) {
        const pending = waiter;
        waiter = null;
        clearTimeout(pending.timer);
        pending.resolve(next);
      } else if (queued.length < 2) {
        queued.push(next);
      } else {
        close();
        return;
      }
    }
  });
  const nextLine = (): Promise<string> => {
    if (!alive) return Promise.reject(FAILURE);
    if (queued.length) return Promise.resolve(queued.shift()!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(close, 15_000);
      timer.unref();
      waiter = { resolve, reject, timer };
    });
  };
  let ready: any;
  try {
    ready = JSON.parse(await nextLine());
    if (ready?.type !== "ready") throw FAILURE;
  } catch {
    close();
    throw FAILURE;
  }
  sessionExpiry = setTimeout(close, 5 * 60_000);
  sessionExpiry.unref();

  return {
    backend,
    verifiedInsideCapture: true,
    async capture(): Promise<NativeCapture> {
      if (!alive || busy) throw FAILURE;
      busy = true;
      try {
        child.stdin.write("capture\n");
        const result = JSON.parse(await nextLine());
        const encoded = result?.png;
        if (result?.type !== "frame" || typeof encoded !== "string" ||
            encoded.length < 32 || encoded.length > MAX_LINE_BUFFER ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw FAILURE;
        const image = Buffer.from(encoded, "base64");
        if (image.length < 24 || image.length > 8 * 1024 * 1024) throw FAILURE;
        const actual = result.window;
        if (!actual || actual.pid !== target.pid ||
            actual.nativeId !== target.nativeId || actual.title !== target.title ||
            !["x","y","width","height"].every(key =>
              actual.bounds?.[key] === target.bounds[key as keyof typeof target.bounds])) {
          throw FAILURE;
        }
        return { image, targetWindow: actual, capturedAt: new Date().toISOString() };
      } catch {
        close();
        throw FAILURE;
      } finally {
        busy = false;
      }
    },
    close,
  };
}
