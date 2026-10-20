import fs from "node:fs/promises";
import path from "node:path";
import { getMotionJob, listMotionJobs, motionJobDir } from "./motionJobs.js";
import { inspectMotionSlots } from "./renderScheduler.js";

const terminalPrunable = new Set(["failed", "cancelled", "interrupted"]);
const jobName = /^motionjob-[a-f0-9]{24}$/;
export interface MotionStorageReport {
  jobs: { total: number; queued: number; running: number; completed: number; failed: number; cancelled: number; interrupted: number };
  completedArtifactBytes: number;
  slots: Awaited<ReturnType<typeof inspectMotionSlots>>;
  maintenance: { minAgeDays: number; candidates: number; candidateIds: string[]; reclaimableBytes: number; blockedIds: string[]; notes: string[] };
}

/**
 * Inspect/prune only failed, cancelled or manually interrupted job records.
 * Completed videos are intentionally excluded because clients may be streaming.
 * No active render, running process, PID or slot is ever reclaimed automatically.
 */
export async function motionStorageMaintenance(
  workspace: string, options: { minAgeDays?: number; apply?: boolean } = {},
): Promise<MotionStorageReport & { deletedJobIds?: string[] }> {
  const days = options.minAgeDays ?? 7;
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new Error("Motion maintenance minAgeDays must be between 1 and 3650");
  }
  const jobsDir = await motionJobDir(workspace, "jobs");
  const rendersDir = await motionJobDir(workspace, "renders");
  const lockPath = path.join(jobsDir, ".maintenance.lock");
  // Configuration can shrink from four renderer slots to one; unknown/higher-number
  // claims must not disappear from cleanup's safety checks.
  const allLockNames = await fs.readdir(jobsDir);
  const unknownConfiguredSlots = allLockNames.some(name =>
    /^\.render-slot-[0-3]\.lock$/.test(name) &&
    Number(name.match(/\d+/)?.[0]) >= Number(process.env.SUPERAGENT_MOTION_MAX_RENDERERS ?? "2"));
  // Exclusive advisory maintenance boundary: simultaneous cleanup runs fail closed.
  const lock = options.apply ? await fs.open(lockPath, "wx", 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Motion maintenance already running; inspect its owner");
    throw error;
  }) : undefined;
  try {
    const [jobs, slots] = await Promise.all([listMotionJobs(workspace), inspectMotionSlots(jobsDir)]);
    const counts = { total: jobs.length, queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0 };
    const candidates: string[] = [];
    const blockedIds: string[] = [];
    let completedArtifactBytes = 0;
    let reclaimableBytes = 0;
    const deletedJobIds: string[] = [];
    for (const job of jobs) {
      if (job.status === "queued") counts.queued++;
      else if (["preparing", "rendering", "validating"].includes(job.status)) counts.running++;
      else if (job.status === "completed" || job.status === "failed" || job.status === "cancelled" || job.status === "interrupted") counts[job.status]++;
      if (job.status === "completed" && job.artifact) completedArtifactBytes += job.artifact.bytes;
      if (!terminalPrunable.has(job.status)) continue;
      const age = Date.now() - Date.parse(job.updatedAt);
      if (!Number.isFinite(age) || age < days * 86_400_000) continue;
      // Check candidate in an immutable allowlisted path set; never trust a path in job JSON.
      if (!jobName.test(job.id)) continue;
      const lockNames = [job.id + ".runner.lock", job.id + ".waiting.lock", job.id + ".recovery.lock", job.id + ".cancel",
        job.projectId + ".render.lock"];
      const hasClaim = await Promise.all(lockNames.map(name =>
        fs.lstat(path.join(jobsDir, name)).then(() => true, error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          return true;
        })));
      if (unknownConfiguredSlots || hasClaim.some(Boolean) || slots.some(slot => slot.jobId === job.id)) {
        blockedIds.push(job.id);
        continue;
      }
      const records = [path.join(jobsDir, job.id + ".json"), path.join(jobsDir, job.id + ".source.json")];
      let owned = true;
      let bytes = 0;
      for (const file of records) {
        const stat = await fs.lstat(file).catch(() => null);
        if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 4_000_000) { owned = false; break; }
        bytes += stat.size;
      }
      // Do not delete a job if its output paths contain stray/partial outputs.
      // These require manual operator inspection and separate lifecycle policy.
      for (const suffix of [".mp4", ".partial.mp4"]) {
        if (await fs.lstat(path.join(rendersDir, job.id + suffix)).then(() => true, () => false)) owned = false;
      }
      if (!owned) { blockedIds.push(job.id); continue; }
      candidates.push(job.id);
      reclaimableBytes += bytes;
      if (!options.apply) continue;
      // Revalidate under maintenance lock to avoid acting on a recently updated record.
      const latest = await getMotionJob(workspace, job.id);
      if (!terminalPrunable.has(latest.status) || latest.updatedAt !== job.updatedAt || latest.projectId !== job.projectId) {
        blockedIds.push(job.id); continue;
      }
      const locksNow = await Promise.all(lockNames.map(name => fs.lstat(path.join(jobsDir, name)).then(() => true, () => false)));
      if (locksNow.some(Boolean) || (await inspectMotionSlots(jobsDir)).some(slot => slot.jobId === job.id)) {
        blockedIds.push(job.id); continue;
      }
      // Tombstone metadata first: partial deletion remains fail-closed (not re-admitted).
      const json = records[0];
      const tombstone = json + ".pruned";
      await fs.rename(json, tombstone);
      await fs.rm(records[1]);
      await fs.rm(tombstone);
      deletedJobIds.push(job.id);
    }
    return {
      jobs: counts,
      completedArtifactBytes,
      slots,
      maintenance: {
        minAgeDays: days, candidates: candidates.length, candidateIds: candidates, reclaimableBytes, blockedIds,
        notes: ["Read-only unless apply=true", "Completed artifacts are never pruned",
          "Active, claimed, malformed and unknown files are never reclaimed automatically"],
      },
      ...(options.apply ? { deletedJobIds } : {}),
    };
  } finally {
    await lock?.close();
    if (lock) await fs.rm(lockPath, { force: true });
  }
}
