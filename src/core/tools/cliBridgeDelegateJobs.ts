/**
 * Long-running, pollable one-shot CLI delegations for MCP callers.
 * These jobs return quickly, run concurrently, persist metadata, and log all output.
 */
import { execa } from "execa";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export type DelegateJobStatus =
  | "starting" | "running" | "cancelling" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted";

export interface DelegateJob {
  jobId: string;
  cliAlias: string;
  binary: string;
  cwd: string;
  /** Immutable canonical caller workspace; used to authorize job inspection and cancellation. */
  workspaceRoot?: string;
  pid: number | null;
  status: DelegateJobStatus;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  durationMs?: number;
  exitCode: number | null;
  timedOut: boolean;
  timeoutMs: number;
  outputTail: string;
  outputBytes: number;
  logPath: string;
  error?: string;
}
export interface StartDelegateJobOptions {
  cliAlias: string;
  binary: string;
  prompt: string;
  cwd: string;
  workspaceRoot?: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

const STORAGE_DIR = path.join("cli-bridge", "delegations");
const STORAGE_FILE = "jobs.json";
const MAX_OUTPUT_TAIL_CHARS = 24_000;
const MAX_RETAINED_JOBS = 100;
const DEFAULT_MAX_CONCURRENT_JOBS = 4;
const jobs = new Map<string, DelegateJob>();
const processes = new Map<string, any>();
const runners = new Map<string, Promise<void>>();
const logQueues = new Map<string, Promise<void>>();
const cancellationRequested = new Set<string>();
const killTimers = new Map<string, ReturnType<typeof setTimeout>>();
let initializePromise: Promise<void> | undefined;
let persistQueue: Promise<void> = Promise.resolve();

function getStorageDir(): string { return path.join(getRootConfigDir(), STORAGE_DIR); }
function getStoragePath(): string { return path.join(getStorageDir(), STORAGE_FILE); }
function activeStatus(status: DelegateJobStatus): boolean {
  return status === "starting" || status === "running" || status === "cancelling";
}
function activeJobCount(): number {
  return [...jobs.values()].filter((job) => activeStatus(job.status)).length;
}
function maxConcurrentJobs(): number {
  const configured = Number.parseInt(process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS ?? "", 10);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_CONCURRENT_JOBS;
  return Math.min(12, configured);
}
function pruneJobs(): void {
  const completed = [...jobs.values()].filter((job) => !activeStatus(job.status)).sort((a, b) => b.startedAt - a.startedAt);
  for (const job of completed.slice(MAX_RETAINED_JOBS)) jobs.delete(job.jobId);
}

async function initialize(): Promise<void> {
  if (!initializePromise) {
    initializePromise = (async () => {
      await fs.mkdir(getStorageDir(), { recursive: true });
      try {
        const parsed = JSON.parse(await fs.readFile(getStoragePath(), "utf8")) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const value of Object.values(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== "object") continue;
            const record = value as Partial<DelegateJob>;
            if (typeof record.jobId !== "string" || typeof record.logPath !== "string" || typeof record.status !== "string") continue;
            const job = record as DelegateJob;
            // A process handle cannot be safely reattached after this process restarts.
            if (activeStatus(job.status)) {
              job.status = "interrupted";
              job.updatedAt = Date.now();
              job.error = "SuperAgent restarted while this delegation was active; inspect the log to determine whether its child process continued.";
            }
            jobs.set(job.jobId, job);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          try { await fs.rename(getStoragePath(), `${getStoragePath()}.corrupt-${Date.now()}`); } catch {}
        }
      }
      pruneJobs();
      await persistJobs();
    })();
  }
  await initializePromise;
}

function persistJobs(): Promise<void> {
  persistQueue = persistQueue.catch(() => {}).then(async () => {
    const filePath = getStoragePath();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    pruneJobs();
    const snapshot: Record<string, DelegateJob> = {};
    for (const [id, job] of jobs) snapshot[id] = { ...job };
    const tempPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
    await fs.rename(tempPath, filePath).catch(async (error: NodeJS.ErrnoException) => {
      if (process.platform === "win32" && (error.code === "EEXIST" || error.code === "EPERM")) {
        await fs.rm(filePath, { force: true });
        await fs.rename(tempPath, filePath);
      } else throw error;
    });
  });
  return persistQueue;
}

