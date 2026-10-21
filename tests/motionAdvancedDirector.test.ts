import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { compileDirectorPlan, generateMotionFromPrompt, validateDirectorPlan } from "../src/core/motion/director/directorService.js";
import { renderMotionFrameSnapshot } from "../src/core/motion/director/motionFrameSnapshot.js";
import { inspectMotionQuality } from "../src/core/motion/director/motionQuality.js";
import { evaluateTrack } from "../src/core/motion/timeline/evaluateFrame.js";
import { validateMotionTrack, validateMotionAudio } from "../src/core/motion/schema/validation.js";
import { importMotionAsset } from "../src/core/motion/assets/motionAssets.js";
import { importMotionAudio } from "../src/core/motion/assets/motionAudio.js";
import { createMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { startDetachedMotionJob, getMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";
const roots: string[] = [];
async function workspace() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-advanced-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const plan = { name: "Product creative", durationSeconds: 3, background: "#142136", motion: "pop-up" as const,
  scenes: [{ headline: "Produk hebat", subtitle: "Tersedia sekarang", accent: "#FFE65B" }],
};
async function finished(workspace: string, id: string) {
  for (let i = 0; i < 110; i++) {
    const job = await getMotionJob(workspace, id);
    if (["completed", "failed", "interrupted", "cancelled"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return getMotionJob(workspace, id);
}
function wav(seconds = 0.8): Buffer {
  const count = Math.round(16000 * seconds);
  const bytes = Buffer.alloc(44 + 2 * count);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(2 * count, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(9000 * Math.sin(i * 2 * Math.PI * 440 / 16000)), 44 + 2 * i);
  return bytes;
}
describe("Motion advanced slices: professional easing, formats, rendered review, audio ducking", () => {
  it.each([["16:9", 1920, 1080], ["1:1", 1080, 1080], ["9:16", 1080, 1920]] as const)(
    "compiles %s format with readable project layout", (aspectRatio, width, height) => {
      const composition = compileDirectorPlan({ ...plan, aspectRatio });
      expect([composition.width, composition.height]).toEqual([width, height]);
      const p: MotionProject = { schemaVersion: 1, id: "motion-preview", workspaceRoot: "/tmp", name: plan.name, revision: 1,
        createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z", composition };
      const quality = inspectMotionQuality(p);
      expect(quality.passed, JSON.stringify(quality.issues)).toBe(true);
      expect(quality.issues.find(i => i.code === "text-overflow")).toBeUndefined();
    });
  it("overshoot easing moves position beyond target while opacity remains strictly bounded", () => {
    const track = { property: "x" as const, keyframes: [
      { frame: 0, value: 180, easing: "easeOutBack" as const }, { frame: 20, value: 100 },
    ] };
    expect(validateMotionTrack(track, 90)).toEqual([]);
    expect(evaluateTrack(track, 16)).toBeLessThan(100);
    expect(validateMotionTrack({ ...track, property: "opacity" }, 90).join(" ")).toMatch(/overshoot/);
    expect(() => validateDirectorPlan({ ...plan, motion: "unsafe-transform" })).toThrow();
  });
  it("produces a decoded image frame snapshot and rejects invalid render frames", async () => {
    const root = await workspace();
    const project = await createMotionProject(root, "Rendered review");
    const canvas = createCanvas(110, 90);
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#E25040"; ctx.fillRect(0, 0, 110, 90);
    const asset = await importMotionAsset(root, canvas.toBuffer("image/png"));
    const composition = compileDirectorPlan({ ...plan, aspectRatio: "9:16" as const });
    composition.layers.unshift({ kind: "image", id: "test-brand-image", assetId: asset.id, x: 120, y: 140, width: 300, height: 220,
      rotation: 0, opacity: 1, fill: "#FFFFFF", tracks: [] });
    const updated = await updateMotionProject(root, project.id, 1, [{ type: "replace-composition", composition }]);
    const png = await renderMotionFrameSnapshot(root, updated, 45);
    expect(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);
    expect(png.length).toBeGreaterThan(400);
    await expect(renderMotionFrameSnapshot(root, updated, 90)).rejects.toThrow(/outside/);
    await expect(renderMotionFrameSnapshot(await workspace(), updated, 45)).rejects.toThrow();
  });
  it("renders a short AAC video with a looped soundtrack ducked under a voice-role WAV", async () => {
    if (!await probeFfmpeg()) return;
    const root = await workspace();
    const project = await createMotionProject(root, "Audio ducking");
    const music = await importMotionAudio(root, wav(0.3));
    const voice = await importMotionAudio(root, wav(1.2));
    const composition = compileDirectorPlan(plan);
    composition.audioTracks = [
      { assetId: music.id, startFrame: 0, volume: 0.3, loop: true, role: "music" },
      { assetId: voice.id, startFrame: 15, volume: 1, role: "voiceover" },
    ];
    expect(validateMotionAudio(composition.audioTracks[0], composition.durationFrames)).toEqual([]);
    const edited = await updateMotionProject(root, project.id, project.revision,
      [{ type: "replace-composition", composition }]);
    const job = await startDetachedMotionJob(root, edited.id, { width: 160 });
    const done = await finished(root, job.id);
    expect(done.status, done.error).toBe("completed");
    expect(done.artifact?.bytes).toBeGreaterThan(1000);
    expect(validateMotionAudio({ ...composition.audioTracks[0], role: "unsafe" }, 90).join(" ")).toMatch(/role/);
  }, 70000);
  it("refuses automatic voice-over without a verified configured Piper binary before invoking planner", async () => {
    const root = await workspace(), planner = vi.fn();
    vi.stubEnv("SUPERAGENT_MOTION_PIPER_BIN", "");
    vi.stubEnv("SUPERAGENT_MOTION_PIPER_MODEL", "");
    try {
      await expect(generateMotionFromPrompt(root, "Create a narrated portrait promo",
        { autoNarrateScenes: true, aspectRatio: "9:16", planner })).rejects.toMatchObject({ statusCode: 503 });
      expect(planner).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });
});
