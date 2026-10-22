import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { getMotionJob, motionJobDir } from "./jobs/motionJobs.js";

export type MotionExtraFormat = "gif" | "webm";
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 80 * 1024 * 1024;
const transcodes = new Set<string>();

/** Export only from a verified, completed immutable H.264 artifact.
 * No caller-supplied paths/filters/codecs and no unbounded FFmpeg stdout.
 * This is a synchronous bounded conversion intended for short preview clips.
 */
export async function transcodeMotionPreview(
  file: string, format: MotionExtraFormat,
  options: { ffmpeg?: string; durationSeconds?: number } = {},
): Promise<Buffer> {
  if (!["gif", "webm"].includes(format)) throw new Error("Unsupported Motion export format");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100 || stat.size > MAX_SOURCE_BYTES)
    throw new Error("Invalid Motion export source");
  const duration = options.durationSeconds ?? 15;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 20)
    throw new Error("Motion extra export requires a clip of at most 20 seconds");
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file,
    "-t", String(duration), "-map", "0:v:0", "-an"];
  if (format === "gif") {
    args.push("-vf", "fps=10,scale=480:-2:flags=lanczos", "-f", "gif", "pipe:1");
  } else {
    args.push("-vf", "fps=24,scale=640:-2:flags=bicubic", "-c:v", "libvpx-vp9",
      "-deadline", "realtime", "-cpu-used", "7", "-b:v", "600k", "-f", "webm", "pipe:1");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const process = spawn(options.ffmpeg ?? "ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let bytes = 0, stderr = "", finished = false;
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (error) reject(error); else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
      finish(new Error("Motion export conversion exceeded time limit"));
    }, 45_000);
    process.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        process.kill("SIGKILL"); finish(new Error("Motion export exceeds 16 MB"));
      } else chunks.push(chunk);
    });
    process.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
    process.on("error", error => finish(error));
    process.on("close", code => {
      if (finished) return;
      if (code !== 0 || bytes < 30) return finish(new Error("Motion export conversion failed: " + stderr.slice(-300)));
      const combined = Buffer.concat(chunks);
      if (format === "gif" && combined.toString("ascii", 0, 3) !== "GIF") {
        return finish(new Error("Motion GIF header validation failed"));
      }
      if (format === "webm" && (combined[0] !== 0x1a || combined[1] !== 0x45)) {
        return finish(new Error("Motion WebM header validation failed"));
      }
      finish();
    });
  });
}

export async function convertMotionJobArtifact(
  workspace: string, jobId: string, format: MotionExtraFormat,
): Promise<Buffer> {
  const job = await getMotionJob(workspace, jobId);
  if (job.status !== "completed" || !job.artifact) throw new Error("Motion job artifact not ready");
  const [numerator, denominator] = job.profile.fps.split("/").map(Number);
  const duration = job.profile.frameCount * denominator / numerator;
  if (!Number.isFinite(duration) || duration > 20 || job.profile.width > 1920)
    throw new Error("Motion GIF/WebM export limited to completed clips of 20 seconds");
  const renderDir = await motionJobDir(workspace, "renders");
  const source = path.join(renderDir, jobId + ".mp4");
  if (job.artifact.path !== source) throw new Error("Invalid Motion artifact ownership");
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== job.artifact.bytes)
    throw new Error("Invalid Motion artifact file");
  const hash = crypto.createHash("sha256");
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  if (hash.digest("hex") !== job.artifact.sha256) throw new Error("Motion export source checksum mismatch");
  const lock = workspace + ":" + jobId;
  if (transcodes.has(lock) || transcodes.size >= 2) throw new Error("Motion export converter busy");
  transcodes.add(lock);
  try {
    return await transcodeMotionPreview(source, format, { durationSeconds: duration });
  } finally { transcodes.delete(lock); }
}
