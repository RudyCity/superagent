import crypto from "node:crypto";
import { readStudioCodeVideoJob, saveStudioCodeVideoJob, listStudioCodeVideoJobs } from "./studioCodeVideoJobStore.js";
import { motionWorkspaceRoot } from "../project/projectStore.js";
import { renderStudioBrowserVideo, type StudioBrowserVideoOptions,
  type StudioBrowserVideoResult } from "./studioBrowserVideoRenderer.js";
import type { MotionProject } from "../schema/types.js";

export type StudioCodeVideoJobStatus = "queued" | "running" | "cancelling" |
  "completed" | "failed" | "cancelled" | "interrupted";
export interface StudioCodeVideoJobPublic {
  id: string;
  status: StudioCodeVideoJobStatus;
  framesCompleted: number;
  frameCount: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  result?: Omit<StudioBrowserVideoResult, "file">;
}
type Input = { project?: MotionProject; html?: string; reactTsx?: string };
interface InternalJob {
  public: StudioCodeVideoJobPublic;
  workspace: string;
  input: Input;
  options: StudioBrowserVideoOptions;
  controller: AbortController;
  persisted: Promise<void>;
  persistenceError?: Error;
}

const jobs = new Map<string, InternalJob>();
let draining = false;
const MAX_QUEUED = 3;
const MAX_TRACKED = 32;
const TERMINAL_RETENTION_MS = 30 * 60_000;
function publicJob(job: InternalJob): StudioCodeVideoJobPublic {
  return structuredClone(job.public);
}
/** Serialize immutable snapshots per job so a late progress write cannot
 * overwrite the completed/cancelled state. Persistence failures abort the
 * active render rather than silently claiming durable recovery.
 */
function persist(job: InternalJob): Promise<void> {
  const snapshot = publicJob(job);
  job.persisted = job.persisted.then(() =>
    saveStudioCodeVideoJob(job.workspace, snapshot)).catch(error => {
    job.persistenceError = error instanceof Error ? error : new Error(String(error));
    job.controller.abort();
  });
  return job.persisted;
}
function prune() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.public.finishedAt &&
      now - Date.parse(job.public.finishedAt) > TERMINAL_RETENTION_MS) jobs.delete(id);
  }
  if (jobs.size <= MAX_TRACKED) return;
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_TRACKED) break;
    if (job.public.finishedAt) jobs.delete(id);
  }
}
async function authorized(workspace: string, id: string): Promise<InternalJob | null> {
  if (!/^codejob-[a-f0-9]{24}$/.test(id)) throw new Error("Invalid Studio code-video job ID");
  const job = jobs.get(id);
  const root = await motionWorkspaceRoot(workspace);
  if (!job || job.workspace !== root) return null;
  return job;
}
async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      const job = [...jobs.values()].find(item => item.public.status === "queued");
      if (!job) break;
      if (job.controller.signal.aborted) {
        job.public.status = "cancelled";
        job.public.finishedAt = new Date().toISOString();
        await persist(job);
        continue;
      }
      job.public.status = "running";
      job.public.startedAt = new Date().toISOString();
      await persist(job);
      try {
        const result = await renderStudioBrowserVideo(job.workspace, job.input, {
          ...job.options,
          signal: job.controller.signal,
          onProgress: (count, total) => {
            job.public.framesCompleted = count;
            job.public.frameCount = total;
            // Bounded disk traffic: initial status, 10% milestones, terminal.
            if (count === 1 || count === total ||
                (total > 0 && count % Math.max(1, Math.ceil(total / 10)) === 0))
              void persist(job);
          },
        });
        if (job.controller.signal.aborted) {
          // Abort after encoding but before status completion must not advertise a
          // successful MP4; render itself checks before returning.
          job.public.status = "cancelled";
        } else {
          const { file: _private, ...safe } = result;
          job.public.result = safe;
          job.public.status = "completed";
        }
      } catch (error) {
        if (job.controller.signal.aborted) job.public.status = "cancelled";
        else {
          job.public.status = "failed";
          // Do not leak source HTML, paths, browser stderr or credentials.
          job.public.error = error instanceof RangeError ? "Invalid render dimensions, duration or frame limits" :
            "Code-to-Video render failed; verify source HTML and local browser/FFmpeg";
        }
      }
      job.public.finishedAt = new Date().toISOString();
      job.input = {};
      await persist(job);
      if (job.persistenceError) {
        // A filesystem failure means the last known state cannot be trusted.
        job.public.status = "failed";
        job.public.result = undefined;
        job.public.error = "Job metadata storage failed; inspect Studio storage";
      }
      prune();
    }
  } finally {
    draining = false;
    if ([...jobs.values()].some(item => item.public.status === "queued")) void drain();
  }
}
export async function queueStudioCodeVideo(workspace: string, input: Input,
  options: StudioBrowserVideoOptions): Promise<StudioCodeVideoJobPublic> {
  prune();
  if ([...jobs.values()].filter(item =>
    ["queued", "running", "cancelling"].includes(item.public.status)).length >= MAX_QUEUED + 1)
    throw Object.assign(new Error("Studio Code-to-Video queue full"), { statusCode: 429 });
  const root = await motionWorkspaceRoot(workspace);
  const id = "codejob-" + crypto.randomBytes(12).toString("hex");
  const item: InternalJob = {
    workspace: root, input, options, controller: new AbortController(),
    persisted: Promise.resolve(),
    public: { id, status: "queued", framesCompleted: 0, frameCount: 0,
      queuedAt: new Date().toISOString() },
  };
  jobs.set(id, item);
  await persist(item);
  if (item.persistenceError) {
    jobs.delete(id);
    throw new Error("Unable to persist Studio render job metadata");
  }
  // In-process execution still requires the original owner. Metadata survives
  // restart, but interrupted work is never automatically replayed.
  void drain();
  return publicJob(item);
}
export async function inspectStudioCodeVideo(workspace: string, id: string) {
  const job = await authorized(workspace, id);
  if (job) return publicJob(job);
  const restored = await readStudioCodeVideoJob(workspace, id);
  if (!restored) throw new Error("Studio code-video job not found");
  return restored;
}
export async function listStudioCodeVideos(workspace: string, limit = 20) {
  const root = await motionWorkspaceRoot(workspace);
  const activeIds = new Set([...jobs.values()]
    .filter(item => item.workspace === root).map(item => item.public.id));
  const disk = await listStudioCodeVideoJobs(root, Math.max(1, Math.min(64, limit)), activeIds);
  // Current in-memory jobs are authoritative; disk snapshots may lag by a few frames.
  const merged = new Map(disk.map(item => [item.id, item]));
  for (const item of jobs.values()) if (item.workspace === root)
    merged.set(item.public.id, publicJob(item));
  return [...merged.values()].sort((a,b) => b.queuedAt.localeCompare(a.queuedAt)).slice(0,limit);
}
export async function cancelStudioCodeVideo(workspace: string, id: string) {
  const job = await authorized(workspace, id);
  if (!job) {
    const restored = await readStudioCodeVideoJob(workspace, id);
    if (!restored) throw new Error("Studio code-video job not found");
    // A finished or interrupted job does not have a live worker to cancel.
    return restored;
  }
  if (job.public.status === "queued") {
    job.controller.abort();
    job.public.status = "cancelled";
    job.public.finishedAt = new Date().toISOString();
    job.input = {};
    await persist(job);
  } else if (job.public.status === "running") {
    job.public.status = "cancelling";
    job.controller.abort();
    await persist(job);
  }
  return publicJob(job);
}
