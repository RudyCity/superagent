import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getMotionProject, motionStorageDir } from "../project/projectStore.js";
import { encodeMotionMp4, deriveRenderProfile, type RenderProfile } from "../render/ffmpegEncoder.js";
import type { MotionProject } from "../schema/types.js";

const execFileAsync = promisify(execFile);
export type MotionJobStatus = "queued" | "preparing" | "rendering" | "validating" | "completed" | "failed" | "cancelled";
export interface MotionJob {
  schemaVersion: 1;
  id: string;
  workspaceRoot: string;
  projectId: string;
  revision: number;
  status: MotionJobStatus;
  profile: RenderProfile;
  framesCompleted: number;
  createdAt: string;
  updatedAt: string;
  artifact?: { path: string; bytes: number; sha256: string };
  error?: string;
}
const jobIdPattern = /^motionjob-[0-9a-f]{24}$/;

async function privateDir(workspace: string, childName: "jobs" | "renders"): Promise<string> {
  const storage = await motionStorageDir(workspace, true);
  const dir = path.join(path.dirname(storage), childName);
  try { await fs.mkdir(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Motion job directory");
  return dir;
}
function safeJobId(id: string): void {
  if (!jobIdPattern.test(id)) throw new Error("Invalid Motion job id");
}
function fileFor(dir: string, id: string): string { safeJobId(id); return path.join(dir, id + ".json"); }
function isTerminal(status: MotionJobStatus): boolean { return ["completed", "failed", "cancelled"].includes(status); }
async function persist(job: MotionJob, dir: string, first = false): Promise<void> {
  const file = fileFor(dir, job.id);
  const content = JSON.stringify(job, null, 2) + "\n";
  if (first) {
    await fs.writeFile(file, content, { flag: "wx", mode: 0o600 });
    return;
  }
  const temp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }); }
}

export async function getMotionJob(workspace: string, jobId: string): Promise<MotionJob> {
  const dir = await privateDir(workspace, "jobs");
  const file = fileFor(dir, jobId);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000) throw new Error("Invalid Motion job record");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<MotionJob>;
  const actualWorkspace = await fs.realpath(workspace);
  if (parsed.schemaVersion !== 1 || parsed.id !== jobId || parsed.workspaceRoot !== actualWorkspace ||
    typeof parsed.projectId !== "string") {
    throw new Error("Motion job does not belong to workspace");
  }
  if (!["queued", "preparing", "rendering", "validating", "completed", "failed", "cancelled"].includes(String(parsed.status))) {
    throw new Error("Invalid Motion job status");
  }
  if (!parsed.profile || !Number.isSafeInteger(parsed.framesCompleted)) throw new Error("Invalid Motion job metadata");
  const job = parsed as MotionJob;
  return job;
}
export async function listMotionJobs(workspace: string): Promise<MotionJob[]> {
  const dir = await privateDir(workspace, "jobs");
  const names = await fs.readdir(dir);
  const jobs: MotionJob[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || !jobIdPattern.test(name.slice(0, -5))) continue;
    try { jobs.push(await getMotionJob(workspace, name.slice(0, -5))); } catch { /* ignore invalid records */ }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Cancellation request is cooperative and never kills unknown owner processes. */
export async function requestMotionCancellation(workspace: string, jobId: string): Promise<{ jobId: string; cancellationRequested: boolean }> {
  const job = await getMotionJob(workspace, jobId);
  if (isTerminal(job.status)) return { jobId, cancellationRequested: false };
  const dir = await privateDir(workspace, "jobs");
  try { await fs.writeFile(path.join(dir, jobId + ".cancel"), "cancel\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { jobId, cancellationRequested: true };
}
async function sha256File(file: string): Promise<string> {
  const bytes = await fs.readFile(file);
  return crypto.createHash("sha256").update(bytes).digest("hex");
}
async function validateEncodedVideo(file: string, profile: RenderProfile): Promise<void> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,nb_frames",
    "-show_entries", "format=duration", "-of", "json", file,
  ], { timeout: 15_000, maxBuffer: 65536, windowsHide: true });
  const info = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_frames?: string }>;
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  if (!stream || stream.codec_name !== "h264" || stream.width !== profile.width || stream.height !== profile.height ||
    Number(stream.nb_frames) !== profile.frameCount) throw new Error("MP4 video stream validation failed");
  const [num, den] = profile.fps.split("/").map(Number);
  const targetDuration = profile.frameCount * den / num;
  if (Math.abs(Number(info.format?.duration) - targetDuration) > den / num + 0.002) {
    throw new Error("MP4 duration validation failed");
  }
}

/**
 * Current MVP intentionally runs in the caller process; records are persisted
 * before FFmpeg starts, can be inspected by other sessions, and cancelled via
 * per-job request. Detached/restartable scheduling is a separate release gate.
 */
export async function renderMotionJob(
  workspace: string, projectId: string,
  options: { width?: number; maxFrames?: number; ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<MotionJob> {
  const project: MotionProject = await getMotionProject(workspace, projectId);
  const profile = deriveRenderProfile(project, options.width, options.maxFrames);
  const jobsDir = await privateDir(workspace, "jobs");
  const rendersDir = await privateDir(workspace, "renders");
  const claimPath = path.join(jobsDir, project.id + ".render.lock");
  const claim = await fs.open(claimPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Motion project already has an active render");
    throw error;
  });
  const id = "motionjob-" + crypto.randomBytes(12).toString("hex");
  const now = new Date().toISOString();
  const job: MotionJob = {
    schemaVersion: 1, id, projectId, workspaceRoot: project.workspaceRoot,
    revision: project.revision, status: "queued", framesCompleted: 0,
    profile, createdAt: now, updatedAt: now,
  };
  const output = path.join(rendersDir, id + ".mp4");
  const temporary = path.join(rendersDir, id + ".partial.mp4");
  const cancellationFile = path.join(jobsDir, id + ".cancel");
  const progress = async (frame: number) => {
    if (options.signal?.aborted) throw new Error("Motion render cancelled");
    const cancelled = await fs.access(cancellationFile).then(() => true, () => false);
    if (cancelled) throw new Error("Motion render cancelled");
    if (frame % 10 === 0 || frame === profile.frameCount - 1) {
      job.status = "rendering";
      job.framesCompleted = frame;
      job.updatedAt = new Date().toISOString();
      await persist(job, jobsDir);
    }
  };
  try {
    await persist(job, jobsDir, true);
    job.status = "preparing";
    job.updatedAt = new Date().toISOString();
    await persist(job, jobsDir);
    await encodeMotionMp4(project, profile, temporary, {
      ffmpeg: options.ffmpeg, signal: options.signal, onProgress: progress,
    });
    job.status = "validating";
    job.framesCompleted = profile.frameCount;
    job.updatedAt = new Date().toISOString();
    await persist(job, jobsDir);
    await validateEncodedVideo(temporary, profile);
    const bytes = (await fs.stat(temporary)).size;
    const sha256 = await sha256File(temporary);
    await fs.rename(temporary, output);
    job.artifact = { path: output, bytes, sha256 };
    job.status = "completed";
    job.updatedAt = new Date().toISOString();
    await persist(job, jobsDir);
    return job;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    job.status = reason.includes("cancelled") ? "cancelled" : "failed";
    job.error = reason.slice(0, 1024);
    job.updatedAt = new Date().toISOString();
    await persist(job, jobsDir);
    return job;
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rm(cancellationFile, { force: true });
    await claim.close();
    await fs.rm(claimPath, { force: true });
  }
}
