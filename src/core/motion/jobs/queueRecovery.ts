import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { getMotionJob, listMotionJobs, motionJobDir, spawnPreparedMotionWorker, verifyPreparedMotionSnapshot } from "./motionJobs.js";
import { withMotionQueueAdmission } from "./renderScheduler.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const idPattern = /^motionjob-[a-f0-9]{24}$/;
export type QueuedRecoveryItem = { jobId: string; createdAt: string; state: "eligible" | "blocked"; reason?: string };
export type QueuedRecoveryReport = {
  minAgeSeconds: number;
  queued: number;
  eligible: number;
  blocked: number;
  items: QueuedRecoveryItem[];
  warning: string;
};

function ageSeconds(value: number | undefined): number {
  const seconds = value ?? 30;
  if (!Number.isSafeInteger(seconds) || seconds < 10 || seconds > 86400) {
    throw new Error("Motion queue recovery minAgeSeconds must be an integer from 10 to 86400");
  }
  return seconds;
}
function dispatchBatchLimit(value: number | undefined): number {
  const limit = value ?? 4;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 12) {
    throw new Error("Motion dispatch limit must be an integer from 1 to 12");
  }
  return limit;
}
async function filePresent(file: string): Promise<boolean> {
  try { await fs.lstat(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true; // unknown filesystem errors fail closed
  }
}
async function claimOwner(dir: string, projectId: string, expectedId: string): Promise<boolean> {
  const claim = path.join(dir, projectId + ".render.lock");
  try {
    const stat = await fs.lstat(claim);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1000) return false;
    return (await fs.readFile(claim, "utf8")).trim() === expectedId;
  } catch { return false; }
}
async function queueEligibility(workspace: string, dir: string, jobId: string, minAge: number): Promise<string | null> {
  const job = await getMotionJob(workspace, jobId);
  if (job.status !== "queued") return "not queued";
  const age = Date.now() - Date.parse(job.updatedAt);
  if (!Number.isFinite(age) || age < minAge * 1000) return "job is recent (a worker might still start)";
  if (job.ownerPid) return "owner identity is unverified";
  if (!await claimOwner(dir, job.projectId, jobId)) return "project claim is missing, unsafe or foreign";
  for (const suffix of [".runner.lock", ".waiting.lock", ".dispatch.lock", ".recovery.lock", ".cancel"]) {
    if (await filePresent(path.join(dir, jobId + suffix))) return "an execution, dispatch or cancellation claim exists";
  }
  // Inspect all slots, not only slots in current configuration (which may have shrunk).
  for (let slot = 0; slot < 4; slot++) {
    const filename = path.join(dir, ".render-slot-" + slot + ".lock");
    if (!await filePresent(filename)) continue;
    try {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) return "an unsafe slot claim exists";
      const claim: unknown = JSON.parse(await fs.readFile(filename, "utf8"));
      if (!claim || typeof claim !== "object" || (claim as {jobId?: unknown}).jobId === jobId) return "a render slot claims this job";
    } catch { return "an unverifiable slot claim exists"; }
  }
  try { await verifyPreparedMotionSnapshot(workspace, jobId); }
  catch { return "source snapshot or referenced media failed verification"; }
  return null;
}

/** Diagnostic only: never mutates queued state or relies on PID reuse. */
export async function inspectMotionQueueRecovery(
  workspace: string, options: { minAgeSeconds?: number } = {},
): Promise<QueuedRecoveryReport> {
  const minAgeSeconds = ageSeconds(options.minAgeSeconds);
  const dir = await motionJobDir(workspace, "jobs");
  const queued = (await listMotionJobs(workspace)).filter(job => job.status === "queued")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const items: QueuedRecoveryItem[] = [];
  for (const job of queued) {
    if (!idPattern.test(job.id)) continue;
    const reason = await queueEligibility(workspace, dir, job.id, minAgeSeconds).catch(() => "cannot verify queued job");
    items.push({ jobId: job.id, createdAt: job.createdAt, state: reason ? "blocked" : "eligible", ...(reason ? { reason } : {}) });
  }
  return {
    minAgeSeconds, queued: queued.length,
    eligible: items.filter(item => item.state === "eligible").length,
    blocked: items.filter(item => item.state === "blocked").length,
    items,
    warning: "Read-only inspection. Do not infer worker death from PID or age. Dispatch requires separate operator confirmation.",
  };
}

