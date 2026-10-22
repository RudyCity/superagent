import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getMotionProject, motionStorageDir, motionWorkspaceRoot, studioStorageRoot } from "../project/projectStore.js";
import { encodeMotionMp4, deriveRenderProfile, type RenderProfile } from "../render/ffmpegEncoder.js";
import { validateMotionProject } from "../schema/validation.js";
import { resolveMotionAssets } from "../assets/motionAssets.js";
import { resolveMotionAudioTracks, motionAudioTracks } from "../assets/motionAudio.js";
import type { MotionProject } from "../schema/types.js";
import { MOTION_QUEUE_LIMIT, acquireMotionRenderSlot, assertMotionQueueCapacity, inspectMotionSlots, motionConcurrentSlots, withMotionQueueAdmission } from "./renderScheduler.js";
const execFileAsync = promisify(execFile);
export type MotionJobStatus = "queued" | "preparing" | "rendering" | "validating" | "completed" | "failed" | "cancelled" | "interrupted";
export interface MotionJob {
  schemaVersion: 1;
  id: string;
  workspaceRoot: string;
  projectId: string;
  revision: number;
  sourceSha256?: string;
  ownerPid?: number;
  ownerStartedAt?: string;
  status: MotionJobStatus;
  dispatchMode?: "supervised";
  profile: RenderProfile;
  framesCompleted: number;
  createdAt: string;
  updatedAt: string;
  artifact?: { path: string; bytes: number; sha256: string };
  error?: string;
}
const idPattern = /^(?:studiojob|motionjob)-[0-9a-f]{24}$/;
const activeStatuses = new Set<MotionJobStatus>(["queued", "preparing", "rendering", "validating"]);
const terminalStatuses = new Set<MotionJobStatus>(["completed", "failed", "cancelled", "interrupted"]);
function assertJobId(id: string): void {
  if (!idPattern.test(id)) throw new Error("Invalid Motion job id");
}
export async function motionJobDir(workspace: string, child: "jobs" | "renders"): Promise<string> {
  const storage = await motionStorageDir(workspace, true);
  const dir = path.join(path.dirname(storage), child);
  try { await fs.mkdir(dir, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Motion job directory");
  return dir;
}
function jobFile(dir: string, id: string): string { assertJobId(id); return path.join(dir, id + ".json"); }
function sourceFile(dir: string, id: string): string { assertJobId(id); return path.join(dir, id + ".source.json"); }
function cancelFile(dir: string, id: string): string { assertJobId(id); return path.join(dir, id + ".cancel"); }
function projectClaim(dir: string, projectId: string): string {
  if (!/^(?:studio|motion)-[0-9a-f]{20}$/.test(projectId)) throw new Error("Invalid Motion project id");
  return path.join(dir, projectId + ".render.lock");
}
async function ownedRegularFile(file: string, maxBytes: number): Promise<Buffer> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error("Unsafe Motion job file");
  return fs.readFile(file);
}
async function persist(job: MotionJob, dir: string, initial = false): Promise<void> {
  const file = jobFile(dir, job.id);
  const json = JSON.stringify(job, null, 2) + "\n";
  if (initial) return fs.writeFile(file, json, { flag: "wx", mode: 0o600 });
  const temp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  try {
    await fs.writeFile(temp, json, { flag: "wx", mode: 0o600 });
    // Windows may briefly deny replace while another process polls this record.
    // Keep the atomic replacement; retry only transient sharing errors.
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(String(code)) || attempt >= 8) throw error;
        await new Promise(resolve => setTimeout(resolve, 5 * (attempt + 1)));
      }
    }
  } finally { await fs.rm(temp, { force: true }); }
}
function validateJobShape(job: MotionJob, id: string, workspaceRoot: string): void {
  if (job.schemaVersion !== 1 || job.id !== id || job.workspaceRoot !== workspaceRoot ||
    typeof job.projectId !== "string" || !/^(?:studio|motion)-[0-9a-f]{20}$/.test(job.projectId) ||
    !Number.isSafeInteger(job.revision) || job.revision < 1 ||
    !Number.isSafeInteger(job.framesCompleted) || job.framesCompleted < 0 ||
    ![...activeStatuses, ...terminalStatuses].includes(job.status) ||
    !job.profile || !Number.isSafeInteger(job.profile.frameCount)) {
    throw new Error("Invalid or foreign Motion job record");
  }
}
export async function getMotionJob(workspace: string, id: string): Promise<MotionJob> {
  const root = await motionWorkspaceRoot(workspace);
  const dir = await motionJobDir(root, "jobs");
  const job = JSON.parse((await ownedRegularFile(jobFile(dir, id), 100_000)).toString("utf8")) as MotionJob;
  validateJobShape(job, id, root);
  // Completed legacy manifests store absolute MP4 paths. A same-volume
  // Studio namespace migration preserves bytes but changes their prefix.
  if (job.artifact && path.basename(await studioStorageRoot(root)) === "studio") {
    const oldArtifact = path.join(root, ".superagent", "motion", "renders", id + ".mp4");
    if (job.artifact.path === oldArtifact) {
      job.artifact.path = path.join(root, ".superagent", "studio", "renders", id + ".mp4");
    }
  }
  return job;
}
export async function getMotionSchedulerStatus(workspace: string) {
  const dir = await motionJobDir(workspace, "jobs");
  const [jobs, slots] = await Promise.all([listMotionJobs(workspace), inspectMotionSlots(dir)]);
  return {
    maxConcurrentRenders: motionConcurrentSlots(),
    queueLimit: MOTION_QUEUE_LIMIT,
    queued: jobs.filter(job => job.status === "queued").length,
    active: jobs.filter(job => job.status === "preparing" || job.status === "rendering" || job.status === "validating").length,
    slots,
  };
}
export async function listMotionJobs(workspace: string): Promise<MotionJob[]> {
  const dir = await motionJobDir(workspace, "jobs");
  const files = await fs.readdir(dir);
  const jobs: MotionJob[] = [];
  for (const file of files) {
    if (!idPattern.test(file.slice(0, -5)) || !file.endsWith(".json")) continue;
    try { jobs.push(await getMotionJob(workspace, file.slice(0, -5))); }
    catch { /* do not display corrupt or foreign jobs */ }
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/**
 * Operator-initiated stale-job reconciliation. Never reuses or kills process IDs.
 * A recent job or a live/unverifiable owner is intentionally left untouched.
 */
export async function reconcileStaleMotionJob(workspace: string, id: string): Promise<MotionJob> {
  const dir = await motionJobDir(workspace, "jobs");
  const recoveryFile = path.join(dir, id + ".recovery.lock");
  assertJobId(id);
  const guard = await fs.open(recoveryFile, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Motion recovery is already in progress");
    throw error;
  });
  try {
    const job = await getMotionJob(workspace, id);
    if (terminalStatuses.has(job.status)) return job;
    const age = Date.now() - Date.parse(job.updatedAt);
    if (!Number.isFinite(age) || age < 120_000) throw new Error("Motion job is too recent for safe stale-job reconciliation");
    try {
      await fs.lstat(path.join(dir, id + ".runner.lock"));
      throw new Error("Motion runner claim remains; inspect process identity manually");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await fs.lstat(path.join(dir, id + ".waiting.lock"));
      throw new Error("Motion worker may still be waiting for a render slot; inspect process identity manually");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (job.ownerPid) {
      try {
        process.kill(job.ownerPid, 0);
        throw new Error("Motion worker PID still exists; cannot verify owner identity");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const claim = (await ownedRegularFile(projectClaim(dir, job.projectId), 1000)).toString("utf8").trim();
    if (claim !== job.id) throw new Error("Motion project claim does not belong to this job");
    // No automatic restart or requeue: preserve source and record for inspection.
    job.status = "interrupted";
    job.error = "Manually reconciled stale job after verifying missing owner/runner";
    job.updatedAt = new Date().toISOString();
    await persist(job, dir);
    await releaseClaim(dir, job);
    return job;
  } finally {
    await guard.close();
    await fs.rm(recoveryFile, { force: true });
  }
}

/** Read-only status interpretation: PID existence never proves process identity. */
export async function inspectMotionJob(workspace: string, id: string) {
  const job = await getMotionJob(workspace, id);
  const dir = await motionJobDir(workspace, "jobs");
  const check = async (file: string, expected?: string): Promise<string> => {
    try {
      const bytes = await ownedRegularFile(file, 1000);
      return expected ? bytes.toString("utf8").trim() === expected ? "owned" : "mismatch" : "present_unverified";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      return "unsafe_or_unreadable";
    }
  };
  return {
    job,
    claims: {
      project: await check(projectClaim(dir, job.projectId), job.id),
      execution: await check(path.join(dir, job.id + ".runner.lock")),
      waiting: await check(path.join(dir, job.id + ".waiting.lock")),
      slots: await inspectMotionSlots(dir),
      cancellation: await check(cancelFile(dir, id)),
    },
    recovery: terminalStatuses.has(job.status) ? "terminal" :
      job.ownerPid ? "owner_unverified_check_process_identity" : "queued_or_owner_unknown",
    advice: terminalStatuses.has(job.status) ? "No recovery action needed" :
      "Do not kill processes or remove render locks based only on PID existence; inspect the owner process and claims manually",
  };
}
export async function requestMotionCancellation(workspace: string, id: string): Promise<{ jobId: string; cancellationRequested: boolean }> {
  const job = await getMotionJob(workspace, id);
  if (!activeStatuses.has(job.status)) return { jobId: id, cancellationRequested: false };
  const dir = await motionJobDir(workspace, "jobs");
  if (job.dispatchMode === "supervised" && job.status === "queued") {
    // Serialize cancellation against FIFO admission: a job that has not been
    // dispatched can be cancelled without waiting for a nonexistent worker.
    return withMotionQueueAdmission(dir, async () => {
      const current = await getMotionJob(workspace, id);
      if (!activeStatuses.has(current.status)) return { jobId: id, cancellationRequested: false };
      if (current.dispatchMode === "supervised" && current.status === "queued") {
        const claimExists = (name: string) => fs.lstat(path.join(dir, name))
          .then(() => true, error => (error as NodeJS.ErrnoException).code !== "ENOENT");
        let claimed = false;
        for (const suffix of [".waiting.lock", ".runner.lock", ".dispatch.lock", ".recovery.lock"]) {
          if (await claimExists(id + suffix)) { claimed = true; break; }
        }
        for (let slot = 0; slot < 4 && !claimed; slot++) {
          const file = path.join(dir, ".render-slot-" + slot + ".lock");
          try {
            const stat = await fs.lstat(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1000) { claimed = true; break; }
            const owner: unknown = JSON.parse(await fs.readFile(file, "utf8"));
            if (!owner || typeof owner !== "object" ||
              (owner as { jobId?: unknown }).jobId === id) claimed = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") claimed = true;
          }
        }
        if (!claimed) {
          current.status = "cancelled";
          current.error = "Cancelled before FIFO supervisor dispatch";
          current.updatedAt = new Date().toISOString();
          await persist(current, dir);
          await fs.rm(cancelFile(dir, id), { force: true });
          await releaseClaim(dir, current);
          return { jobId: id, cancellationRequested: true };
        }
      }
      try { await fs.writeFile(cancelFile(dir, id), "cancel\n", { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      return { jobId: id, cancellationRequested: true };
    });
  }
  try { await fs.writeFile(cancelFile(dir, id), "cancel\n", { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { jobId: id, cancellationRequested: true };
}
async function verifySnapshot(workspace: string, job: MotionJob, dir: string): Promise<MotionProject> {
  const bytes = await ownedRegularFile(sourceFile(dir, job.id), 4_000_000);
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!job.sourceSha256 || hash !== job.sourceSha256) throw new Error("Motion source snapshot hash mismatch");
  const project: unknown = JSON.parse(bytes.toString("utf8"));
  validateMotionProject(project);
  if (project.id !== job.projectId || project.revision !== job.revision ||
    project.workspaceRoot !== await motionWorkspaceRoot(workspace)) throw new Error("Foreign or mismatched Motion job source");
  return project;
}
/** Verify immutable source and media before dispatching a persisted queued job. */
export async function verifyPreparedMotionSnapshot(workspace: string, id: string): Promise<MotionProject> {
  const job = await getMotionJob(workspace, id);
  if (job.status !== "queued") throw new Error("Motion job is not queued for safe dispatch");
  const project = await verifySnapshot(workspace, job, await motionJobDir(workspace, "jobs"));
  await resolveMotionAssets(workspace, project);
  await resolveMotionAudioTracks(workspace, project);
  return project;
}
async function releaseClaim(dir: string, job: MotionJob): Promise<void> {
  const claim = projectClaim(dir, job.projectId);
  try {
    const contents = await ownedRegularFile(claim, 1000);
    if (contents.toString("utf8").trim() === job.id) await fs.rm(claim);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
/** Persist a complete and immutable source snapshot *before* starting any worker. */
export async function prepareMotionJob(
  workspace: string, projectId: string,
  options: { width?: number; maxFrames?: number; dispatchMode?: "supervised" } = {},
): Promise<MotionJob> {
  const project = await getMotionProject(workspace, projectId);
  const profile = deriveRenderProfile(project, options.width, options.maxFrames);
  // Fail before claiming a render slot if referenced immutable image assets are absent or corrupted.
  await resolveMotionAssets(workspace, project);
  await resolveMotionAudioTracks(workspace, project);
  const dir = await motionJobDir(workspace, "jobs");
  return withMotionQueueAdmission(dir, async () => {
    await assertMotionQueueCapacity(dir);
    const id = "studiojob-" + crypto.randomBytes(12).toString("hex");
  const claim = projectClaim(dir, project.id);
  const lock = await fs.open(claim, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Motion project already has an active or unreconciled render");
    throw error;
  });
  const now = new Date().toISOString();
  const bytes = Buffer.from(JSON.stringify(project) + "\n", "utf8");
  const job: MotionJob = {
    schemaVersion: 1, id, workspaceRoot: project.workspaceRoot,
    projectId, revision: project.revision,
    sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    profile, framesCompleted: 0, status: "queued",
    ...(options.dispatchMode === "supervised" ? { dispatchMode: "supervised" as const } : {}),
    createdAt: now, updatedAt: now,
  };
  let success = false;
  try {
    await lock.writeFile(id + "\n");
    await lock.sync();
    await fs.writeFile(sourceFile(dir, id), bytes, { flag: "wx", mode: 0o600 });
    await persist(job, dir, true);
    success = true;
    return job;
  } finally {
    await lock.close();
    if (!success) {
      await fs.rm(sourceFile(dir, id), { force: true });
      await releaseClaim(dir, job);
    }
  }
  });
}
async function sha256File(file: string): Promise<string> {
  return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
async function validateMp4(file: string, profile: RenderProfile, requireAudio = false): Promise<void> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=codec_name,width,height,nb_frames",
    "-show_entries", "format=duration", "-of", "json", file,
  ], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
  const info = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; nb_frames?: string }>;
    format?: { duration?: string };
  };
  const stream = info.streams?.[0];
  if (!stream || stream.codec_name !== "h264" || stream.width !== profile.width || stream.height !== profile.height ||
    Number(stream.nb_frames) !== profile.frameCount) throw new Error("MP4 video stream validation failed");
  const [num, den] = profile.fps.split("/").map(Number);
  const target = profile.frameCount * den / num;
  if (Math.abs(Number(info.format?.duration) - target) > den / num + 0.002) throw new Error("MP4 duration validation failed");
  if (requireAudio) {
    const { stdout: audioProbe } = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name",
      "-of", "json", file,
    ], { timeout: 15000, maxBuffer: 65536, windowsHide: true });
    const audio = JSON.parse(audioProbe) as { streams?: Array<{ codec_name?: string }> };
    if (audio.streams?.[0]?.codec_name !== "aac") throw new Error("MP4 audio stream validation failed");
  }
}
async function runAdmittedMotionJob(
  workspace: string, id: string, options: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<MotionJob> {
  const dir = await motionJobDir(workspace, "jobs");
  assertJobId(id);
  // Atomic execution claim: duplicate worker entry cannot race queued -> preparing.
  const runnerPath = path.join(dir, id + ".runner.lock");
  const runner = await fs.open(runnerPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Motion job is already claimed by a worker");
    throw error;
  });
  try {
    await runner.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + String.fromCharCode(10));
    await runner.sync();
    // Prevent a worker from beginning while an operator owns reconciliation.
    if (await fs.access(path.join(dir, id + ".recovery.lock")).then(() => true, () => false)) {
      throw new Error("Motion job is under operator recovery inspection");
    }
    const job = await getMotionJob(workspace, id);
    if (job.status !== "queued") throw new Error("Motion job is not queued for execution");
    const claim = (await ownedRegularFile(projectClaim(dir, job.projectId), 1000)).toString("utf8").trim();
    if (claim !== job.id) throw new Error("Motion render claim is not owned by job");
    // Mark claim as in progress synchronously before any awaits that allow another worker to start.
    job.status = "preparing";
    job.ownerPid = process.pid;
    job.ownerStartedAt = new Date().toISOString();
    job.updatedAt = job.ownerStartedAt;
    await persist(job, dir);
    const rendersDir = await motionJobDir(workspace, "renders");
    const output = path.join(rendersDir, job.id + ".mp4");
    const temporary = path.join(rendersDir, job.id + ".partial.mp4");
    const cancellation = cancelFile(dir, job.id);
    try {
      const project = await verifySnapshot(workspace, job, dir);
      const progress = async (frame: number) => {
        if (options.signal?.aborted || await fs.access(cancellation).then(() => true, () => false)) {
          throw new Error("Motion render cancelled");
        }
        if (frame % 10 === 0 || frame === job.profile.frameCount - 1) {
          job.framesCompleted = frame;
          job.status = "rendering";
          job.updatedAt = new Date().toISOString();
          await persist(job, dir);
        }
      };
      await progress(0);
      await encodeMotionMp4(project, job.profile, temporary, {
        ffmpeg: options.ffmpeg, signal: options.signal, onProgress: progress, workspace,
      });
      job.framesCompleted = job.profile.frameCount;
      job.status = "validating";
      job.updatedAt = new Date().toISOString();
      await persist(job, dir);
      await validateMp4(temporary, job.profile, motionAudioTracks(project).length > 0);
      const bytes = (await fs.stat(temporary)).size;
      const sha256 = await sha256File(temporary);
      await fs.rename(temporary, output);
      job.artifact = { path: output, bytes, sha256 };
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      await persist(job, dir);
      return job;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = message.includes("cancelled") ? "cancelled" : "failed";
      job.error = message.slice(0, 1024);
      job.updatedAt = new Date().toISOString();
      await persist(job, dir);
      return job;
    } finally {
      await fs.rm(temporary, { force: true });
      await fs.rm(cancellation, { force: true });
      await releaseClaim(dir, job);
    }
  } finally {
    await runner.close();
    await fs.rm(runnerPath, { force: true });
  }
}
/** Workspace render slots are shared across independent CLI/HTTP/MCP processes. */
export async function runPreparedMotionJob(
  workspace: string, id: string, options: { ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<MotionJob> {
  const dir = await motionJobDir(workspace, "jobs");
  assertJobId(id);
  const waitPath = path.join(dir, id + ".waiting.lock");
  const waiting = await fs.open(waitPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Motion job is already waiting for a render slot");
    throw error;
  });
  let slot: Awaited<ReturnType<typeof acquireMotionRenderSlot>> | undefined;
  try {
    await waiting.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + String.fromCharCode(10));
    await waiting.sync();
    slot = await acquireMotionRenderSlot(dir, id, {
      signal: options.signal,
      cancelled: async () => fs.access(cancelFile(dir, id)).then(() => true, () => false),
    });
    // Keep the waiting claim throughout worker startup, so manual recovery
    // cannot observe an ownerless gap before the runner claim is persisted.
    return await runAdmittedMotionJob(workspace, id, options);
  } catch (error) {
    // No process identity is inferred and no unrelated slot is reclaimed.
    const job = await getMotionJob(workspace, id);
    if (job.status === "queued" && !slot) {
      const message = error instanceof Error ? error.message : String(error);
      job.status = message.includes("cancelled") ? "cancelled" : "failed";
      job.error = message.slice(0, 1024);
      job.updatedAt = new Date().toISOString();
      await persist(job, dir);
      await fs.rm(cancelFile(dir, id), { force: true });
      await releaseClaim(dir, job);
      return job;
    }
    throw error;
  } finally {
    await waiting.close().catch(() => {});
    await fs.rm(waitPath, { force: true });
    await slot?.release();
  }
}
/** Existing foreground behavior remains available and shares the exact worker pipeline. */
export async function renderMotionJob(
  workspace: string, projectId: string,
  options: { width?: number; maxFrames?: number; ffmpeg?: string; signal?: AbortSignal } = {},
): Promise<MotionJob> {
  const job = await prepareMotionJob(workspace, projectId, options);
  return runPreparedMotionJob(workspace, job.id, options);
}
/** Persist a pinned job for the opt-in FIFO supervisor, without spawning workers. */
export async function enqueueSupervisedMotionJob(
  workspace: string, projectId: string, options: { width?: number; maxFrames?: number } = {},
): Promise<MotionJob> {
  return prepareMotionJob(workspace, projectId, { ...options, dispatchMode: "supervised" });
}
/** Spawn a previously prepared immutable job. No queue admission or lock reclaim. */
export async function spawnPreparedMotionWorker(workspace: string, id: string): Promise<void> {
  const job = await getMotionJob(workspace, id);
  if (job.status !== "queued") throw new Error("Motion worker can only start for queued records");
  const moduleUrl = fileURLToPath(import.meta.url);
  const isSourceRuntime = moduleUrl.endsWith(".ts");
  const suffix = isSourceRuntime ? ".ts" : ".js";
  const worker = fileURLToPath(new URL("./motionWorkerEntry" + suffix, import.meta.url));
  // Bun executes TypeScript workers natively. No Node tsx hook is necessary.
  const executable = process.versions.bun ? process.execPath : "bun";
  const child = spawn(executable, [worker, job.workspaceRoot, job.id], {
    detached: true, stdio: "ignore", windowsHide: true,
    env: { ...process.env, SUPERAGENT_MOTION_WORKER: "1" },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();
}
/**
 * Launch a detached Bun worker against an already-persisted immutable job.
 * A successful spawn is not a completion guarantee; inspect status for outcome.
 */
export async function startDetachedMotionJob(
  workspace: string, projectId: string, options: { width?: number; maxFrames?: number } = {},
): Promise<MotionJob> {
  const job = await prepareMotionJob(workspace, projectId, options);
  try {
    await spawnPreparedMotionWorker(workspace, job.id);
    return job;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    job.status = "failed";
    job.error = "Could not start detached worker: " + message;
    job.updatedAt = new Date().toISOString();
    await persist(job, await motionJobDir(workspace, "jobs"));
    await releaseClaim(await motionJobDir(workspace, "jobs"), job);
    return job;
  }
}