function queueLog(jobId: string, logPath: string, chunk: string): void {
  if (!chunk) return;
  const previous = logQueues.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => fs.appendFile(logPath, chunk, "utf8"));
  logQueues.set(jobId, next);
  void next.catch(() => {});
}
function updateOutput(job: DelegateJob, chunk: Buffer | string): void {
  const output = chunk.toString();
  job.outputTail = `${job.outputTail}${output}`.slice(-MAX_OUTPUT_TAIL_CHARS);
  job.outputBytes += Buffer.byteLength(output, "utf8");
  job.updatedAt = Date.now();
  queueLog(job.jobId, job.logPath, output);
}
function killProcessTree(jobId: string, proc: any): void {
  if (!proc) return;
  const pid = typeof proc.pid === "number" ? proc.pid : jobs.get(jobId)?.pid;
  if (process.platform === "win32" && pid) {
    try { spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch {}
  } else if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { proc.kill?.("SIGTERM"); } catch {} }
  } else {
    try { proc.kill?.("SIGTERM"); } catch {}
  }
  const oldTimer = killTimers.get(jobId);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    if (process.platform === "win32" && pid) {
      try { spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch {}
    } else if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill?.("SIGKILL"); } catch {} }
    }
  }, 5_000);
  timer.unref?.();
  killTimers.set(jobId, timer);
}

async function finishJob(job: DelegateJob, proc: any, timeoutMs: number): Promise<void> {
  try {
    const result = await proc;
    if (result?.all && typeof result.all === "string") updateOutput(job, result.all);
    job.exitCode = typeof result?.exitCode === "number" ? result.exitCode : null;
    job.timedOut = result?.timedOut === true;
    if (job.timedOut) killProcessTree(job.jobId, proc);
    if (cancellationRequested.has(job.jobId)) job.status = "cancelled";
    else if (job.timedOut) job.status = "timed_out";
    else if (job.exitCode === 0) job.status = "succeeded";
    else job.status = "failed";
    if (result?.failed && job.exitCode === null && !job.timedOut && !cancellationRequested.has(job.jobId)) {
      job.error = "The CLI process failed before returning an exit code.";
    }
  } catch (error) {
    job.status = cancellationRequested.has(job.jobId) ? "cancelled" : "failed";
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    const timer = killTimers.get(job.jobId);
    if (timer) clearTimeout(timer);
    killTimers.delete(job.jobId);
    job.endedAt = Date.now();
    job.updatedAt = job.endedAt;
    job.durationMs = job.endedAt - job.startedAt;
    job.pid = null;
    processes.delete(job.jobId);
    cancellationRequested.delete(job.jobId);
    await (logQueues.get(job.jobId) ?? Promise.resolve()).catch(() => {});
    logQueues.delete(job.jobId);
    queueLog(job.jobId, job.logPath, `\n\n[CLI Bridge job finished: status=${job.status} exit=${job.exitCode ?? "?"} timedOut=${job.timedOut} duration=${job.durationMs}ms timeout=${timeoutMs}ms]\n`);
    await (logQueues.get(job.jobId) ?? Promise.resolve()).catch(() => {});
    runners.delete(job.jobId);
    await persistJobs();
    try {
      const { notifyTasksChanged } = await import("./state.js");
      notifyTasksChanged();
    } catch {}
  }
}

