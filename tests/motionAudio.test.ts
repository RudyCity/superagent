import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { importMotionAudio, inspectMotionWav, readMotionAudio } from "../src/core/motion/assets/motionAudio.js";
import { createMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";

const dirs: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-audio-test-"));
  dirs.push(root);
  return root;
}
function wav(seconds = 1, rate = 16000): Buffer {
  const samples = Math.floor(seconds * rate);
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(9000 * Math.sin(i * 2 * Math.PI * 440 / rate)), 44 + i * 2);
  return bytes;
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
describe("Motion WAV workspace asset and output", () => {
  it("validates canonical PCM16, channel/rate integrity and a strict upload budget", () => {
    expect(inspectMotionWav(wav())).toMatchObject({ sampleRate: 16000, channels: 1, seconds: 1 });
    const bad = Buffer.from(wav()); bad.writeUInt16LE(8, 34);
    expect(() => inspectMotionWav(bad)).toThrow("canonical");
    expect(() => inspectMotionWav(wav(31))).toThrow("duration");
    expect(() => inspectMotionWav(Buffer.alloc(2_097_153))).toThrow("canonical");
    expect(() => inspectMotionWav(Buffer.from("<svg>unsafe</svg>"))).toThrow("canonical");
  });
  it("stores audio by hash inside its workspace and rejects cross-workspace reads", async () => {
    const root = await workspace();
    const stored = await importMotionAudio(root, wav());
    expect(stored.id).toMatch(/^audio-[a-f0-9]{64}$/);
    expect(await importMotionAudio(root, wav())).toEqual(stored);
    expect((await readMotionAudio(root, stored.id)).equals(wav())).toBe(true);
    await expect(readMotionAudio(await workspace(), stored.id)).rejects.toThrow();
    await expect(readMotionAudio(root, "../escape")).rejects.toThrow("Invalid Motion audio ID");
    await fs.writeFile(path.join(root, ".superagent", "motion", "audio", stored.id + ".wav"), wav(0.5));
    await expect(readMotionAudio(root, stored.id)).rejects.toThrow("checksum");
  });
  it("uses a revision-guarded audio track and rejects missing/corrupt references", async () => {
    const root = await workspace();
    const sound = await importMotionAudio(root, wav());
    const project = await createMotionProject(root, "With Audio");
    const edited = await updateMotionProject(root, project.id, 1, [{
      type: "set-audio", audio: { assetId: sound.id, startFrame: 10, volume: 0.65 },
    }]);
    expect(edited.composition.audio).toEqual({ assetId: sound.id, startFrame: 10, volume: 0.65 });
    await expect(updateMotionProject(root, project.id, 1, [{ type: "set-audio", audio: null }]))
      .rejects.toThrow("revision");
    await expect(updateMotionProject(root, project.id, 2, [{ type: "set-audio", audio: {
      assetId: sound.id, startFrame: 999999, volume: 0.65,
    } }])).rejects.toThrow("invalid startFrame");
    const cleared = await updateMotionProject(root, project.id, 2, [{ type: "set-audio", audio: null }]);
    expect(cleared.composition.audio).toBeUndefined();
  });
  it("migrates legacy audio to a revisioned multitrack scene with strict upper bounds", async () => {
    const root = await workspace();
    const sound = await importMotionAudio(root, wav(0.7));
    const project = await createMotionProject(root, "Legacy");
    const legacy = await updateMotionProject(root, project.id, 1, [{
      type: "set-audio", audio: { assetId: sound.id, startFrame: 0, volume: 1 },
    }]);
    expect(legacy.composition.audio).toBeDefined();
    const updated = await updateMotionProject(root, project.id, 2, [{
      type: "set-audio-tracks", audioTracks: [
        { assetId: sound.id, startFrame: 2, volume: 0.4, fadeInFrames: 3 },
        { assetId: sound.id, startFrame: 10, volume: 0.6, fadeOutFrames: 4 },
      ],
    }]);
    expect(updated.composition.audio).toBeUndefined();
    expect(updated.composition.audioTracks).toHaveLength(2);
    await expect(updateMotionProject(root, project.id, 3, [{
      type: "set-audio-tracks", audioTracks: Array.from({ length: 5 }, () =>
        ({ assetId: sound.id, startFrame: 0, volume: 1 })),
    }])).rejects.toThrow("at most 4");
    await expect(updateMotionProject(root, project.id, 3, [{
      type: "set-audio-tracks", audioTracks: [{ assetId: sound.id, startFrame: 0, volume: 3 }],
    }])).rejects.toThrow("volume");
    await expect(updateMotionProject(root, project.id, 3, [{
      type: "set-audio-tracks", audioTracks: [{ assetId: sound.id, startFrame: 0, volume: 1, fadeInFrames: -1 }],
    }])).rejects.toThrow("fadeInFrames");
    const removed = await updateMotionProject(root, project.id, 3, [{ type: "set-audio-tracks", audioTracks: [] }]);
    expect(removed.composition.audioTracks).toEqual([]);
  });
  it("renders two PCM clips with independent gain, offsets and fades to one AAC stream", async () => {
    if (!(await probeFfmpeg())) return;
    const root = await workspace();
    const first = await importMotionAudio(root, wav(0.8));
    const secondBuffer = wav(0.4);
    // Make the second asset unique; audio source bytes are immutable SHA256-addressed.
    secondBuffer.writeInt16LE(1234, 44);
    const second = await importMotionAudio(root, secondBuffer);
    const project = await createMotionProject(root, "Mixed");
    const composition = structuredClone(project.composition);
    composition.durationFrames = 30;
    composition.layers = [];
    composition.audioTracks = [
      { assetId: first.id, startFrame: 0, volume: 0.45, fadeInFrames: 4, fadeOutFrames: 5 },
      { assetId: second.id, startFrame: 8, volume: 0.4, fadeInFrames: 3, fadeOutFrames: 4 },
    ];
    const edited = await updateMotionProject(root, project.id, 1, [
      { type: "replace-composition", composition },
    ]);
    const output = await renderMotionJob(root, edited.id, { width: 160 });
    expect(output.status).toBe("completed");
    const report = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_name", "-of", "json", output.artifact!.path,
    ], { encoding: "utf8" })) as { streams: Array<{ codec_name: string }> };
    expect(report.streams.map(stream => stream.codec_name).filter(name => name === "aac")).toHaveLength(1);
  }, 30000);
  it("encodes actual AAC audio inside a deterministic H.264 video", async () => {
    if (!(await probeFfmpeg())) return;
    const root = await workspace();
    const sound = await importMotionAudio(root, wav());
    const project = await createMotionProject(root, "Soundtrack");
    const composition = structuredClone(project.composition);
    composition.durationFrames = 30;
    composition.layers = [];
    composition.audio = { assetId: sound.id, startFrame: 9, volume: 0.8 };
    const edited = await updateMotionProject(root, project.id, 1, [
      { type: "replace-composition", composition },
    ]);
    const rendered = await renderMotionJob(root, edited.id, { width: 160 });
    expect(rendered.status).toBe("completed");
    expect(rendered.artifact?.bytes).toBeGreaterThan(1000);
    const report = JSON.parse(execFileSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_name", "-of", "json", rendered.artifact!.path,
    ], { encoding: "utf8" })) as { streams: Array<{ codec_name: string }> };
    expect(report.streams.map(item => item.codec_name)).toEqual(expect.arrayContaining(["h264", "aac"]));
  }, 30000);
});
