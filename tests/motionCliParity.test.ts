import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import { compilePresetComposition } from "../src/core/motion/director/creativePresets.js";
import { importMotionAudio } from "../src/core/motion/assets/motionAudio.js";

const testDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-cli-parity-"));
  testDirs.push(dir);
  return dir;
}

function generatePcmWav(seconds = 1, sampleRate = 16000): Buffer {
  const samples = Math.round(sampleRate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);

  // Transient beat pulses every ~0.25s
  for (let i = 0; i < samples; i++) {
    const isBeat = (i % Math.round(sampleRate * 0.25)) < Math.round(sampleRate * 0.03);
    const amp = isBeat ? 24000 : 200;
    const value = Math.round(Math.sin(2 * Math.PI * 440 * (i / sampleRate)) * amp);
    buffer.writeInt16LE(Math.max(-32768, Math.min(32767, value)), 44 + i * 2);
  }
  return buffer;
}

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Motion Studio CLI Feature Parity & Burn-in Captions", () => {
  it("compiles burn-in caption backdrop, accent line, and text layers when burnCaptions is enabled", () => {
    const composition = compilePresetComposition({
      name: "Caption Test",
      durationSeconds: 3,
      background: "#0F172A",
      aspectRatio: "16:9",
      burnCaptions: true,
      scenes: [
        {
          headline: "Judul Scene 1",
          subtitle: "Deskripsi Scene 1",
          accent: "#38BDF8",
          narration: "Narasi khusus scene 1",
        },
      ],
    });

    const backdrop = composition.layers.find(l => l.id === "scene-0-caption-backdrop");
    expect(backdrop).toBeDefined();
    expect(backdrop?.kind).toBe("rect");
    expect(backdrop?.fill).toBe("#0B0F19");
    expect(backdrop?.opacity).toBe(0.85);

    const accent = composition.layers.find(l => l.id === "scene-0-caption-accent");
    expect(accent).toBeDefined();
    expect(accent?.fill).toBe("#38BDF8");

    const text = composition.layers.find(l => l.id === "scene-0-caption-text");
    expect(text).toBeDefined();
    expect(text?.kind).toBe("text");
    if (text?.kind === "text") {
      expect(text.text).toBe("Narasi khusus scene 1");
      expect(text.fill).toBe("#FFFFFF");
    }
  });

  it("lists all built-in motion templates via CLI", async () => {
    const exitCode = await handleMotionCliCommand(["templates", "--json"]);
    expect(exitCode).toBe(0);
  });

  it("applies motion template to project via CLI", async () => {
    const ws = await createTempWorkspace();
    const project = await createMotionProject(ws, "Template Test");

    const exitCode = await handleMotionCliCommand([
      "apply-template",
      project.id,
      "product-launch",
      "--base-revision", "1",
      "--headline", "Peluncuran Fitur Unggulan",
      "--subtitle", "Tersedia mulai hari ini",
      "--workspace", ws,
      "--json",
    ]);

    expect(exitCode).toBe(0);

    const updated = await getMotionProject(ws, project.id);
    expect(updated.revision).toBe(2);
    const titleLayer = updated.composition.layers.find(l => l.id === "headline");
    expect(titleLayer).toBeDefined();
    if (titleLayer?.kind === "text") {
      expect(titleLayer.text).toBe("Peluncuran Fitur Unggulan");
    }
  });

  it("creates multi-aspect batch variants (16:9, 9:16, 1:1) via CLI", async () => {
    const ws = await createTempWorkspace();
    const project = await createMotionProject(ws, "Batch Source");

    const exitCode = await handleMotionCliCommand([
      "batch-variants",
      project.id,
      "--base-revision", "1",
      "--ratios", "16:9,9:16,1:1",
      "--width", "160",
      "--workspace", ws,
      "--json",
    ]);

    expect(exitCode).toBe(0);
  });

  it("synchronizes layer keyframes to audio beats via beat-sync CLI command", async () => {
    const ws = await createTempWorkspace();
    const project = await createMotionProject(ws, "Beat Sync Test");
    const audio = await importMotionAudio(ws, generatePcmWav(1.5));

    // Attach audio track to project
    project.composition.audioTracks = [
      { assetId: audio.id, startFrame: 0, volume: 1, role: "music" },
    ];
    const projectFile = path.join(ws, ".superagent", "studio", "projects", project.id + ".json");
    await fs.writeFile(projectFile, JSON.stringify(project));

    const exitCode = await handleMotionCliCommand([
      "beat-sync",
      project.id,
      "--base-revision", "1",
      "--target-layer", "title",
      "--audio-track", "0",
      "--intensity", "0.4",
      "--workspace", ws,
      "--json",
    ]);

    expect(exitCode).toBe(0);

    const updated = await getMotionProject(ws, project.id);
    expect(updated.revision).toBe(2);
    const titleLayer = updated.composition.layers.find(l => l.id === "title");
    const opacityTrack = titleLayer?.tracks.find(t => t.property === "opacity");
    expect(opacityTrack).toBeDefined();
    expect(opacityTrack?.keyframes.length).toBeGreaterThan(2);
  });
});
