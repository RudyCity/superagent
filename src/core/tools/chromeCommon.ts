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
  "No active browser connection. Ensure `superagent --server` is running and Chrome Extension is active.";

/** Exact user-facing message when the extension bridge is absent (control variant). */
export const NO_BROWSER_CONTROL_CONNECTION_MSG =
  "No active browser control connection. Ensure `superagent --server` is running and Superagent Chrome Extension is active.";

export interface CallBrowserOpts {
  /** Override for the absent-bridge message. Defaults to NO_BROWSER_CONNECTION_MSG. */
  noConnMsg?: string;
  /** Returned when the handler resolves to a falsy value. */
  emptyFallback?: string;
}

/**
 * Guard + invoke + error-format wrapper for browserControlHandler calls.
 * Replaces the repeated if(!handler)/try/catch blocks across chrome tools.
 */
export async function callBrowser(
  action: string,
  failPrefix: string,
  args: [any?, any?, any?] = [],
  opts: CallBrowserOpts = {}
): Promise<string> {
  if (!browserControlHandler) return opts.noConnMsg ?? NO_BROWSER_CONNECTION_MSG;
  try {
    const res = await browserControlHandler(action, ...args);
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
