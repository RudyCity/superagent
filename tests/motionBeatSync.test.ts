import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importMotionAudio } from "../src/core/motion/assets/motionAudio.js";
import { createMotionProject, getMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { compileMotionBeatSync, detectMotionAudioOnsets } from "../src/core/motion/motionBeatSync.js";

function percussionWav(): Buffer {
  const rate = 8000, count = rate * 2;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii"); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(count * 2, 40);
  for (const moment of [.2, .6, 1.0, 1.4]) {
    const beginning = Math.round(moment * rate);
    for (let i = beginning; i < beginning + 320; i++)
      wav.writeInt16LE(Math.round(Math.sin((i - beginning) * .12) * 18000), 44 + i * 2);
  }
  return wav;
}
describe("Motion offline audio transient beat sync", () => {
  it("detects separated onsets and writes schema-safe opacity pulses without altering audio", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-audio-beats-"));
    try {
      const wav = percussionWav();
      const frames = detectMotionAudioOnsets(wav, 30);
      expect(frames.length).toBeGreaterThanOrEqual(3);
      expect(frames.length).toBeLessThanOrEqual(4);
      const asset = await importMotionAudio(dir, wav);
      const project = await createMotionProject(dir, "Audio onsets");
      const withAudio = await updateMotionProject(dir, project.id, 1, [{
        type: "set-audio-tracks",
        audioTracks: [{ assetId: asset.id, startFrame: 5, volume: 1, role: "music" }],
      }]);
      const plan = await compileMotionBeatSync(dir, withAudio, {
        targetLayerId: "title", intensity: .35,
      });
      expect(plan.analysis).toBe("pcm16-transient-energy");
      expect(plan.onsetFrames.length).toBeGreaterThanOrEqual(3);
      expect(plan.onsetFrames[0]).toBeGreaterThan(frames[0]);
      const next = await updateMotionProject(dir, project.id, 2, plan.edits);
      expect(next.revision).toBe(3);
      expect(next.composition.audioTracks).toEqual(withAudio.composition.audioTracks);
      expect(next.composition.layers[0].tracks.find(t => t.property === "opacity")!.keyframes.length).toBeGreaterThan(3);
      expect((await getMotionProject(dir, project.id)).revision).toBe(3);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("requires an attached audio clip and a valid existing target layer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-beat-validation-"));
    try {
      const project = await createMotionProject(dir, "Audio validation");
      await expect(compileMotionBeatSync(dir, project, { targetLayerId: "title" })).rejects.toThrow();
      await expect(compileMotionBeatSync(dir, project, { targetLayerId: "missing" })).rejects.toThrow();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
