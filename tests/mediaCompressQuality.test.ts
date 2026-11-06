import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { mediaTransform, mediaError } from "../src/core/media/mediaEngine.js";
import { mediaPlan } from "../src/core/media/mediaPlanner.js";
import { MEDIA_MCP_TOOL_DEFS, MEDIA_MCP_TOOL_CLASSIFICATIONS, dispatchMediaMcpTool } from "../src/core/mcp/tools/mediaMcpTools.js";

const roots: string[] = [];
type Compression = {
  originalSizeBytes: number; outputSizeBytes: number; savedBytes: number; savingsPercent: number;
  grewBytes: number; chosenQuality: number | null; targetBytes: number | null; targetMet: boolean | null;
  attempts: number; skipped: boolean; lossless: boolean; outputFormat: string; originalPreserved: boolean;
};
function report(result: { compression?: unknown }) { return result.compression as Compression; }
async function workdir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-compress-"));
  roots.push(root);
  const width = 192, height = 128;
  const pixels = Buffer.alloc(width * height * 3);
  let state = 137;
  for (let i = 0; i < pixels.length; i++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    pixels[i] = state & 255;
  }
  await sharp(pixels, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toFile(path.join(root, "noise.png"));
  await sharp({ create: { width: 128, height: 96, channels: 4, background: { r: 70, g: 130, b: 180, alpha: 0.25 } } })
    .png({ compressionLevel: 0 }).toFile(path.join(root, "alpha.png"));
  return root;
}
async function digest(file: string) { return crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
afterAll(async () => {
  await Promise.all(roots.map(root => fs.rm(root, { force: true, recursive: true, maxRetries: 8, retryDelay: 100 }).catch(() => {})));
});

describe("bounded real image compression", () => {
  it("meets a feasible WebP target with bounded quality search, honest savings, and source preservation", async () => {
    const cwd = await workdir();
    const before = await digest(path.join(cwd, "noise.png"));
    const result = await mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "reduced.webp", quality: 95, targetKB: 7 }, cwd);
    expect(result.status).toBe("ok");
    const c = report(result);
    expect(c.targetBytes).toBe(7 * 1024);
    expect(c.targetMet).toBe(true);
    expect(c.outputSizeBytes).toBeLessThanOrEqual(7 * 1024);
    expect(c.outputSizeBytes).toBe(result.outputs?.[0].sizeBytes);
    expect(c.savedBytes).toBe(c.originalSizeBytes - c.outputSizeBytes);
    expect(c.savingsPercent).toBeGreaterThan(0);
    expect(c.attempts).toBeGreaterThanOrEqual(2);
    expect(c.attempts).toBeLessThanOrEqual(9);
    expect(c.chosenQuality).toBeGreaterThanOrEqual(1);
    expect(c.chosenQuality).toBeLessThanOrEqual(95);
    expect(c.originalPreserved).toBe(true);
    expect(await digest(path.join(cwd, "noise.png"))).toBe(before);
    expect((await sharp(path.join(cwd, "reduced.webp")).metadata()).format).toBe("webp");
    expect((await fs.readdir(cwd)).some(item => item.startsWith(".sa-media-"))).toBe(false);
  });

  it("reports an impossible target as not achieved, without falsely claiming success or shrinking the declared target", async () => {
    const cwd = await workdir();
    const result = await mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "impossible.webp", targetBytes: 64 }, cwd);
    expect(result.status).toBe("ok");
    const c = report(result);
    expect(c.targetMet).toBe(false);
    expect(c.targetBytes).toBe(64);
    expect(c.outputSizeBytes).toBeGreaterThan(64);
    expect(c.attempts).toBeLessThanOrEqual(9);
    expect(result.warnings?.join(" ")).toMatch(/not achieved/i);
  });

  it("losslessly optimizes an uncompressed PNG without treating quality as lossy PNG control", async () => {
    const cwd = await workdir();
    const original = await sharp(path.join(cwd, "alpha.png")).raw().toBuffer();
    const result = await mediaTransform({ operation: "compress", inputPath: "alpha.png", outputPath: "optimized.png", quality: 5, targetBytes: 12 }, cwd);
    expect(result.status).toBe("ok");
    const c = report(result);
    expect(c.lossless).toBe(true);
    expect(c.chosenQuality).toBeNull();
    expect(c.attempts).toBe(1);
    expect(c.targetMet).toBe(false);
    expect(c.outputSizeBytes).toBeLessThan(c.originalSizeBytes);
    expect(result.warnings?.join(" ")).toMatch(/quality is ignored/i);
    expect(await sharp(path.join(cwd, "optimized.png")).raw().toBuffer()).toEqual(original);
  });

  it("does not enlarge an already compressed JPEG, preserving exact bytes across jpg/jpeg aliases", async () => {
    const cwd = await workdir();
    await sharp(path.join(cwd, "noise.png")).jpeg({ quality: 1 }).toFile(path.join(cwd, "small.jpg"));
    const before = await digest(path.join(cwd, "small.jpg"));
    const originalSize = (await fs.stat(path.join(cwd, "small.jpg"))).size;
    const result = await mediaTransform({ operation: "compress", inputPath: "small.jpg", outputPath: "small-copy.jpeg", quality: 100 }, cwd);
    expect(result.status).toBe("ok");
    const c = report(result);
    expect(c.skipped).toBe(true);
    expect(c.chosenQuality).toBeNull();
    expect(c.savedBytes).toBe(0);
    expect(c.outputSizeBytes).toBe(originalSize);
    expect(await digest(path.join(cwd, "small-copy.jpeg"))).toBe(before);
    expect(await digest(path.join(cwd, "small.jpg"))).toBe(before);
  });

  it("preserves alpha with WebP and explicitly reports JPEG flattening", async () => {
    const cwd = await workdir();
    const webp = await mediaTransform({ operation: "compress", inputPath: "alpha.png", outputPath: "alpha.webp", quality: 80 }, cwd);
    expect(webp.status).toBe("ok");
    expect((await sharp(path.join(cwd, "alpha.webp")).metadata()).hasAlpha).toBe(true);
    const jpeg = await mediaTransform({ operation: "compress", inputPath: "alpha.png", outputPath: "flattened.jpg", quality: 80 }, cwd);
    expect(jpeg.status).toBe("ok");
    expect((await sharp(path.join(cwd, "flattened.jpg")).metadata()).hasAlpha).toBe(false);
    expect(jpeg.warnings?.join(" ")).toMatch(/flatten/i);
    expect(report(jpeg).outputFormat).toBe("jpeg");
  });

  it("rejects incompatible formats and invalid targets without leaving an artifact", async () => {
    const cwd = await workdir();
    await expect(mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "bad.gif" }, cwd))
      .rejects.toMatchObject({ code: "unsupported_format" });
    await expect(mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "both.webp", targetKB: 5, targetBytes: 5000 }, cwd))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "fraction.webp", quality: 12.5 }, cwd))
      .rejects.toMatchObject({ code: "invalid_argument" });
    await expect(mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "resize.webp", width: 50 }, cwd))
      .rejects.toMatchObject({ code: "invalid_argument" });
    for (const name of ["bad.gif", "both.webp", "fraction.webp", "resize.webp"]) {
      await expect(fs.stat(path.join(cwd, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("maintains create-only output, workspace traversal guard, and source integrity", async () => {
    const cwd = await workdir();
    const before = await digest(path.join(cwd, "noise.png"));
    await expect(mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "noise.png" }, cwd))
      .rejects.toMatchObject({ code: "output_exists" });
    await expect(mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "../escape.webp" }, cwd))
      .rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(mediaTransform({ operation: "compress", inputPath: "../outside.png", outputPath: "a.webp" }, cwd))
      .rejects.toMatchObject({ code: "path_outside_workspace" });
    expect(await digest(path.join(cwd, "noise.png"))).toBe(before);
  });

  it("planner reports true compress route, best-effort policy and rejects unsupported targets", async () => {
    const cwd = await workdir();
    const plan = await mediaPlan({ mode: "transform", operation: "compress", inputPath: "noise.png", outputPath: "planned.avif", targetKB: 15 }, cwd);
    expect(plan.status).toBe("ok");
    expect(plan.backend).toBe("sharp");
    expect(plan.operation).toBe("compress");
    expect(plan.requestedTargetBytes).toBe(15 * 1024);
    expect(plan.targetGuaranteed).toBe(false);
    expect(plan.maxQualityAttempts).toBe(9);
    expect(plan.noFileCreated).toBe(true);
    expect(plan.warnings?.join(" ")).toMatch(/best-effort/i);
    await expect(fs.stat(path.join(cwd, "planned.avif"))).rejects.toMatchObject({ code: "ENOENT" });
    const unsupported = await mediaPlan({ mode: "transform", operation: "compress", inputPath: "noise.png", outputPath: "bad.tiff" }, cwd);
    expect(unsupported.status).toBe("failed");
    expect(unsupported.code).toBe("unsupported_format");
  });

  it("canonical Agent and derived MCP schemas expose compress and both target controls without loosening write permissions", async () => {
    const transform = MEDIA_MCP_TOOL_DEFS.find(item => item.name === "superagent_media_transform")!;
    const planner = MEDIA_MCP_TOOL_DEFS.find(item => item.name === "superagent_media_plan")!;
    const props = transform.inputSchema.properties as Record<string, any>;
    expect(props.operation.enum).toContain("compress");
    expect(props.targetBytes.type).toBe("integer");
    expect(props.targetKB.type).toBe("integer");
    expect((planner.inputSchema.properties as Record<string, unknown>)).toHaveProperty("targetBytes");
    expect((planner.inputSchema.properties as Record<string, unknown>)).toHaveProperty("targetKB");
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_transform).toBe("dangerous");
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_plan).toBe("safe");
    const cwd = await workdir();
    const response = await dispatchMediaMcpTool("superagent_media_transform",
      { operation: "compress", inputPath: "noise.png", outputPath: "blocked.webp" }, cwd, { allowWrite: false });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0].text).code).toBe("write_permission_required");
    const executed = await dispatchMediaMcpTool("superagent_media_transform",
      { operation: "compress", inputPath: "noise.png", outputPath: "via-mcp.webp", targetKB: 10 }, cwd, { allowWrite: true });
    expect(executed.isError).not.toBe(true);
    expect(JSON.parse(executed.content[0].text).compression.targetBytes).toBe(10240);
  });
  it("encodes AVIF at requested quality where the native Sharp AVIF encoder is present", async () => {
    if (!sharp.format.heif.output.file) return;
    const cwd = await workdir();
    const result = await mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "quality.avif", quality: 33 }, cwd);
    expect(result.status).toBe("ok");
    expect(report(result).chosenQuality).toBe(33);
    expect(report(result).outputFormat).toBe("avif");
    expect((await sharp(path.join(cwd, "quality.avif")).metadata()).format).toBe("heif");
  });

  it("infers compress intent in mediaPlan, and preflights output traversal, symlinks and overwrite", async () => {
    const cwd = await workdir();
    const plan = await mediaPlan({ operation: "compress", inputPath: "noise.png", outputPath: "inferred.webp", targetBytes: 2048 }, cwd);
    expect(plan.status).toBe("ok");
    expect(plan.mode).toBe("transform");
    expect(plan.requestedTargetBytes).toBe(2048);
    const escaped = await mediaPlan({ operation: "compress", inputPath: "noise.png", outputPath: "../escaped.webp" }, cwd);
    expect(escaped.code).toBe("path_outside_workspace");
    const existing = await mediaPlan({ operation: "compress", inputPath: "noise.png", outputPath: "noise.png" }, cwd);
    expect(existing.code).toBe("output_exists");
    const missingParent = await mediaPlan({ operation: "compress", inputPath: "noise.png", outputPath: "absent/new.webp" }, cwd);
    expect(missingParent.code).toBe("output_parent_missing");
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "sa-compress-outside-"));
    roots.push(external);
    let linked = false;
    try {
      await fs.symlink(external, path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (error) {
      // Some restricted Windows accounts cannot create even directory junctions.
      if (!["EPERM", "EACCES", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (linked) {
      const throughLink = await mediaPlan({ operation: "compress", inputPath: "noise.png", outputPath: "linked/no.webp" }, cwd);
      expect(throughLink.code).toBe("path_outside_workspace");
      await expect(mediaTransform({ operation: "compress", inputPath: "noise.png", outputPath: "linked/no.webp" }, cwd))
        .rejects.toMatchObject({ code: "path_outside_workspace" });
    }
  });

});
