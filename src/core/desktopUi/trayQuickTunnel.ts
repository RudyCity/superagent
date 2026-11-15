/**
 * Dedicated Cloudflare Quick Tunnel for the password-protected Tray manager.
 * Does not share MCP/Muse tunnel process state, PID, files, URLs or ports.
 * Only the child created here may be stopped; foreign cloudflared stays untouched.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { basename } from "node:path";
import { statSync } from "node:fs";
import { findCloudflaredBinary } from "../remoteAgent/cloudflareTunnel.js";

export interface TrayQuickTunnel {
  publicUrl: string;
  pid: number;
  stop(): Promise<void>;
}
export interface TrayQuickTunnelOptions {
  originPort: number;
  signal?: AbortSignal;
  onExit?: () => void;
  timeoutMs?: number;
  /** Injectable only for deterministic process-ownership tests. */
  findBinary?: () => Promise<string | null>;
  spawnChild?: typeof spawn;
}

export function parseTrayQuickTunnelUrl(output: string): string | null {
  let offset=0;
  while(offset<output.length){
    const start=output.toLowerCase().indexOf("https://",offset);
    if(start<0)return null;
    const match=/^[a-z0-9]+(?:-[a-z0-9]+)*[.]trycloudflare[.]com/i.exec(output.slice(start+8));
    if(match){
      const nextChar=output[start+8+match[0].length];
      if(!nextChar || [32,9,10,13,124,41,34,39,60,62,27].includes(nextChar.charCodeAt(0)))
        return "https://" + match[0].toLowerCase();
    }
    offset=start+8;
  }
  return null;
}

export async function startTrayQuickTunnel(options: TrayQuickTunnelOptions): Promise<TrayQuickTunnel> {
  const port = options.originPort;
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
      [7888, 9227, 6759, 6789, 9877, 17341, 19320, 19321].includes(port))
    throw Error("TRAY_QUICK_PROTECTED_PORT");
  if (options.signal?.aborted) throw Error("TRAY_QUICK_CANCELLED");
  const binary = await (options.findBinary ?? findCloudflaredBinary)();
  if (!binary || !/^cloudflared(?:\.exe)?$/i.test(basename(binary)))
    throw Error("TRAY_QUICK_CLOUDFLARED_REQUIRED");
  if (!options.spawnChild) {
    // Homebrew and distro package managers legitimately symlink cloudflared.
    // stat follows the link but still requires a real regular executable file.
    const metadata = statSync(binary);
    if (!metadata.isFile())
      throw Error("TRAY_QUICK_UNTRUSTED_BINARY");
  }
  if (options.signal?.aborted) throw Error("TRAY_QUICK_CANCELLED");

  const target = `http://127.0.0.1:${port}`;
  const args = ["tunnel", "--url", target, "--no-autoupdate"];
  const child: ChildProcess = (options.spawnChild ?? spawn)(binary, args, {
    shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  let disposed = false;
  let ready = false;
  let buffer = "";
  let exitResolve: (() => void) | undefined;
  const exited = new Promise<void>(resolve => { exitResolve = resolve; });
  let stopPromise: Promise<void> | null = null;
  async function stop(): Promise<void> {
    if (stopPromise) return stopPromise;
    disposed = true;
    stopPromise = (async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill("SIGTERM"); } catch {}
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1500)),
      ]);
      if (!graceful && child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch {}
        await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 1000))]);
      }
    })();
    return stopPromise;
  }

  return new Promise<TrayQuickTunnel>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => fail("TRAY_QUICK_URL_TIMEOUT"), Math.max(250, Math.min(60_000, options.timeoutMs ?? 35_000)));
    const abort = () => fail("TRAY_QUICK_CANCELLED");
    options.signal?.addEventListener("abort", abort, { once: true });
    function cleanup() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
    function fail(reason: string) {
      if (settled) return;
      settled = true;
      cleanup();
      void stop();
      reject(Error(reason));
    }
    child.once("error", () => { if (!ready) fail("TRAY_QUICK_SPAWN_FAILED"); else options.onExit?.(); });
    child.once("exit", () => {
      exitResolve?.();
      if (!ready) fail("TRAY_QUICK_EARLY_EXIT");
      else if (!disposed) options.onExit?.();
    });
    function onText(chunk: Buffer | string) {
      if (settled) return;
      buffer = (buffer + String(chunk)).slice(-4096);
      const publicUrl = parseTrayQuickTunnelUrl(buffer);
      if (!publicUrl) return;
      if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) {
        fail("TRAY_QUICK_PROCESS_ID_UNVERIFIED");
        return;
      }
      ready = true;
      settled = true;
      cleanup();
      resolve({ publicUrl, pid: child.pid!, stop });
    }
    child.stdout?.on("data", onText);
    child.stderr?.on("data", onText);
    if (options.signal?.aborted) fail("TRAY_QUICK_CANCELLED");
  });
}
