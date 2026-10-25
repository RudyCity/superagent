import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { importMotionVideo } from "../src/core/motion/assets/motionVideoClips.js";
import { reconstructSimpleStudioVideo } from "../src/core/motion/code/videoReferenceReconstruction.js";
import { getMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderStudioNativeHtml } from "../src/core/motion/code/studioNativeCodeExporter.js";

const execute = promisify(execFile);
const created: string[] = [];
afterEach(async () => {
  await Promise.all(created.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("P3 simple reference video vector reconstruction prototype", () => {
  it("reconstructs bounded 2D motion from verified imported MP4 to editable Studio SVG tracks", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "studio-video-p3-test-"));
    created.push(workspace);
    for (let frame = 0; frame < 30; frame++) {
      const canvas = createCanvas(160, 90);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, 160, 90);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(15 + frame * 2, 20, 28, 28);
      await fs.writeFile(path.join(workspace, "frame" + String(frame).padStart(3, "0") + ".png"),
        await canvas.encode("png"));
    }
    await execute("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-framerate", "10",
      "-i", path.join(workspace, "frame%03d.png"),
      "-y", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      path.join(workspace, "fixture.mp4"),
    ], { timeout: 30000, maxBuffer: 4096, windowsHide: true });
    const imported = await importMotionVideo(workspace,
      await fs.readFile(path.join(workspace, "fixture.mp4")));
    const result = await reconstructSimpleStudioVideo(workspace, imported.id);
    expect(result.status).toBe("prototype");
    expect(result.confidence).toBeGreaterThan(0.1);
    expect(result.sampleTimes).toHaveLength(3);
    expect(result.limitations.join(" ")).toMatch(/not reconstructed/);
    const project = await getMotionProject(workspace, result.projectId);
    expect(project.revision).toBe(2);
    expect(project.composition.layers).toHaveLength(1);
    const layer = project.composition.layers[0];
    expect(layer.kind).toBe("path");
    expect(layer.tracks.map(track => track.property)).toEqual(["x", "y"]);
    expect(layer.tracks[0].keyframes).toHaveLength(3);
    expect(layer.tracks[0].keyframes[2].value).toBeGreaterThan(0);
    const html = renderStudioNativeHtml(project);
    expect(html).toContain("native browser source");
    expect(html).not.toContain("cdn.jsdelivr.net");
  }, 65000);

  it("rejects invalid or missing video IDs before creating a project", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "studio-video-bad-"));
    created.push(ws);
    await expect(reconstructSimpleStudioVideo(ws, "../outside")).rejects.toThrow(/Invalid Motion video ID/);
    await expect(reconstructSimpleStudioVideo(ws, "video-" + "a".repeat(64))).rejects.toThrow();
  });
});
