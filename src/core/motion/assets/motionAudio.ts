import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { motionWorkspaceRoot } from "../project/projectStore.js";
import type { MotionProject } from "../schema/types.js";

const AUDIO_ID = /^audio-[a-f0-9]{64}$/;
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export function assertAudioId(id: string): void {
  if (!AUDIO_ID.test(id)) throw new Error("Invalid Motion audio ID");
}
async function audioDirectory(workspace: string, create: boolean): Promise<string> {
  let current = await motionWorkspaceRoot(workspace);
  for (const segment of [".superagent", "motion", "audio"]) {
    current = path.join(current, segment);
    if (create) {
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (!create && error.code === "ENOENT") throw new Error("Motion audio asset not found");
      throw error;
    });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid Motion audio storage path");
  }
  return current;
}
/** Deliberately narrow v1 contract: canonical PCM16 RIFF WAV without extra metadata/chunks. */
export function inspectMotionWav(bytes: Buffer): { sampleRate: number; channels: number; seconds: number } {
  if (!Buffer.isBuffer(bytes) || bytes.length < 46 || bytes.length > MAX_AUDIO_BYTES ||
      bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE" ||
      bytes.toString("ascii", 12, 16) !== "fmt " || bytes.readUInt32LE(16) !== 16 ||
      bytes.readUInt16LE(20) !== 1 || bytes.readUInt16LE(34) !== 16 ||
      bytes.toString("ascii", 36, 40) !== "data" ||
      bytes.readUInt32LE(4) !== bytes.length - 8 ||
      bytes.readUInt32LE(40) !== bytes.length - 44) {
    throw new Error("Invalid Motion WAV: canonical PCM16 RIFF WAV required (max 2 MB)");
  }
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const blockAlign = bytes.readUInt16LE(32);
  const byteRate = bytes.readUInt32LE(28);
  if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 48000 ||
      blockAlign !== channels * 2 || byteRate !== sampleRate * blockAlign ||
      (bytes.length - 44) % blockAlign !== 0) {
    throw new Error("Invalid Motion WAV channel/rate metadata");
  }
  const seconds = (bytes.length - 44) / byteRate;
  if (seconds <= 0 || seconds > 30) throw new Error("Motion audio duration must be at most 30 seconds");
  return { sampleRate, channels, seconds };
}
export async function importMotionAudio(workspace: string, source: Buffer) {
  const metadata = inspectMotionWav(source);
  const id = "audio-" + crypto.createHash("sha256").update(source).digest("hex");
  const file = path.join(await audioDirectory(workspace, true), id + ".wav");
  try { await fs.writeFile(file, source, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readMotionAudio(workspace, id)).equals(source)) throw new Error("Motion audio ID collision");
  }
  return { id, bytes: source.length, ...metadata };
}
export async function readMotionAudio(workspace: string, id: string): Promise<Buffer> {
  assertAudioId(id);
  const file = path.join(await audioDirectory(workspace, false), id + ".wav");
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUDIO_BYTES || stat.size < 46) {
    throw new Error("Invalid Motion audio file");
  }
  const bytes = await fs.readFile(file);
  if ("audio-" + crypto.createHash("sha256").update(bytes).digest("hex") !== id) {
    throw new Error("Motion audio checksum mismatch");
  }
  inspectMotionWav(bytes);
  return bytes;
}
export function motionAudioTracks(project: MotionProject) {
  return project.composition.audioTracks ?? (project.composition.audio ? [project.composition.audio] : []);
}

export async function resolveMotionAudioTracks(workspace: string, project: MotionProject): Promise<string[]> {
  const tracks = motionAudioTracks(project);
  // Never derive filesystem paths from request fields; each hash is checked at read.
  return Promise.all(tracks.map(async track => {
    await readMotionAudio(workspace, track.assetId);
    return path.join(await audioDirectory(workspace, false), track.assetId + ".wav");
  }));
}
/** Retained API for single-track callers. */
export async function resolveMotionAudio(workspace: string, project: MotionProject): Promise<string | null> {
  return (await resolveMotionAudioTracks(workspace, project))[0] ?? null;
}
