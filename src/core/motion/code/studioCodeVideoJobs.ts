import crypto from "node:crypto";
import { motionWorkspaceRoot } from "../project/projectStore.js";
import { renderStudioBrowserVideo, type StudioBrowserVideoOptions,
  type StudioBrowserVideoResult } from "./studioBrowserVideoRenderer.js";
import type { MotionProject } from "../schema/types.js";

export type StudioCodeVideoJobStatus = "queued" | "running" | "cancelling" |
  "completed" | "failed" | "cancelled";
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
}

const jobs = new Map<string, InternalJob>();
let draining = false;
const MAX_QUEUED = 3;
const MAX_TRACKED = 32;
const TERMINAL_RETENTION_MS = 30 * 60_000;
function publicJob(job: InternalJob): StudioCodeVideoJobPublic {
  return structuredClone(job.public);
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
async function authorized(workspace: string, id: string): Promise<InternalJob> {
  if (!/^codejob-[a-f0-9]{24}$/.test(id)) throw new Error("Invalid Studio code-video job ID");
  const job = jobs.get(id);
  if (!job || job.workspace !== await motionWorkspaceRoot(workspace))
    throw new Error("Studio code-video job not found");
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
        continue;
      }
      job.public.status = "running";
      job.public.startedAt = new Date().toISOString();
      try {
        const result = await renderStudioBrowserVideo(job.workspace, job.input, {
          ...job.options,
          signal: job.controller.signal,
          onProgress: (count, total) => {
            job.public.framesCompleted = count;
            job.public.frameCount = total;
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
    public: { id, status: "queued", framesCompleted: 0, frameCount: 0,
      queuedAt: new Date().toISOString() },
  };
  jobs.set(id, item);
  // Detached in-process execution: completed state remains readable only
  // while this backend runs. No restart durability or multi-process scheduler.
  void drain();
  return publicJob(item);
}
export async function inspectStudioCodeVideo(workspace: string, id: string) {
  return publicJob(await authorized(workspace, id));
}
export async function cancelStudioCodeVideo(workspace: string, id: string) {
  const job = await authorized(workspace, id);
  if (job.public.status === "queued") {
    job.controller.abort();
    job.public.status = "cancelled";
    job.public.finishedAt = new Date().toISOString();
    job.input = {};
  } else if (job.public.status === "running") {
    job.public.status = "cancelling";
    job.controller.abort();
  }
  return publicJob(job);
}
