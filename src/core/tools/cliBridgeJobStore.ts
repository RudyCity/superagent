/** Cross-process-safe CLI Bridge metadata snapshots.
 *
 * A job has exactly one owning SuperAgent process. State transitions are
 * appended as uniquely named immutable JSON snapshots under jobs.d/<jobId>.
 * Two processes can update different jobs without replacing a shared file.
 * jobs.json is a best-effort, non-authoritative legacy compatibility cache.
 */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { DelegateJob } from "./cliBridgeDelegateJobs.js";

export const JOB_SHARDS_DIRECTORY = "jobs.d";
/** Retain multiple committed checkpoints for crash recovery and read fallback. */
export const MAX_JOB_SNAPSHOTS_PER_JOB = 8;
const VALID_ID = /^clj_[0-9]+_[a-f0-9]{8,32}$/;
const VALID_SNAPSHOT = /^\d{13}-\d{10}-[a-f0-9]{16}\.json$/;
const revisions = new Map<string, number>();

export function jobShardPath(directory: string, jobId: string): string {
  if (!VALID_ID.test(jobId)) throw new Error("Invalid CLI delegation job ID.");
  return path.join(directory, JOB_SHARDS_DIRECTORY, jobId);
}

async function writeNewJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
    // Final name is unique: this is a create operation, not replacing a
    // previously committed state. Works on Windows without delete+rename.
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

/**
 * Delete only old immutable revisions of the job just written by this process.
 * Never scan other job directories and never touch .tmp or unknown entries.
 * The newest committed snapshot must be readable before any deletion.
 * Cleanup failures cannot make an otherwise durable append fail.
 */
async function compactOwnJobSnapshots(jobDirectory: string, jobId: string): Promise<void> {
  const names = (await fs.readdir(jobDirectory)).filter(name => VALID_SNAPSHOT.test(name)).sort().reverse();
  if (names.length <= MAX_JOB_SNAPSHOTS_PER_JOB) return;
  const latestPath = path.join(jobDirectory, names[0]);
  const latestStat = await fs.lstat(latestPath);
  if (!latestStat.isFile() || latestStat.isSymbolicLink()) return;
  const latest = JSON.parse(await fs.readFile(latestPath, "utf8")) as unknown;
  if (!isJob(latest, jobId)) return;
  // Preserve a generous committed recovery window. Only the file publisher
  // owning this job calls this function, after the new snapshot was committed.
  for (const name of names.slice(MAX_JOB_SNAPSHOTS_PER_JOB)) {
    const location = path.join(jobDirectory, name);
    const stat = await fs.lstat(location).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) continue;
    await fs.unlink(location).catch(() => {});
  }
}

export async function persistJobShard(directory: string, job: DelegateJob): Promise<void> {
  const dir = jobShardPath(directory, job.jobId);
  const revision = (revisions.get(job.jobId) ?? 0) + 1;
  revisions.set(job.jobId, revision);
  const name = Date.now().toString().padStart(13, "0")
    + "-" + revision.toString().padStart(10, "0")
    + "-" + crypto.randomBytes(8).toString("hex") + ".json";
  await writeNewJson(path.join(dir, name), job);
  // Durability is established by writeNewJson. Retention is strictly
  // best-effort, and cannot roll back a successfully committed state.
  await compactOwnJobSnapshots(dir, job.jobId).catch(() => {});
}

function isJob(value: unknown, id?: string): value is DelegateJob {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<DelegateJob>;
  return typeof job.jobId === "string" && VALID_ID.test(job.jobId) &&
    (id === undefined || job.jobId === id) &&
    typeof job.logPath === "string" && typeof job.cwd === "string" &&
    typeof job.startedAt === "number" && typeof job.status === "string";
}

/** Never overwrite or mutate a foreign job on read. */
export async function loadJobShards(directory: string): Promise<DelegateJob[]> {
  const root = path.join(directory, JOB_SHARDS_DIRECTORY);
  let folders: string[];
  try { folders = await fs.readdir(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const result: DelegateJob[] = [];
  for (const id of folders) {
    if (!VALID_ID.test(id)) continue;
    const dir = jobShardPath(directory, id);
    let files: string[];
    try { files = await fs.readdir(dir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // A newer version may be in the middle of an atomic write; only visible
    // .json filenames are committed. Ignore .tmp entries.
    for (const filename of files.filter(name => VALID_SNAPSHOT.test(name)).sort().reverse()) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, filename), "utf8")) as unknown;
        if (isJob(parsed, id)) {
          result.push(parsed);
          break;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        // Invalid committed snapshots must never be rewritten or silently
        // deleted by readers. Fall back to the prior valid version if present.
      }
    }
  }
  return result;
}

export async function loadLegacyJobs(file: string): Promise<DelegateJob[]> {
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // The old jobs.json may have been corrupted by concurrent writers.
    // Preserve it for operator inspection; do not rename or destroy it.
    return [];
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return [];
  return Object.values(parsed as Record<string, unknown>).filter(v => isJob(v));
}

/** Non-authoritative jobs.json cache. It may lag concurrent shard writes. */
export async function writeCompatibilityJobsSnapshot(directory: string): Promise<void> {
  const file = path.join(directory, "jobs.json");
  const legacy = await loadLegacyJobs(file);
  const current = await loadJobShards(directory);
  const merged = new Map<string, DelegateJob>();
  for (const job of legacy) merged.set(job.jobId, job);
  for (const job of current) merged.set(job.jobId, job);
  const output: Record<string, DelegateJob> = {};
  for (const job of merged.values()) output[job.jobId] = job;
  const temp = file + "." + process.pid + "." + crypto.randomBytes(6).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, JSON.stringify(output, null, 2), { encoding: "utf8", flag: "wx" });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

export function pruneJobRevisions(retainedJobIds: Set<string>): void {
  for (const id of revisions.keys()) {
    if (!retainedJobIds.has(id)) {
      revisions.delete(id);
    }
  }
}

export function getJobRevisionCount(): number {
  return revisions.size;
}
