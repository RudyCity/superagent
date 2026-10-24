import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { getMotionProject, createMotionProject } from "../src/core/motion/project/projectStore.js";
import { readMotionAudio } from "../src/core/motion/assets/motionAudio.js";
import { readMotionAsset } from "../src/core/motion/assets/motionAssets.js";
import { decodeMotionMediaBase64, readMotionWorkspaceInput } from "../src/core/motion/assets/motionInput.js";
import { deriveRenderProfile } from "../src/core/motion/render/ffmpegEncoder.js";

const workspaces: string[] = [];
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-authoring-parity-"));
  workspaces.push(root);
  return root;
}
async function cli(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const exit = await handleMotionCliCommand([...args, "--json"]);
    const messages = log.mock.calls.map(args => String(args[0]));
    return { exit, result: JSON.parse(messages.at(-1) || "{}") as any, errors: error.mock.calls };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}
function wav() {
  const samples = 1600;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(root => fs.rm(root, { force: true, recursive: true })));
});

describe("Motion authoring entrypoint parity and input boundaries", () => {
  it("imports a workspace-owned image and WAV with CLI, then commits a revisioned composition via JSON", async () => {
    const root = await workspace();
    const canvas = createCanvas(32, 16);
    canvas.getContext("2d").fillRect(0, 0, 32, 16);
    await fs.writeFile(path.join(root, "image.png"), canvas.toBuffer("image/png"));
    await fs.writeFile(path.join(root, "audio.wav"), wav());
    const image = await cli(["import-image", "--file", "image.png", "--workspace", root]);
    const audio = await cli(["import-audio", "--file", "audio.wav", "--workspace", root]);
    expect(image.exit).toBe(0);
    expect(image.result.id).toMatch(/^asset-[a-f0-9]{64}$/);
    expect(audio.exit).toBe(0);
    expect(audio.result.id).toMatch(/^audio-[a-f0-9]{64}$/);
    expect(await readMotionAsset(root, image.result.id)).toHaveLength((await fs.readFile(path.join(root, "image.png"))).length);
    expect(await readMotionAudio(root, audio.result.id)).toEqual(wav());
    const project = await createMotionProject(root, "Authoring CLI");
    const operations = [
      { type: "add-layer", layer: { kind: "image", id: "photo", assetId: image.result.id, x: 10, y: 10, width: 100, height: 60, rotation: 0, opacity: 1, fill: "#FFFFFF", tracks: [] } },
      { type: "set-audio-tracks", audioTracks: [{ assetId: audio.result.id, startFrame: 0, volume: 0.5 }] },
      { type: "set-property", layerId: "title", property: "x", value: 22 },
    ];
    await fs.writeFile(path.join(root, "edits.json"), JSON.stringify(operations));
    const edit = await cli(["edit", project.id, "--base-revision", "1", "--edits-file", "edits.json", "--workspace", root]);
    expect(edit.exit).toBe(0);
    expect(edit.result.revision).toBe(2);
    const saved = await getMotionProject(root, project.id);
    expect(saved.composition.audioTracks?.[0].assetId).toBe(audio.result.id);
    expect(saved.composition.layers[1]).toMatchObject({ kind: "image", assetId: image.result.id });
    const stale = await cli(["edit", project.id, "--base-revision", "1", "--edits-json", JSON.stringify(operations), "--workspace", root]);
    expect(stale.exit).toBe(3);
    expect((await getMotionProject(root, project.id)).revision).toBe(2);
  });

  it("rejects input outside the workspace, bad base64 and invalid JSON without editing", async () => {
    const root = await workspace();
    const external = await workspace();
    await fs.writeFile(path.join(external, "outside.json"), "[]");
    const bad = await cli(["import-image", "--file", path.join(external, "outside.json"), "--workspace", root]);
    expect(bad.exit).toBe(2);
    expect(bad.result.error).toMatch(/outside workspace/);
    await expect(readMotionWorkspaceInput(root, "../escape", 128)).rejects.toThrow();
    const project = await createMotionProject(root, "Guarded");
    const edit = await cli(["edit", project.id, "--base-revision", "1", "--edits-json", "{}", "--workspace", root]);
    expect(edit.exit).toBe(2);
    expect((await getMotionProject(root, project.id)).revision).toBe(1);
    expect(() => decodeMotionMediaBase64("a=== ", 20)).toThrow();
    expect(() => decodeMotionMediaBase64("aaaa", 2)).toThrow();
    expect(() => decodeMotionMediaBase64("YQ==", 10)).not.toThrow();
    await fs.writeFile(path.join(root, "real.png"), Buffer.from("test"));
    try {
      await fs.symlink(path.join(root, "real.png"), path.join(root, "link.png"));
      await expect(readMotionWorkspaceInput(root, "link.png", 128)).rejects.toThrow();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("advertises the 4K backend ceiling while keeping CLI frame and width safety budgets", async () => {
    const root = await workspace();
    const project = await createMotionProject(root, "1080p");
    expect(deriveRenderProfile(project, 1920)).toMatchObject({ width: 1920, height: 1080, frameCount: 300 });
    expect(() => deriveRenderProfile(project, 1921)).toThrow(RangeError);
    expect(() => deriveRenderProfile({ ...project, composition: { ...project.composition, durationFrames: 1801 } }, 1920)).toThrow(RangeError);
    const doctor = await cli(["doctor"]);
    expect(doctor.result.renderWidthMax).toBe(3840);
    expect(doctor.result.standaloneBrowserEditor).toBe(false);
    expect(doctor.result.nativeTLineEditor).toBe("external-not-verified");
  });
});
