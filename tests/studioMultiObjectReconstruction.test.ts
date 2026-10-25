import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { importMotionVideo } from "../src/core/motion/assets/motionVideoClips.js";
import {
  associateStudioObjects, findStudioBrightComponents, reconstructMultiObjectStudioVideo,
} from "../src/core/motion/code/videoMultiObjectReconstruction.js";
import { getMotionProject, listMotionProjects } from "../src/core/motion/project/projectStore.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import { renderStudioNativeHtml } from "../src/core/motion/code/studioNativeCodeExporter.js";

const run = promisify(execFile);
const workspaces: string[] = [];
async function ws() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-multi-test-"));
  workspaces.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
function candidate(x: number, y = 4) {
  return { x, y, width: 20, height: 20, count: 400, r: 255, g: 255, b: 255 };
}

describe("multi-object reference video prototype", () => {
  it("extracts separated components and rejects unbounded frame geometry", () => {
    const pixels = new Uint8ClampedArray(60 * 40 * 4);
    for (let y = 5; y < 20; y++) {
      for (let x = 5; x < 18; x++) {
        let i = (y * 60 + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
      }
      for (let x = 32; x < 45; x++) {
        let i = (y * 60 + x) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = pixels[i + 3] = 255;
      }
    }
    const found = findStudioBrightComponents(pixels, 60, 40);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ x: 5, y: 5, width: 13, height: 15 });
    expect(found[1]).toMatchObject({ x: 32, y: 5, width: 13, height: 15 });
    expect(() => findStudioBrightComponents(pixels, 6000, 4000)).toThrow();
  });

  it("matches identities deterministically and rejects uncertain or mismatched assignments", () => {
    const reference = [candidate(10), candidate(120)];
    const observed = [candidate(122), candidate(14)];
    const assigned = associateStudioObjects(reference, observed, 160, 90);
    expect(assigned.indices).toEqual([1, 0]);
    expect(assigned.gap).toBeGreaterThan(.045);
    expect(() => associateStudioObjects(reference, observed.slice(0, 1), 160, 90))
      .toThrow(/object count/);
    expect(() => associateStudioObjects([candidate(5), candidate(5)],
      [candidate(10), candidate(20)], 160, 90)).toThrow(/Ambiguous/);
  });

  it("creates two editable SVG layers with separate x/y tracks from a local 3s MP4", async () => {
    const workspace = await ws();
    for (let frame = 0; frame < 30; frame++) {
      const canvas = createCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(12 + frame, 16, 19, 20);
      ctx.fillStyle = "#fff3aa";
      ctx.fillRect(95 + Math.round(frame * .22), 50, 21, 18);
      await fs.writeFile(path.join(workspace, "frame" + String(frame).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10", "-i",
      path.join(workspace, "frame%03d.png"), "-y", "-c:v", "libx264",
      "-pix_fmt", "yuv420p", path.join(workspace, "clip.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });

    const imported = await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace, "clip.mp4")));
    const built = await reconstructMultiObjectStudioVideo(workspace, imported.id);
    expect(built.status).toBe("experimental-multi");
    expect(built.objects).toHaveLength(2);
    expect(built.confidence).toBeGreaterThan(.4);
    expect(built.measuredForegroundIoU).toHaveLength(3);
    expect(built.measuredForegroundIoU.every(score => score >= .38)).toBe(true);
    const preview = await fs.readFile(built.reviewPng);
    expect(preview.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(preview.length).toBeLessThan(2 * 1024 * 1024);
    expect(built.objects.every(obj => obj.boxes.length === 3)).toBe(true);
    expect(built.objects[0].boxes[2].x).toBeGreaterThan(built.objects[0].boxes[0].x + 30);

    const project = await getMotionProject(workspace, built.projectId);
    expect(project.revision).toBe(2);
    expect(project.composition.layers).toHaveLength(2);
    expect(project.composition.layers.every(layer => layer.kind === "path")).toBe(true);
    expect(project.composition.layers.map(layer => layer.id)).toEqual([
      "reconstructed-object-1", "reconstructed-object-2",
    ]);
    for (const layer of project.composition.layers) {
      expect(layer.tracks.map(track => track.property)).toEqual(["x", "y"]);
      expect(layer.tracks.every(track => track.keyframes.length === 3)).toBe(true);
    }
    const actual = evaluateFrame(project, built.objects[0].boxes[1].frame);
    expect(actual.layers[0].values.x).toBeCloseTo(built.objects[0].boxes[1].x - 2, 0);
    const html = renderStudioNativeHtml(project);
    expect(html).toContain('data-studio-id="reconstructed-object-1"');
    expect(html).toContain('data-studio-id="reconstructed-object-2"');
    expect(html).not.toContain("cdn.jsdelivr.net");
  }, 65000);

  it("rejects disappearing objects without creating a misleading Studio project", async () => {
    const workspace = await ws();
    for (let f = 0; f < 30; f++) {
      const canvas = createCanvas(160, 90);
      const context = canvas.getContext("2d");
      context.fillStyle = "#000000";
      context.fillRect(0, 0, 160, 90);
      context.fillStyle = "#ffffff";
      context.fillRect(12 + f, 14, 20, 21);
      if (f < 12) {
        context.fillStyle = "#fff2a0";
        context.fillRect(100, 48, 20, 20);
      }
      await fs.writeFile(path.join(workspace, "vanish" + String(f).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace, "vanish%03d.png"),
      "-y", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      path.join(workspace, "vanish.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });
    const imported = await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace, "vanish.mp4")));
    await expect(reconstructMultiObjectStudioVideo(workspace, imported.id))
      .rejects.toThrow(/object count/);
    expect(await listMotionProjects(workspace)).toEqual([]);
  }, 65000);
  it("fails invalid/missing imported IDs without leaving Studio projects", async () => {
    const workspace = await ws();
    await expect(reconstructMultiObjectStudioVideo(workspace, "../../untrusted.mp4"))
      .rejects.toThrow(/Invalid Motion video ID/);
    await expect(reconstructMultiObjectStudioVideo(workspace, "video-" + "f".repeat(64)))
      .rejects.toThrow();
    expect(await listMotionProjects(workspace)).toEqual([]);
  });
});
