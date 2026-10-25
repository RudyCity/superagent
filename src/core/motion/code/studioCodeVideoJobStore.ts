import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { studioStorageRoot } from "../project/projectStore.js";
import type { StudioCodeVideoJobPublic, StudioCodeVideoJobStatus } from "./studioCodeVideoJobs.js";

const VALID_ID = /^codejob-[a-f0-9]{24}$/;
const TRANSIENT = new Set<StudioCodeVideoJobStatus>(["queued", "running", "cancelling"]);
const STATUSES = new Set<StudioCodeVideoJobStatus>([
  "queued", "running", "cancelling", "completed", "failed", "cancelled", "interrupted",
]);
const MAX_JOB_BYTES = 8192;

/** Durable metadata only. Never persist source HTML, React, file paths, audio
 * asset content or API tokens. Renderer ownership remains process-local.
 */
async function jobDirectory(workspace: string, create: boolean): Promise<string> {
  const root = await studioStorageRoot(workspace, create);
  const parent = path.join(root, "code");
  const dir = path.join(parent, "jobs");
  if (create) {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const parentStat = await fs.lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
      throw new Error("Unsafe Studio Code-to-Video parent storage directory");
    await fs.mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
  for (const part of [parent, dir]) {
    const stat = await fs.lstat(part).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error("Unsafe Studio Code-to-Video job storage directory");
  }
  return dir;
}
function sanitize(id: string, input: unknown): StudioCodeVideoJobPublic {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Studio job metadata");
  const v = input as Record<string, unknown>;
  if (v.schemaVersion !== 1 || v.id !== id ||
      !VALID_ID.test(id) || !STATUSES.has(v.status as StudioCodeVideoJobStatus) ||
      !Number.isSafeInteger(v.framesCompleted) || (v.framesCompleted as number) < 0 ||
      !Number.isSafeInteger(v.frameCount) || (v.frameCount as number) < 0 ||
      (v.frameCount as number) > 300 || (v.framesCompleted as number) > (v.frameCount as number) ||
      typeof v.queuedAt !== "string" || !Number.isFinite(Date.parse(v.queuedAt))) {
    throw new Error("Invalid Studio job metadata");
  }
  const status = v.status as StudioCodeVideoJobStatus;
  const data: StudioCodeVideoJobPublic = {
    id, status, framesCompleted: v.framesCompleted as number,
    frameCount: v.frameCount as number, queuedAt: v.queuedAt,
  };
  for (const key of ["startedAt", "finishedAt"] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "string" || !Number.isFinite(Date.parse(v[key])))
        throw new Error("Invalid Studio job timestamp");
      data[key] = v[key];
    }
  }
  if (typeof v.error === "string") data.error = v.error.slice(0, 200);
  if (v.result !== undefined) {
    const result = v.result as Record<string, unknown>;
    if (!result || typeof result !== "object" || !/^codevideo-[a-f0-9]{24}$/.test(String(result.id)) ||
        !Number.isSafeInteger(result.bytes) || (result.bytes as number) < 1024 ||
        (result.bytes as number) > 150 * 1024 * 1024 ||
        !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) ||
        !Number.isSafeInteger(result.fps) || !Number.isSafeInteger(result.frameCount) ||
        !["studio", "html", "studio-react"].includes(String(result.source)) ||
        "file" in result || status !== "completed") {
      throw new Error("Invalid Studio job result metadata");
    }
    data.result = {
      id: result.id as string, bytes: result.bytes as number,
      width: result.width as number, height: result.height as number,
      fps: result.fps as number, frameCount: result.frameCount as number,
      source: result.source as "studio" | "html" | "studio-react",
    };
  }
  return data;
}
export async function saveStudioCodeVideoJob(workspace: string, job: StudioCodeVideoJobPublic): Promise<void> {
  if (!VALID_ID.test(job.id)) throw new Error("Invalid Studio code-video job ID");
  const dir = await jobDirectory(workspace, true);
  const final = path.join(dir, job.id + ".json");
  // Explicit allowlist: even if an accidental extra property reaches the
  // public job object, it cannot serialize source HTML, tokens or local paths.
  const clean = sanitize(job.id, { schemaVersion: 1, ...job });
  const payload = JSON.stringify({ schemaVersion: 1, ...clean });
  if (Buffer.byteLength(payload) > MAX_JOB_BYTES) throw new Error("Oversized Studio job metadata");
  const temp = path.join(dir, "." + job.id + "-" + crypto.randomBytes(6).toString("hex") + ".tmp");
  try {
    await fs.writeFile(temp, payload, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, final);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
export async function readStudioCodeVideoJob(
  workspace: string, id: string,
): Promise<StudioCodeVideoJobPublic | null> {
  if (!VALID_ID.test(id)) throw new Error("Invalid Studio code-video job ID");
  const dir = await jobDirectory(workspace, false);
  const file = path.join(dir, id + ".json");
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOB_BYTES)
    throw new Error("Unsafe Studio job metadata file");
  const stored = sanitize(id, JSON.parse(await fs.readFile(file, "utf8")));
  // In-flight work from an earlier process is unknown. Never assume it
  // completed and never automatically replay tools/browser/FFmpeg side effects.
  if (TRANSIENT.has(stored.status)) {
    stored.status = "interrupted";
    stored.finishedAt = new Date().toISOString();
    stored.error = "Renderer process stopped; review output before manually re-running";
    await saveStudioCodeVideoJob(workspace, stored);
  }
  return stored;
}
export async function listStudioCodeVideoJobs(
  workspace: string, limit = 20, activeIds: ReadonlySet<string> = new Set(),
): Promise<StudioCodeVideoJobPublic[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64)
    throw new Error("Studio code-video job list limit must be 1–64");
  const dir = await jobDirectory(workspace, false);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [] as string[];
    throw error;
  });
  const items: StudioCodeVideoJobPublic[] = [];
  const matching = names.filter(n => /^codejob-[a-f0-9]{24}\.json$/.test(n));
  if (matching.length > 2048) throw new Error("Studio code-video history needs operator cleanup");
  for (const name of matching) {
    if (activeIds.has(name.slice(0, -5))) continue;
    const item = await readStudioCodeVideoJob(workspace, name.slice(0, -5));
    if (item) items.push(item);
  }
  return items.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0, limit);
}
