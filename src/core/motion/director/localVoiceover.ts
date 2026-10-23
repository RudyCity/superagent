import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { importMotionAudio } from "../assets/motionAudio.js";
import { getSettings } from "../../config/jsonConfig.js";

/** Optional offline Piper TTS. Executable and voice model paths are administrator-owned env config. */
/** Resolves Piper TTS config prioritizing JSON settings over environment variables. */
export function getPiperConfig(): { binary: string; model: string } | null {
  try {
    const settings = getSettings();
    const binary = settings.motionPiperBin?.trim() || process.env.SUPERAGENT_MOTION_PIPER_BIN?.trim();
    const model = settings.motionPiperModel?.trim() || process.env.SUPERAGENT_MOTION_PIPER_MODEL?.trim();
    if (binary && model) return { binary, model };
  } catch {
    const binary = process.env.SUPERAGENT_MOTION_PIPER_BIN?.trim();
    const model = process.env.SUPERAGENT_MOTION_PIPER_MODEL?.trim();
    if (binary && model) return { binary, model };
  }
  return null;
}

export function localVoiceoverConfigured(): boolean {
  return getPiperConfig() !== null;
}
export async function localVoiceoverReady(): Promise<boolean> {
  const config = getPiperConfig();
  if (!config) return false;
  try {
    const [binary, model] = await Promise.all([
      fs.stat(path.resolve(config.binary)),
      fs.stat(path.resolve(config.model)),
    ]);
    return binary.isFile() && model.isFile();
  } catch { return false; }
}
export interface NarrationRequest { voiceoverText?: string; voiceoverGain?: number }
export function validateNarrationRequest(input: NarrationRequest): void {
  if (input.voiceoverText === undefined && input.voiceoverGain === undefined) return;
  if (typeof input.voiceoverText !== "string" || input.voiceoverText.trim().length < 1 ||
      input.voiceoverText.length > 220 || /[\u0000-\u0008\u000e-\u001f]/.test(input.voiceoverText)) {
    throw new Error("Invalid Motion voice-over transcript (1–220 characters)");
  }
  if (input.voiceoverGain !== undefined &&
      (typeof input.voiceoverGain !== "number" || !Number.isFinite(input.voiceoverGain) ||
       input.voiceoverGain < 0 || input.voiceoverGain > 2)) {
    throw new Error("Invalid Motion voice-over gain (0–2)");
  }
}
export async function synthesizeLocalVoiceover(
  workspace: string, request: NarrationRequest, signal?: AbortSignal,
): Promise<{ id: string; seconds: number; gain: number } | undefined> {
  validateNarrationRequest(request);
  if (request.voiceoverText === undefined) return undefined;
  const config = getPiperConfig();
  if (!config) {
    throw Object.assign(new Error("Local voice-over unavailable: configure motionPiperBin and motionPiperModel in settings or SUPERAGENT_MOTION_PIPER_BIN and SUPERAGENT_MOTION_PIPER_MODEL"), {
      statusCode: 503,
    });
  }
  const binary = path.resolve(config.binary);
  const model = path.resolve(config.model);
  const [executable, voiceModel] = await Promise.all([fs.stat(binary), fs.stat(model)]).catch(() => {
    throw Object.assign(new Error("Local voice-over executable or model file is missing"), { statusCode: 503 });
  });
  if (!executable.isFile() || !voiceModel.isFile()) {
    throw Object.assign(new Error("Local voice-over executable or model is not a file"), { statusCode: 503 });
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sa-motion-voice-"));
  try {
    const output = path.join(directory, "voice.wav");
    const data = request.voiceoverText.trim();
    const wav = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn(binary, ["--model", model, "--output_file", output], {
        shell: false, windowsHide: true, stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      let done = false;
      const fail = (error: Error) => { if (!done) { done = true; reject(error); } };
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-500); });
      const timeout = setTimeout(() => child.kill(), 45_000);
      const abort = () => child.kill();
      signal?.addEventListener("abort", abort, { once: true });
      child.on("error", fail);
      child.on("close", code => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (done) return;
        if (signal?.aborted) { fail(new Error("Motion voice-over cancelled")); return; }
        if (code !== 0) { fail(new Error("Local voice-over engine failed" + (stderr ? ": " + stderr : ""))); return; }
        void fs.readFile(output).then(bytes => {
          if (bytes.length > 2 * 1024 * 1024) throw new Error("Motion voice-over WAV exceeds 2 MB");
          if (!done) { done = true; resolve(bytes); }
        }).catch(fail);
      });
      child.stdin.on("error", () => {});
      child.stdin.end(data + "\n");
    });
    const imported = await importMotionAudio(workspace, wav);
    return { id: imported.id, seconds: imported.seconds, gain: request.voiceoverGain ?? 1 };
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
