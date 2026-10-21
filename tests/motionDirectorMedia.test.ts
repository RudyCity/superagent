import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { importMotionAsset } from "../src/core/motion/assets/motionAssets.js";
import { importMotionAudio } from "../src/core/motion/assets/motionAudio.js";
import { generateMotionFromPrompt, reviseMotionFromPrompt,
  type MotionDirectorPlan } from "../src/core/motion/director/directorService.js";
import { getMotionProject, listMotionProjects } from "../src/core/motion/project/projectStore.js";
import { getMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";

const dirs: string[] = [];
const plan: MotionDirectorPlan = {
  name: "Video with user assets", durationSeconds: 3, background: "#111827",
  scenes: [{ headline: "Produk Pilihan", subtitle: "Diskon hari ini", accent: "#FCA53A" }],
};
async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-media-director-"));
  dirs.push(dir); return dir;
}
function imageBytes(hex: string) {
  const canvas = createCanvas(300, 160);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = hex; ctx.fillRect(0, 0, 300, 160);
  return canvas.toBuffer("image/png");
}
function wavBytes(seconds = 0.5) {
  const samples = Math.round(16000 * seconds);
  const buffer = Buffer.alloc(44 + 2 * samples);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(2 * samples, 40);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / 16000) * 2000), 44 + i * 2);
  }
  return buffer;
}
async function completed(dir: string, id: string) {
  for (let i = 0; i < 150; i++) {
    const job = await getMotionJob(dir, id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return getMotionJob(dir, id);
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });

describe("Motion Director user-supplied workspace image + WAV integration", () => {
  it("rejects absent, foreign or malformed file IDs before model planning or project creation", async () => {
    const home = await workspace();
    const other = await workspace();
    const external = await importMotionAsset(other, imageBytes("#3498db"));
    const planner = vi.fn().mockResolvedValue(plan);
    await expect(generateMotionFromPrompt(home, "Buat video dengan logo saya", {
      imageAssetId: external.id, planner,
    })).rejects.toThrow();
    await expect(generateMotionFromPrompt(home, "Tambahkan WAV", {
      audioAssetId: "audio-" + "f".repeat(64), planner,
    })).rejects.toThrow();
    await expect(generateMotionFromPrompt(home, "Gunakan logo", {
      imageAssetId: "../../outside.png", planner,
    })).rejects.toThrow(/Invalid Motion Director image asset ID/);
    await expect(generateMotionFromPrompt(home, "Gain", {
      audioGain: 1, planner,
    })).rejects.toThrow(/gain/);
    expect(planner).not.toHaveBeenCalled();
    expect(await listMotionProjects(home)).toHaveLength(0);
  });
  it("creates an editable video with user image/logo and PCM16 WAV; revision swaps image and appends music", async () => {
    if (!await probeFfmpeg()) return;
    const home = await workspace();
    const asset1 = await importMotionAsset(home, imageBytes("#27ae60"));
    const asset2 = await importMotionAsset(home, imageBytes("#e67e22"));
    const audio1 = await importMotionAudio(home, wavBytes(1.0));
    const audio2 = await importMotionAudio(home, wavBytes(0.5));
    const planner = vi.fn().mockResolvedValueOnce(plan).mockResolvedValueOnce({
      edits: [{ type: "set-text", layerId: "scene-0-title", text: "Promo spesial" }],
    });
    const first = await generateMotionFromPrompt(home, "Buat promo pakai gambar dan musik saya", {
      imageAssetId: asset1.id, audioAssetId: audio1.id, audioGain: 0.6, width: 160, planner,
    });
    expect(first.project.composition.layers[0]).toMatchObject({
      id: "director-media-image", kind: "image", assetId: asset1.id,
    });
    expect(first.project.composition.audioTracks).toMatchObject([{ assetId: audio1.id, volume: 0.6 }]);
    expect(first.quality.passed).toBe(true);
    expect(first.limitations.join(" ")).toMatch(/shorter than/);
    const encoded = await completed(home, first.job.id);
    expect(encoded.status, encoded.error).toBe("completed");
    expect(encoded.artifact?.bytes).toBeGreaterThan(1000);
    const updated = await reviseMotionFromPrompt(home, first.project.id, "Ganti gambar dan teks terakhir", {
      imageAssetId: asset2.id, audioAssetId: audio2.id, width: 160, planner,
    });
    expect(updated.project.revision).toBe(3);
    expect(updated.project.composition.layers.filter(layer => layer.id === "director-media-image")).toHaveLength(1);
    expect(updated.project.composition.layers[0]).toMatchObject({ assetId: asset2.id });
    expect(updated.project.composition.audioTracks).toMatchObject([
      { assetId: audio1.id }, { assetId: audio2.id },
    ]);
    expect(updated.project.composition.layers.find(layer => layer.id === "scene-0-title"))
      .toMatchObject({ text: "Promo spesial" });
    expect((await getMotionProject(home, first.project.id)).revision).toBe(3);
    const reencoded = await completed(home, updated.job.id);
    expect(reencoded.status, reencoded.error).toBe("completed");
    expect(reencoded.artifact?.sha256).not.toBe(encoded.artifact?.sha256);
  }, 85000);
});
