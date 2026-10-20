import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCanvas } from "@napi-rs/canvas";
import { importMotionAsset, readMotionAsset, resolveMotionAssets } from "../src/core/motion/assets/motionAssets.js";
import { createMotionProject, updateMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import { writeMotionPreview } from "../src/core/motion/motionService.js";
import { renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import type { ImageLayer } from "../src/core/motion/schema/types.js";

const roots: string[] = [];
async function workspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-asset-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
function sample(): Buffer {
  const canvas = createCanvas(48, 32);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#EE3377"; ctx.fillRect(0, 0, 48, 32);
  ctx.fillStyle = "#1155CC"; ctx.fillRect(16, 6, 20, 14);
  return canvas.toBuffer("image/png");
}
function layer(assetId: string): ImageLayer {
  return { id: "photo", kind: "image", assetId, x: 30, y: 20, width: 190, height: 100,
    rotation: 15, opacity: 0.9, fill: "#FFFFFF", tracks: [] };
}
describe("Motion immutable workspace asset store", () => {
  it("normalizes, hashes, deduplicates and isolates safe PNG files", async () => {
    const root = await workspace();
    const source = sample();
    const first = await importMotionAsset(root, source);
    expect(first.id).toMatch(/^asset-[a-f0-9]{64}$/);
    expect(first).toMatchObject({ width: 48, height: 32 });
    expect(await importMotionAsset(root, source)).toEqual(first);
    expect((await readMotionAsset(root, first.id)).equals(source)).toBe(true);
    const unrelated = await workspace();
    await expect(readMotionAsset(unrelated, first.id)).rejects.toThrow();
    await expect(readMotionAsset(root, "../escape")).rejects.toThrow("Invalid Motion asset ID");
  });
  it("rejects spoofed SVG, oversized image and corrupted immutable content", async () => {
    const root = await workspace();
    await expect(importMotionAsset(root, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>bad</script></svg>')))
      .rejects.toThrow("Unsupported");
    await expect(importMotionAsset(root, Buffer.alloc(1024 * 1024 + 1)))
      .rejects.toThrow("upload size");
    const imported = await importMotionAsset(root, sample());
    const location = path.join(root, ".superagent", "motion", "assets", imported.id + ".png");
    await fs.writeFile(location, Buffer.from("malicious"));
    await expect(readMotionAsset(root, imported.id)).rejects.toThrow("Invalid Motion asset file");
  });
  it("rejects symlinked workspace asset storage", async () => {
    const root = await workspace();
    const outside = await workspace();
    await fs.mkdir(path.join(root, ".superagent", "motion"), { recursive: true });
    try {
      await fs.symlink(outside, path.join(root, ".superagent", "motion", "assets"),
        process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(importMotionAsset(root, sample())).rejects.toThrow("Invalid Motion asset storage path");
  });
  it("validates references in scene schema and embeds authenticated image data in SVG previews", async () => {
    const root = await workspace();
    const image = await importMotionAsset(root, sample());
    const project = await createMotionProject(root, "Photo");
    const changed = await updateMotionProject(root, project.id, 1, [{ type: "add-layer", layer: layer(image.id) }]);
    expect(changed.revision).toBe(2);
    expect((await resolveMotionAssets(root, changed)).has(image.id)).toBe(true);
    const result = await writeMotionPreview(root, project.id, 0);
    const svg = await fs.readFile(result.path, "utf8");
    expect(svg).toContain("<image");
    expect(svg).toContain("data:image/png;base64,");
    expect(svg).not.toContain("file://");
    await expect(updateMotionProject(root, project.id, 2, [
      { type: "add-layer", layer: layer("../../outside") },
    ])).rejects.toThrow();
    expect((await getMotionProject(root, project.id)).revision).toBe(2);
  });
  it("renders referenced immutable image data to a real H264 video", async () => {
    if (!(await probeFfmpeg())) return;
    const root = await workspace();
    const image = await importMotionAsset(root, sample());
    const project = await createMotionProject(root, "Photo Render");
    // Keep a small valid frame budget for a real encoder integration.
    const composition = structuredClone(project.composition);
    composition.durationFrames = 30;
    composition.layers = [layer(image.id)];
    const edited = await updateMotionProject(root, project.id, 1, [
      { type: "replace-composition", composition },
    ]);
    const job = await renderMotionJob(root, edited.id, { width: 160 });
    expect(job.status).toBe("completed");
    expect(job.artifact?.bytes).toBeGreaterThan(200);
    const location = path.join(root, ".superagent", "motion", "assets", image.id + ".png");
    await fs.writeFile(location, Buffer.from("bad-data"));
    await expect(renderMotionJob(root, edited.id, { width: 160 })).rejects.toThrow();
  }, 30000);
});
