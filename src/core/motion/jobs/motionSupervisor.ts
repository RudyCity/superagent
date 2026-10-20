import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { motionJobDir, listMotionJobs, getMotionJob, type MotionJob } from "./motionJobs.js";
import { motionConcurrentSlots } from "./renderScheduler.js";
import { dispatchOrphanedMotionQueue, inspectMotionQueueRecovery, type MotionDispatchOutcome } from "./queueRecovery.js";

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });

export interface MotionSupervisorStatus {
  mode: "opt-in-fifo";
  queuedSupervised: number;
  occupied: number;
  maxConcurrentRenders: number;
  oldestWaitingJobId?: string;
  blockedReason?: string;
  leader: "free" | "claimed_unverified" | "unsafe_or_unreadable";
  automaticRecoveryOfRenderingJobs: false;
}
export interface MotionSupervisorCycle {
  status: MotionSupervisorStatus;
  attempts: MotionDispatchOutcome[];
}

/** A lease is exclusive and fail-closed: never use PID existence to steal a claim. */
async function withSupervisorLease<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const dir = await motionJobDir(workspace, "jobs");
  const file = path.join(dir, ".supervisor.lock");
  const token = crypto.randomBytes(16).toString("hex");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(file, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("Motion supervisor already claimed; inspect process identity and lock before retrying");
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ token, pid: process.pid, startedAt: new Date().toISOString() }) + "\n");
    await handle.sync();
    return await fn();
  } finally {
    await handle.close();
    // Never remove another supervisor's claim if ownership changed during operation.
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) {
      throw new Error("Unsafe Motion supervisor claim: preserved for manual inspection");
    }
    const current: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!current || typeof current !== "object" || (current as { token?: string }).token !== token) {
      throw new Error("Motion supervisor ownership changed: lock preserved");
    }
    await fs.rm(file);
  }
}
async function existing(dir: string, name: string): Promise<boolean> {
  try { await fs.lstat(path.join(dir, name)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}
async function leaseStatus(dir: string): Promise<MotionSupervisorStatus["leader"]> {
  const file = path.join(dir, ".supervisor.lock");
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) return "unsafe_or_unreadable";
    const data: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return data && typeof data === "object" &&
      typeof (data as { token?: unknown }).token === "string" &&
      typeof (data as { pid?: unknown }).pid === "number"
      ? "claimed_unverified" : "unsafe_or_unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unsafe_or_unreadable";
  }
}
function sortFIFO(a: MotionJob, b: MotionJob) {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}
/** Read-only state suitable for CLI/HTTP/T-Line. No automatic lock reclamation. */
export async function inspectMotionSupervisor(workspace: string): Promise<MotionSupervisorStatus> {
  const dir = await motionJobDir(workspace, "jobs");
  const [jobs, leader] = await Promise.all([listMotionJobs(workspace), leaseStatus(dir)]);
  const queued = jobs.filter(j => j.dispatchMode === "supervised" && j.status === "queued").sort(sortFIFO);
  const occupying = new Set<string>(jobs.filter(j =>
    j.status === "preparing" || j.status === "rendering" || j.status === "validating").map(j => j.id));
  let blockedReason: string | undefined;
  for (const job of jobs.filter(j => j.status === "queued")) {
    if (await existing(dir, job.id + ".waiting.lock") || await existing(dir, job.id + ".runner.lock") ||
      await existing(dir, job.id + ".dispatch.lock")) occupying.add(job.id);
  }
  // Look at all 4 possible slots (not just the configured count). Unknown
  // claims block dispatch, even when a server reduced its renderer budget.
  for (let slot = 0; slot < 4; slot++) {
    const file = path.join(dir, ".render-slot-" + slot + ".lock");
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) {
        blockedReason = "Unverifiable render-slot ownership"; break;
      }
      const raw: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (!raw || typeof raw !== "object" ||
        !/^motionjob-[a-f0-9]{24}$/.test(String((raw as { jobId?: string }).jobId))) {
        blockedReason = "Unverifiable render-slot ownership"; break;
      }
      occupying.add((raw as { jobId: string }).jobId);
      if (slot >= motionConcurrentSlots()) blockedReason = "Render-slot claim outside configured renderer pool";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { blockedReason = "Render-slot unreadable"; break; }
    }
  }
  return {
    mode: "opt-in-fifo",
    queuedSupervised: queued.length,
    occupied: occupying.size,
    maxConcurrentRenders: motionConcurrentSlots(),
    ...(queued[0] ? { oldestWaitingJobId: queued[0].id } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    leader,
    automaticRecoveryOfRenderingJobs: false,
  };
}
async function tickOwned(workspace: string): Promise<MotionSupervisorCycle> {
  const status = await inspectMotionSupervisor(workspace);
  const attempts: MotionDispatchOutcome[] = [];
  const available = Math.max(0, status.maxConcurrentRenders - status.occupied);
  if (status.blockedReason || !available || !status.queuedSupervised) return { status, attempts };
  const dir = await motionJobDir(workspace, "jobs");
  const jobs = (await listMotionJobs(workspace))
    .filter(j => j.dispatchMode === "supervised" && j.status === "queued").sort(sortFIFO);
  const report = await inspectMotionQueueRecovery(workspace);
  for (const job of jobs) {
    if (attempts.length >= available) break;
    const item = report.items.find(entry => entry.jobId === job.id);
    if (!item) break;
    if (item.state === "blocked") {
      // A previously dispatched worker may still be queued while waiting for
      // its renderer slot; the occupancy count already reserves its budget.
      const dispatched = await existing(dir, job.id + ".runner.lock") ||
        await existing(dir, job.id + ".waiting.lock") || await existing(dir, job.id + ".dispatch.lock");
      if (dispatched) continue;
      attempts.push({ jobId: job.id, status: "skipped", reason: item.reason });
      break; // strict FIFO: do not overtake an unverified older job
    }
    const result = await dispatchOrphanedMotionQueue(workspace, {
      apply: true, limit: 1, minAgeSeconds: 10, supervisedOnly: true, jobIds: [job.id],
    });
    attempts.push(...result.results);
    if (result.results.some(r => r.status !== "acknowledged")) break;
  }
  return { status, attempts };
}
/** One explicit FIFO dispatch cycle. Never acts on old unsupervised jobs. */
export function runMotionSupervisorOnce(workspace: string): Promise<MotionSupervisorCycle> {
  return withSupervisorLease(workspace, () => tickOwned(workspace));
}
/** Explicit foreground process; lock is retained for the lifetime of watch. */
export function runMotionSupervisorWatch(
  workspace: string, options: { intervalMs?: number; signal?: AbortSignal; onCycle?: (cycle: MotionSupervisorCycle) => void } = {},
): Promise<{ cycles: number }> {
  const intervalMs = options.intervalMs ?? 2000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 500 || intervalMs > 30000) {
    throw new Error("Motion supervisor intervalMs must be an integer from 500 to 30000");
  }
  return withSupervisorLease(workspace, async () => {
    let cycles = 0;
    while (!options.signal?.aborted) {
      const cycle = await tickOwned(workspace);
      cycles++;
      options.onCycle?.(cycle);
      await wait(intervalMs, options.signal);
    }
    return { cycles };
  });
}
