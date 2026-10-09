/**
 * Shared helpers for Chrome tools: browser-control call wrapper,
 * PowerShell -EncodedCommand runner, and common user-facing messages.
 * Pure deduplication — no behavior change.
 */
import { exec, spawn } from "child_process";
import { promisify } from "util";
import path from "path";
import os from "os";
import fs from "fs";
import net from "net";
import { browserControlHandler } from "./browserMacroTools.js";

const execAsync = promisify(exec);

export function checkPortListening(host: string, port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (val: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(val);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

let cdpStartInFlight: Promise<boolean> | null = null;

/**
 * Ensure Chrome is running with remote debugging port enabled.
 * If port is not responding, auto-launches Chrome in isolated debug profile
 * (~/.superagent-r/chrome-debug-profile) with remote debugging active.
 */
export async function ensureCdpRunning(host = "127.0.0.1", port = 9222): Promise<boolean> {
  if (
    process.env.NODE_ENV === "test" ||
    process.env.VITEST === "true" ||
    process.env.SUPERAGENT_CDP_AUTO_LAUNCH === "0" ||
    port !== 9222
  ) {
    return false;
  }

  if (await checkPortListening(host, port, 300)) {
    return true;
  }

  if (cdpStartInFlight) {
    return await cdpStartInFlight;
  }

  cdpStartInFlight = (async () => {
    const platform = os.platform();
    const userDataDir = path.join(os.homedir(), ".superagent-r", "chrome-debug-profile");
    try {
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch {}

    const chromeFlags = [
      `--remote-debugging-port=${port}`,
      `--remote-allow-origins=*`,
      `--user-data-dir=${userDataDir}`,
      `--no-first-run`,
      `--no-default-browser-check`,
    ];

    let chromeExe: string | null = null;
    if (platform === "win32") {
      const candidates = [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
      ];
      for (const c of candidates) {
        if (c && fs.existsSync(c)) {
          chromeExe = c;
          break;
        }
      }
    } else if (platform === "darwin") {
      const macPath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      if (fs.existsSync(macPath)) chromeExe = macPath;
    }

    if (!chromeExe) {
      chromeExe = platform === "win32" ? "chrome.exe" : "google-chrome";
    }

    try {
      const child = spawn(chromeExe, chromeFlags, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.unref();

      const deadline = Date.now() + 4500;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (await checkPortListening(host, port, 200)) {
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  })();

  try {
    return await cdpStartInFlight;
  } finally {
    cdpStartInFlight = null;
  }
}

/** Exact user-facing message when the extension bridge is absent (standard variant). */
export const NO_BROWSER_CONNECTION_MSG =
  "No active browser connection. The Superagent Chrome Extension must be installed and connected on the target Chrome browser. Ensure `superagent --server` is running and the extension is active.";

/** Exact user-facing message when the extension bridge is absent (control variant). */
export const NO_BROWSER_CONTROL_CONNECTION_MSG =
  "No active browser control connection. The Superagent Chrome Extension must be installed and connected on the target Chrome browser. Ensure `superagent --server` is running and the extension is active.";

export interface CallBrowserOpts {
  /** Override for the absent-bridge message. Defaults to NO_BROWSER_CONNECTION_MSG. */
  noConnMsg?: string;
  /** Returned when the handler resolves to a falsy value. */
  emptyFallback?: string;
  /** Max ms to wait for the browser handler. Defaults to 20000. */
  timeoutMs?: number;
}

/**
 * Race a promise against a timeout. The timeout error is actionable: it tells
 * the caller the extension bridge didn't answer in time instead of hanging forever.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, action: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `Timed out after ${ms}ms waiting for the browser extension to respond to '${action}'. ` +
        `The Superagent Chrome Extension must be installed and connected on the target Chrome browser. Ensure it is connected and responsive.`
      ));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Guard + invoke + error-format wrapper for browserControlHandler calls.
 * Replaces the repeated if(!handler)/try/catch blocks across chrome tools.
 * The handler call is raced against a timeout so a dead bridge can't hang the caller.
 */
export async function callBrowser(
  action: string,
  failPrefix: string,
  args: [any?, any?, any?] = [],
  opts: CallBrowserOpts = {}
): Promise<string> {
  if (!browserControlHandler) return opts.noConnMsg ?? NO_BROWSER_CONNECTION_MSG;
  try {
    const res = await withTimeout(browserControlHandler(action, ...args), opts.timeoutMs ?? 20000, action);
    return res || opts.emptyFallback || res;
  } catch (err: any) {
    return `${failPrefix}: ${err?.message || String(err)}`;
  }
}

export interface RunPsOpts {
  maxBuffer?: number;
  timeout?: number;
  nonInteractive?: boolean;
}

/**
 * Run a PowerShell script via -EncodedCommand (UTF-16LE base64).
 * -EncodedCommand avoids every quoting pitfall of -Command.
 */
export async function runPsEncoded(psScript: string, opts: RunPsOpts = {}): Promise<string> {
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const ni = opts.nonInteractive ? " -NonInteractive" : "";
  const { stdout } = await execAsync(`powershell.exe -NoProfile${ni} -EncodedCommand ${encoded}`, {
    maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    timeout: opts.timeout ?? 30000,
  });
  return stdout;
}