export async function startDelegateJob(opts: StartDelegateJobOptions): Promise<DelegateJob> {
  await initialize();
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > 7_200_000) {
    throw new Error("Background delegation timeoutMs must be between 1000 and 7200000 (2 hours).");
  }
  const cap = maxConcurrentJobs();
  const count = activeJobCount();
  if (count >= cap) throw new Error(`CLI Bridge concurrency limit reached (${count}/${cap}). Wait for a job to finish or cancel one, then retry.`);

  const startedAt = Date.now();
  const jobId = `clj_${startedAt}_${crypto.randomBytes(4).toString("hex")}`;
  const logDir = path.join(getRootConfigDir(), "logs", "cli-bridge");
  const logPath = path.join(logDir, `job-${jobId}.log`);
  const job: DelegateJob = {
    jobId, cliAlias: opts.cliAlias, binary: opts.binary, cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot ?? opts.cwd, pid: null,
    status: "starting", startedAt, updatedAt: startedAt, exitCode: null, timedOut: false, timeoutMs: opts.timeoutMs,
    outputTail: "", outputBytes: 0, logPath,
  };

  // Reserve the concurrency slot synchronously before any filesystem I/O.
  // Without this reservation, simultaneous MCP calls can both pass the cap
  // check and start more children than SUPERAGENT_CLI_BRIDGE_MAX_JOBS allows.
  jobs.set(jobId, job);
  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logPath, `[CLI Bridge job ${jobId}]\nCLI: ${opts.cliAlias}\nWorking directory: ${opts.cwd}\nTimeout: ${opts.timeoutMs}ms\n--- output ---\n`, "utf8");
    await persistJobs();
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.endedAt = Date.now();
    job.durationMs = job.endedAt - job.startedAt;
    job.updatedAt = job.endedAt;
    await persistJobs().catch(() => {});
    throw error;
  }

  let proc: any;
  try {
    proc = execa(opts.binary, opts.args, {
      cwd: opts.cwd, all: true, buffer: false, reject: false,
      env: opts.env ?? process.env, input: opts.prompt, timeout: opts.timeoutMs,
      forceKillAfterDelay: 5_000, windowsHide: true, detached: process.platform !== "win32",
    });
  } catch (error) {
    job.status = "failed";
    job.error = error instanceof Error ? error.message : String(error);
    job.endedAt = Date.now();
    job.durationMs = job.endedAt - job.startedAt;
    job.updatedAt = job.endedAt;
    await persistJobs().catch(() => {});
    throw error;
  }

  processes.set(jobId, proc);
  job.pid = typeof proc.pid === "number" ? proc.pid : null;
  job.status = "running";
  job.updatedAt = Date.now();
  proc.all?.on("data", (chunk: Buffer | string) => updateOutput(job, chunk));
  proc.stderr?.on("data", (chunk: Buffer | string) => { if (!proc.all) updateOutput(job, chunk); });
  proc.stdout?.on("data", (chunk: Buffer | string) => { if (!proc.all) updateOutput(job, chunk); });
  const runner = finishJob(job, proc, opts.timeoutMs);
  runners.set(jobId, runner);

  // Do not encourage a duplicate retry if the child has already started.
  await persistJobs().catch((error) => {
    job.error = `Job started, but metadata persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  });
  return { ...job };
}
export async function listDelegateJobs(): Promise<DelegateJob[]> {
  await initialize();
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((job) => ({ ...job, outputTail: "" }));
}
export async function getDelegateJob(jobId: string): Promise<DelegateJob | null> {
  await initialize();
  const job = jobs.get(jobId);
  return job ? { ...job } : null;
}
export async function tailDelegateJob(jobId: string, limit = 200): Promise<{ job: DelegateJob; output: string } | null> {
  await initialize();
  const job = jobs.get(jobId);
  if (!job) return null;
  const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit) || 200));
  try {
    const contents = await fs.readFile(job.logPath, "utf8");
    return { job: { ...job }, output: contents.split(/\r?\n/).slice(-safeLimit).join("\n") };
  } catch {
    return { job: { ...job }, output: job.outputTail || "(no output captured yet)" };
  }
}
export async function cancelDelegateJob(jobId: string): Promise<{ ok: boolean; message: string; job?: DelegateJob }> {
  await initialize();
  const job = jobs.get(jobId);
  if (!job) return { ok: false, message: `No CLI Bridge delegation job found with id ${jobId}.` };
  if (!activeStatus(job.status)) return { ok: false, message: `Job ${jobId} is already ${job.status}.`, job: { ...job } };
  const proc = processes.get(jobId);
  if (!proc) return { ok: false, message: `Job ${jobId} has no process handle; inspect its log.`, job: { ...job } };
  cancellationRequested.add(jobId);
  job.status = "cancelling";
  job.updatedAt = Date.now();
  killProcessTree(jobId, proc);
  await persistJobs();
  return { ok: true, message: `Cancellation requested for ${jobId}; poll delegate.get to confirm it has exited.`, job: { ...job } };
}

/** Test helper; terminates active children and clears its configured store. */
export async function __resetDelegateJobsForTests(): Promise<void> {
  for (const [jobId, proc] of [...processes.entries()]) {
    cancellationRequested.add(jobId);
    killProcessTree(jobId, proc);
  }
  await Promise.allSettled([...runners.values()]);
  for (const timer of killTimers.values()) clearTimeout(timer);
  jobs.clear(); processes.clear(); runners.clear(); logQueues.clear(); cancellationRequested.clear(); killTimers.clear();
  initializePromise = undefined;
  persistQueue = Promise.resolve();
  try { await fs.rm(getStoragePath(), { force: true }); } catch {}
}
