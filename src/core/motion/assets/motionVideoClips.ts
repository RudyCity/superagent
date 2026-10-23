import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { studioStorageRoot } from "../project/projectStore.js";
import { probeFfmpeg } from "../render/ffmpegEncoder.js";

const VIDEO_ID = /^video-[a-f0-9]{64}$/;
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB max video clip size

export function assertMotionVideoId(id: string): void {
  if (!VIDEO_ID.test(id)) throw new Error("Invalid Motion video ID");
}

async function videoDirectory(workspace: string, create = false): Promise<string> {
  let current = await studioStorageRoot(workspace, create);
  for (const part of ["videos"]) {
    current = path.join(current, part);
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) throw new Error("Motion video asset directory not found");
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Motion video storage path");
  }
  return current;
}

export function inspectMotionVideo(bytes: Buffer): { format: "mp4" | "webm"; size: number } {
  if (!Buffer.isBuffer(bytes) || bytes.length < 32 || bytes.length > MAX_VIDEO_BYTES) {
    throw new Error("Invalid Motion video buffer: size must be 32 bytes to 50 MB");
  }
  // Check MP4 (ftyp box at byte 4)
  const isMp4 = bytes.toString("ascii", 4, 8) === "ftyp";
  // Check WebM / Matroska EBML header (0x1A, 0x45, 0xDF, 0xA3)
  const isWebm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;

  if (!isMp4 && !isWebm) {
    throw new Error("Invalid Motion video format: MP4 (H.264) or WebM required");
  }
  return { format: isMp4 ? "mp4" : "webm", size: bytes.length };
}

export async function importMotionVideo(
  workspace: string,
  source: Buffer,
): Promise<{ id: string; bytes: number; format: string }> {
  const meta = inspectMotionVideo(source);
  const id = "video-" + crypto.createHash("sha256").update(source).digest("hex");
  const ext = meta.format === "webm" ? ".webm" : ".mp4";
  const file = path.join(await videoDirectory(workspace, true), id + ext);

  try {
    await fs.writeFile(file, source, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readMotionVideo(workspace, id);
    if (!existing.equals(source)) throw new Error("Motion video ID collision");
  }
  return { id, bytes: source.length, format: meta.format };
}

export async function readMotionVideo(workspace: string, id: string): Promise<Buffer> {
  assertMotionVideoId(id);
  const dir = await videoDirectory(workspace, false);
  const mp4Path = path.join(dir, id + ".mp4");
  const webmPath = path.join(dir, id + ".webm");

  let targetPath = mp4Path;
  try {
    await fs.lstat(mp4Path);
  } catch {
    targetPath = webmPath;
  }

  const stat = await fs.lstat(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_VIDEO_BYTES || stat.size < 32) {
    throw new Error("Invalid Motion video file");
  }
  const bytes = await fs.readFile(targetPath);
  if ("video-" + crypto.createHash("sha256").update(bytes).digest("hex") !== id) {
    throw new Error("Motion video checksum mismatch");
  }
  return bytes;
}

export async function extractVideoSnapshotPng(
  videoPath: string,
  timeSeconds = 0,
  ffmpeg = "ffmpeg",
): Promise<Buffer> {
  if (!(await probeFfmpeg(ffmpeg))) {
    throw new Error("FFmpeg required for video snapshot extraction");
  }
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner",
      "-loglevel", "error",
      "-ss", String(Math.max(0, timeSeconds)),
      "-i", videoPath,
      "-vframes", "1",
      "-f", "image2pipe",
      "-c:v", "png",
      "pipe:1",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-500); });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(`Failed to extract video frame (code ${code}): ${stderr}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}
