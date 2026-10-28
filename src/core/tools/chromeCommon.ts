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
import { applyProcessIntent } from "../process/processSpawnPolicy.js";
import { getBrowserProcessManager } from "../browserRuntime/browserProcessManager.js";

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

/** Check whether port is listening on either IPv4 (127.0.0.1) or IPv6 (::1). */
export async function isCdpPortListening(port = 9222, timeoutMs = 250): Promise<string | null> {
  if (await checkPortListening("127.0.0.1", port, timeoutMs)) return "127.0.0.1";
  if (await checkPortListening("::1", port, timeoutMs)) return "::1";
  return null;
}

/**
 * Ensure Chrome is running with remote debugging port enabled.
 * If port is not responding, auto-launches Chrome in isolated debug profile
 * (~/.superagent-r/chrome-debug-profile) with remote debugging active.
 * Delegates to canonical BrowserProcessManager for ownership tracking and cross-platform mode selection.
 */
export async function ensureCdpRunning(host = "127.0.0.1", port = 9222): Promise<boolean> {
  if (
    (process.env.NODE_ENV === "test" || process.env.VITEST === "true") &&
    process.env.SUPERAGENT_ALLOW_TEST_BROWSER_LAUNCH !== "1"
  ) {
    return false;
  }

  if (process.env.SUPERAGENT_CDP_AUTO_LAUNCH === "0" || port !== 9222) {
    return false;
  }

  if (await isCdpPortListening(port)) {
    return true;
  }

  const manager = getBrowserProcessManager();
  const useFakeMediaUi = process.env.SUPERAGENT_UNATTENDED_SCREEN_CAPTURE === "1";
  return await manager.ensureBrowserRunning({
    host,
    port,
    mode: "auto",
    useFakeMediaUi,
    autoSelectDesktopCaptureSource: useFakeMediaUi ? "Entire screen" : undefined,
  });
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
  const { stdout } = await execAsync(
    `powershell.exe -NoProfile${ni} -EncodedCommand ${encoded}`,
    applyProcessIntent({
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      timeout: opts.timeout ?? 30000,
    }, "headless", { caller: "chromeCommon.runPsEncoded", executable: "powershell.exe" })
  );
  return stdout;
}
