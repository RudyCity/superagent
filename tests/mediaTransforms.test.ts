import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { mediaBatch, mediaTransform } from "../src/core/media/mediaEngine.js";
import { dispatchMediaMcpTool } from "../src/core/mcp/tools/mediaMcpTools.js";

const created: string[] = [];
async function workspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-image-ops-"));
  created.push(dir);
  await sharp({ create: { width: 60, height: 30, channels: 3, background: "#ffffff" } })
    .png().toFile(path.join(dir, "base.png"));
  await sharp({ create: { width: 12, height: 12, channels: 4, background: "#000000" } })
    .png().toFile(path.join(dir, "mark.png"));
  return dir;
}
afterAll(async () => {
  await Promise.all(created.map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }).catch(() => {})));
});
describe("Extended image transformations and batch safeguards", () => {
  it("rotates a raster 90 degrees without mutating the original", async () => {
    const cwd = await workspace();
    const result = await mediaTransform({ inputPath: "base.png", outputPath: "rotated.png", operation: "rotate", degrees: 90 }, cwd);
    expect(result.status).toBe("ok");
    const rotated = await sharp(path.join(cwd, "rotated.png")).metadata();
    expect([rotated.width, rotated.height]).toEqual([30, 60]);
    const original = await sharp(path.join(cwd, "base.png")).metadata();
    expect([original.width, original.height]).toEqual([60, 30]);
  });
  it("creates grayscale and mirrored outputs with valid signatures", async () => {
    const cwd = await workspace();
    const gray = await mediaTransform({ inputPath: "base.png", outputPath: "gray.png", operation: "grayscale" }, cwd);
    const flip = await mediaTransform({ inputPath: "base.png", outputPath: "flip.webp", operation: "flop_horizontal" }, cwd);
    const vertical = await mediaTransform({ inputPath: "base.png", outputPath: "vertical.webp", operation: "flip_vertical" }, cwd);
    expect(gray.status).toBe("ok");
    expect(flip.status).toBe("ok");
    expect(vertical.status).toBe("ok");
    expect((await sharp(path.join(cwd, "gray.png")).metadata()).channels).toBeLessThanOrEqual(3);
  });
  it("places a second raster watermark at the lower right", async () => {
    const cwd = await workspace();
    const result = await mediaTransform({
      inputPath: "base.png", outputPath: "watermarked.png",
      operation: "watermark", watermarkPath: "mark.png", watermarkWidth: 10,
    }, cwd);
    expect(result.status).toBe("ok");
    const pixel = await sharp(path.join(cwd, "watermarked.png")).raw().toBuffer({ resolveWithObject: true });
    const { width, channels } = pixel.info;
    const at = (x: number, y: number) => pixel.data[(y * width + x) * channels];
    expect(at(1, 1)).toBeGreaterThan(245);
    expect(at(58, 28)).toBeLessThan(10);
  });
  it("rejects a watermark outside the authorized workspace", async () => {
    const cwd = await workspace();
    await expect(mediaTransform({
      inputPath: "base.png", outputPath: "outside.png",
      operation: "watermark", watermarkPath: "../not-allowed.png",
    }, cwd)).rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(fs.stat(path.join(cwd, "outside.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("supports explicit lossy compression", async () => {
    const cwd = await workspace();
    const compressed = await mediaTransform({
      inputPath: "base.png", outputPath: "compressed.jpg", operation: "compress", quality: 30,
    }, cwd);
    expect(compressed.status).toBe("ok");
    expect((await sharp(path.join(cwd, "compressed.jpg")).metadata()).format).toBe("jpeg");
  });
  it("stops batch after the first failed job when requested", async () => {
    const cwd = await workspace();
    const result = await mediaBatch({ stopOnError: true, jobs: [
      { mode: "transform", inputPath: "missing.png", outputPath: "a.png", operation: "resize", width: 20 },
      { mode: "transform", inputPath: "base.png", outputPath: "b.png", operation: "resize", width: 20 },
    ] }, cwd);
    expect(result.status).toBe("failed");
    expect(result.completed).toBe(1);
    expect(result.stoppedEarly).toBe(true);
    expect(result.succeeded).toBe(0);
    await expect(fs.stat(path.join(cwd, "b.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("returns cancellation rather than a false success for an aborted batch", async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    controller.abort();
    const result = await mediaBatch({ jobs: [
      { mode: "transform", inputPath: "base.png", outputPath: "aborted.png", operation: "resize", width: 20 },
    ] }, cwd, controller.signal);
    expect(result.status).toBe("failed");
    expect(result.code).toBe("cancelled");
    expect(result.completed).toBe(0);
  });
  it("does not allow unknown batch modes to silently dispatch transforms", async () => {
    const cwd = await workspace();
    const result = await mediaBatch({ jobs: [
      { mode: "erase", inputPath: "base.png", outputPath: "incorrect.png", operation: "resize" },
    ] }, cwd);
    expect(result.status).toBe("failed");
    expect((result.jobs as { code: string }[])[0].code).toBe("invalid_job");
  });
  it("enforces MCP write permission before processing an image", async () => {
    const cwd = await workspace();
    const response = await dispatchMediaMcpTool("superagent_media_transform", {
      inputPath: "base.png", outputPath: "denied.png", operation: "resize", width: 12,
    }, cwd, { allowWrite: false });
    expect(response.isError).toBe(true);
    expect(JSON.parse((response.content[0] as { text: string }).text).code).toBe("write_permission_required");
    await expect(fs.stat(path.join(cwd, "denied.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
