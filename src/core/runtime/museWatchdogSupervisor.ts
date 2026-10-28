/**
 * Phase 4o independent watchdog heartbeat and bounded parent supervision.
 * The supervisor only restarts its OWN watchdog child. It never starts/kills
 * channel-host, Muse transport, Telegram poller, MCP tunnels or tools.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { getProcessSupervisor } from "../process/processSupervisor.js";
import type { ChildProcess } from "node:child_process";
export type MuseWatchdogHeartbeat = {
  version: 1; port: number; pid: number; observedAt: number; online: boolean;
};
export function museWatchdogHeartbeatFile(port: number, root = path.join(os.homedir(), ".superagent-r")) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid watchdog port");
  return path.join(root, "muse-watchdog-" + port + ".json");
}
export function writeMuseWatchdogHeartbeat(port: number, online: boolean,
  root = path.join(os.homedir(), ".superagent-r"), now = Date.now()): void {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Invalid watchdog time");
  const file = museWatchdogHeartbeatFile(port, root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(root);
  if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Unsafe watchdog root");
  if (fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe watchdog heartbeat target");
  }
  const tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({
        version: 1, port, pid: process.pid, observedAt: now, online,
      } satisfies MuseWatchdogHeartbeat));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
/** Read-only, sanitized health signal. Old PID/heartbeat is NOT proof of ownership. */
export function readMuseWatchdogHeartbeat(port: number,
  root = path.join(os.homedir(), ".superagent-r"), now = Date.now()): MuseWatchdogHeartbeat | null {
  const file = museWatchdogHeartbeatFile(port, root);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Unreadable watchdog heartbeat");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512) {
    throw new Error("Invalid watchdog heartbeat");
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as MuseWatchdogHeartbeat;
    if (data.version !== 1 || data.port !== port || !Number.isSafeInteger(data.pid) ||
        data.pid <= 0 || !Number.isSafeInteger(data.observedAt) ||
        data.observedAt <= 0 || data.observedAt > now ||
        typeof data.online !== "boolean") throw new Error("Invalid heartbeat");
    return data;
  } catch { throw new Error("Invalid watchdog heartbeat"); }
}
export type WatchdogExit = { code: number | null; signal: NodeJS.Signals | null };
export interface WatchdogChild {
  pid?: number;
  once(event: "exit" | "error", cb: (...args: any[]) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface WatchdogSupervisorOptions {
  launch: () => WatchdogChild;
  pause?: (ms: number) => Promise<void>;
  maxRestarts?: number;
  windowMs?: number;
  backoffMs?: number;
  clock?: () => number;
}
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/**
 * A dedicated supervisor loop. A process controlled by the caller must
 * remain alive and invoke stop() on shutdown. It does NOT clear stale claims.
 * A flapping child is stopped after a fixed budget; do not thrash restart.
 */
export class MuseWatchdogSupervisor {
  private stopping = false;
  private child: WatchdogChild | null = null;
  private started = false;
  private readonly restarts: number[] = [];
  private running: Promise<{ reason: "stopped" | "budget_exhausted"; restarts: number }> | null = null;
  constructor(private readonly opts: WatchdogSupervisorOptions) {
    if (!Number.isInteger(opts.maxRestarts ?? 5) || (opts.maxRestarts ?? 5) < 0 ||
        (opts.maxRestarts ?? 5) > 50 || !Number.isSafeInteger(opts.windowMs ?? 600_000) ||
        (opts.windowMs ?? 600_000) < 1000 || !Number.isSafeInteger(opts.backoffMs ?? 500) ||
        (opts.backoffMs ?? 500) < 1) throw new Error("Invalid watchdog supervisor policy");
  }
  async start(): Promise<{ reason: "stopped" | "budget_exhausted"; restarts: number }> {
    if (this.running) return this.running;
    this.running = this.supervise();
    return this.running;
  }
  private async supervise(): Promise<{ reason: "stopped" | "budget_exhausted"; restarts: number }> {
    if (this.started) throw new Error("Watchdog supervisor already started");
    this.started = true;
    let attempts = 0;
    while (!this.stopping) {
      let watchdogRecordId: string | undefined;
      try {
        const reg = await getProcessSupervisor().registerProcess({
          component: "muse_watchdog",
          executable: process.execPath,
          args: ["channel-host", "watchdog"],
          launchIntent: "headless",
          lifecycle: "persistent",
          cleanupPolicy: "keep_alive",
        });
        watchdogRecordId = reg.recordId;
      } catch {}

      const child = this.opts.launch();
      this.child = child;
      if (watchdogRecordId && typeof child.pid === "number") {
        void getProcessSupervisor().recordProcessSpawn(watchdogRecordId, child.pid).catch(() => {});
      }

      const ended = await new Promise<WatchdogExit>(resolve => {
        let finished = false;
        const done = (value: WatchdogExit) => {
          if (!finished) { finished = true; resolve(value); }
        };
        child.once("exit", (code: number | null, signal: NodeJS.Signals | null) =>
          done({ code, signal }));
        child.once("error", () => done({ code: null, signal: null }));
      });

      if (watchdogRecordId) {
        void getProcessSupervisor().recordProcessExit(watchdogRecordId, {
          exitCode: ended.code,
          signal: ended.signal ? String(ended.signal) : null,
          source: "museWatchdogSupervisor.exit",
        }).catch(() => {});
      }
      this.child = null;
      if (this.stopping) break;
      const now = (this.opts.clock || Date.now)();
      const windowMs = this.opts.windowMs ?? 600_000;
      for (let i = this.restarts.length - 1; i >= 0; i--) {
        if (now - this.restarts[i] > windowMs) this.restarts.splice(i, 1);
      }
      if (this.restarts.length >= (this.opts.maxRestarts ?? 5)) {
        return { reason: "budget_exhausted", restarts: attempts };
      }
      this.restarts.push(now);
      attempts++;
      const delay = Math.min(30_000, (this.opts.backoffMs ?? 500) *
        2 ** Math.min(this.restarts.length - 1, 6));
      await (this.opts.pause || sleep)(delay);
    }
    return { reason: "stopped", restarts: attempts };
  }
  stop() { this.stopping = true; this.child?.kill("SIGTERM"); }
}
/** Called exclusively from the standalone watchdog-supervise CLI process. */
export async function runMuseWatchdogSupervisorCli(port: number, intervalSeconds: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(intervalSeconds) || intervalSeconds < 5 || intervalSeconds > 3600) {
    throw new Error("Invalid watchdog supervisor port or interval");
  }
  const entry = process.argv[1];
  if (!entry || !path.isAbsolute(path.resolve(entry))) throw new Error("CLI script entry unavailable");
  const supervisor = new MuseWatchdogSupervisor({
    launch: () => spawn(process.execPath, [entry, "channel-host", "watchdog",
      "--port", String(port), "--interval-seconds", String(intervalSeconds)], {
      stdio: "inherit", windowsHide: true, env: process.env,
    }) as ChildProcess,
  });
  const halt = () => supervisor.stop();
  process.once("SIGINT", halt);
  process.once("SIGTERM", halt);
  try {
    const result = await supervisor.start();
    if (result.reason === "budget_exhausted") throw new Error(
      "Watchdog supervisor restart budget exhausted; operator inspection required");
  } finally {
    process.off("SIGINT", halt);
    process.off("SIGTERM", halt);
  }
}
