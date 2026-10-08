/**
 * Shared helpers for Chrome tools: browser-control call wrapper,
 * PowerShell -EncodedCommand runner, and common user-facing messages.
 * Pure deduplication — no behavior change.
 */
import { exec } from "child_process";
import { promisify } from "util";
import { browserControlHandler } from "./browserMacroTools.js";

const execAsync = promisify(exec);

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
