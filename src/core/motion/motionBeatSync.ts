import type { MotionEdit, MotionProject, MotionTrack } from "./schema/types.js";
import { inspectMotionWav, readMotionAudio, motionAudioTracks } from "./assets/motionAudio.js";
import { MotionValidationError } from "./schema/validation.js";

/** Deterministic transient/onset detection for canonical PCM16 WAV. No model,
 * remote decoder, music licence inference, or shell command is involved.
 * Results are intentionally described as detected onsets, not musical BPM.
 */
export function detectMotionAudioOnsets(bytes: Buffer, fps: number, maxEvents = 48): number[] {
  const { sampleRate, channels } = inspectMotionWav(bytes);
  if (!Number.isFinite(fps) || fps < 1 || fps > 240) throw new MotionValidationError(["Invalid beat analysis fps"]);
  const samples = (bytes.length - 44) / (channels * 2);
  const window = Math.max(64, Math.round(sampleRate * .02)); // ~20 ms
  const energies: number[] = [];
  for (let begin = 0; begin < samples; begin += window) {
    let power = 0, count = 0;
    for (let i = begin; i < Math.min(samples, begin + window); i++) {
      const sample = bytes.readInt16LE(44 + (i * channels) * 2) / 32768;
      power += sample * sample;
      count++;
    }
    energies.push(Math.sqrt(power / Math.max(1, count)));
  }
  const frames: number[] = [];
  let last = -999;
  const minGap = Math.max(2, Math.round(.18 * fps));
  for (let i = 1; i < energies.length - 1; i++) {
    const lookback = energies.slice(Math.max(0, i - 16), i);
    const average = lookback.reduce((s, v) => s + v, 0) / lookback.length;
    const current = energies[i];
    const preceding = energies[i - 1];
    if (current < .035 || current < Math.max(.055, average * 1.9) ||
        current < preceding * 1.35 || current < energies[i + 1] * .8) continue;
    const frame = Math.round((i * window / sampleRate) * fps);
    if (frame - last < minGap) continue;
    frames.push(frame); last = frame;
    if (frames.length >= maxEvents) break;
  }
  return frames;
}
export interface MotionBeatSyncInput {
  targetLayerId: string;
  audioTrackIndex?: number;
  intensity?: number;
}
export async function compileMotionBeatSync(
  workspace: string, project: MotionProject, input: MotionBeatSyncInput,
): Promise<{ edits: MotionEdit[]; onsetFrames: number[]; analysis: string }> {
  if (!input || typeof input.targetLayerId !== "string" ||
      !/^[a-z][a-z0-9-]{1,63}$/.test(input.targetLayerId)) {
    throw new MotionValidationError(["Beat sync requires a valid targetLayerId"]);
  }
  const layer = project.composition.layers.find(item => item.id === input.targetLayerId);
  if (!layer) throw new MotionValidationError(["Beat sync target layer not found"]);
  const clips = motionAudioTracks(project);
  const index = input.audioTrackIndex ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || index >= clips.length) {
    throw new MotionValidationError(["Select an existing WAV audio clip"]);
  }
  const intensity = input.intensity ?? .35;
  if (typeof intensity !== "number" || !Number.isFinite(intensity) || intensity < .1 || intensity > .8) {
    throw new MotionValidationError(["Beat sync intensity must be 0.1–0.8"]);
  }
  const clip = clips[index], fps = project.composition.fps.numerator / project.composition.fps.denominator;
  const wav = await readMotionAudio(workspace, clip.assetId);
  const sourceOnsets = detectMotionAudioOnsets(wav, fps);
  const maxFrame = project.composition.durationFrames - 1;
  const onsetFrames = sourceOnsets.map(n => clip.startFrame + n)
    .filter(n => n >= 1 && n < maxFrame - 1);
  if (!onsetFrames.length) {
    throw new MotionValidationError(["No distinct audio transients detected; try another WAV clip"]);
  }
  // Fade down on each transient and bounce back 2 frames later. The result is
  // a regular schema-supported opacity track (<=1024 ordered keyframes).
  const keys = new Map<number, { frame: number; value: number; easing?: "easeInOut" }>();
  keys.set(0, { frame: 0, value: layer.opacity });
  for (const frame of onsetFrames) {
    if (frame > 1) keys.set(frame - 1, { frame: frame - 1, value: layer.opacity });
    keys.set(frame, { frame, value: Math.max(0, layer.opacity * (1 - intensity)), easing: "easeInOut" });
    keys.set(Math.min(maxFrame, frame + 2), {
      frame: Math.min(maxFrame, frame + 2), value: layer.opacity, easing: "easeInOut",
    });
  }
  const track: MotionTrack = { property: "opacity",
    keyframes: [...keys.values()].sort((a, b) => a.frame - b.frame) };
  return {
    edits: [{ type: "set-track", layerId: layer.id, track }],
    onsetFrames, analysis: "pcm16-transient-energy",
  };
}