export type MotionDispatchOutcome = {
  jobId: string;
  status: "acknowledged" | "uncertain" | "skipped";
  reason?: string;
};

/**
 * Operator-approved dispatch for orphaned QUEUED records only. This is not
 * automatic crash recovery and never reclaims running jobs or their claims.
 * A dispatch claim stays on disk when spawn acknowledgement is uncertain.
 */
export async function dispatchOrphanedMotionQueue(
  workspace: string,
  options: { minAgeSeconds?: number; limit?: number; apply: boolean },
): Promise<{ results: MotionDispatchOutcome[]; preview: QueuedRecoveryReport }> {
  if (options.apply !== true) throw new Error("Motion queue dispatch requires explicit --apply confirmation");
  const minAgeSeconds = ageSeconds(options.minAgeSeconds);
  const limit = dispatchBatchLimit(options.limit);
  const preview = await inspectMotionQueueRecovery(workspace, { minAgeSeconds });
  const dir = await motionJobDir(workspace, "jobs");
  const results: MotionDispatchOutcome[] = [];
  for (const item of preview.items.filter(item => item.state === "eligible").slice(0, limit)) {
    const file = path.join(dir, item.jobId + ".dispatch.lock");
    const token = crypto.randomBytes(16).toString("hex");
    const claimed = await withMotionQueueAdmission(dir, async () => {
      const reason = await queueEligibility(workspace, dir, item.jobId, minAgeSeconds).catch(() => "verification failed");
      if (reason) return { reason };
      try {
        const handle = await fs.open(file, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ jobId: item.jobId, token, dispatcherPid: process.pid, startedAt: new Date().toISOString() }) + "\n");
          await handle.sync();
        } finally { await handle.close(); }
        return { reason: null };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { reason: "another dispatcher already claimed this job" };
        throw error;
      }
    });
    if (claimed.reason) {
      results.push({ jobId: item.jobId, status: "skipped", reason: claimed.reason });
      continue;
    }
    try {
      await spawnPreparedMotionWorker(workspace, item.jobId);
      let acknowledged = false;
      for (let attempt = 0; attempt < 45; attempt++) {
        const current = await getMotionJob(workspace, item.jobId);
        if (current.status !== "queued" ||
          await filePresent(path.join(dir, item.jobId + ".waiting.lock")) ||
          await filePresent(path.join(dir, item.jobId + ".runner.lock"))) {
          acknowledged = true; break;
        }
        await sleep(100);
      }
      if (acknowledged) {
        // Never unlink a different dispatcher's claim after external recovery.
        const current = await fs.lstat(file);
        if (!current.isFile() || current.isSymbolicLink() || current.size > 1000) {
          throw new Error("Motion dispatch claim changed file type");
        }
        const claim: unknown = JSON.parse(await fs.readFile(file, "utf8"));
        if (!claim || typeof claim !== "object" ||
          (claim as {jobId?: string}).jobId !== item.jobId ||
          (claim as {token?: string}).token !== token) {
          throw new Error("Motion dispatch claim changed ownership");
        }
        await fs.rm(file);
        results.push({ jobId: item.jobId, status: "acknowledged" });
      } else {
        results.push({ jobId: item.jobId, status: "uncertain", reason: "No worker claim observed; preserved dispatch lock for operator inspection" });
      }
    } catch (error) {
      results.push({ jobId: item.jobId, status: "uncertain",
        reason: "Worker startup was not confirmed; preserved dispatch lock: " + (error instanceof Error ? error.message : String(error)) });
    }
  }
  return { preview, results };
}
