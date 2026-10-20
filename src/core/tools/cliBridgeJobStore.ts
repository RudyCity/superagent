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
const VALID_ID = /^clj_[0-9]+_[a-f0-9]{8,32}$/;
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

export async function persistJobShard(directory: string, job: DelegateJob): Promise<void> {
  const dir = jobShardPath(directory, job.jobId);
  const revision = (revisions.get(job.jobId) ?? 0) + 1;
  revisions.set(job.jobId, revision);
  const name = Date.now().toString().padStart(13, "0")
    + "-" + revision.toString().padStart(10, "0")
    + "-" + crypto.randomBytes(8).toString("hex") + ".json";
  await writeNewJson(path.join(dir, name), job);
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
    for (const filename of files.filter(name => /^\d{13}-\d{10}-[a-f0-9]{16}\.json$/.test(name)).sort().reverse()) {
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
