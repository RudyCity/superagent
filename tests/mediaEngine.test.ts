import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  mediaInspect, mediaTransform, mediaConvert, mediaBatch, mediaError, mediaCapabilities,
} from "../src/core/media/mediaEngine.js";
import { MEDIA_MCP_TOOL_CLASSIFICATIONS, MEDIA_MCP_TOOL_DEFS } from "../src/core/mcp/tools/mediaMcpTools.js";
import { getProjectCapabilityForTool } from "../src/core/project/projectAccessPolicy.js";

const dirs: string[] = [];
async function fixture() {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-media-"));
  dirs.push(workspace);
  await sharp({ create: { width: 16, height: 10, channels: 4, background: "#ff7733" } }).png().toFile(path.join(workspace, "sample.png"));
  return workspace;
}
afterAll(async () => {
  await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }).catch(() => { /* Windows may hold temporary scanner handles beyond test teardown. */ })));
});

describe("Universal Media Engine", () => {
  it("inspects an image and creates a verified WebP without modifying input", async () => {
    const cwd = await fixture();
    const original = await mediaInspect({ inputPath: "sample.png" }, cwd);
    expect(original.status).toBe("ok");
    expect(original.width).toBe(16);
    const converted = await mediaTransform({ inputPath: "sample.png", outputPath: "small.webp", operation: "resize", width: 8 }, cwd);
    expect(converted.status).toBe("ok");
    expect(converted.backend).toBe("sharp");
    expect(converted.outputs?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const info = await sharp(path.join(cwd, "small.webp")).metadata();
    expect(info.width).toBe(8);
    expect((await fs.readFile(path.join(cwd, "sample.png"))).subarray(1, 4).toString()).toBe("PNG");
  });

  it("creates a PDF from multiple images and a PPTX from an image", async () => {
    const cwd = await fixture();
    const pdf = await mediaConvert({ inputPaths: ["sample.png", "sample.png"], outputPath: "images.pdf" }, cwd);
    expect(pdf.status).toBe("ok");
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(await fs.readFile(path.join(cwd, "images.pdf")))).getPageCount()).toBe(2);
    const slide = await mediaConvert({ inputPath: "sample.png", outputPath: "images.pptx" }, cwd);
    expect(slide.status).toBe("ok");
    expect((await fs.readFile(path.join(cwd, "images.pptx"))).subarray(0, 2).toString()).toBe("PK");
  });

  it("renders a PDF to a PNG using local PyMuPDF", async () => {
    const cwd = await fixture();
    const pdf = await mediaConvert({ inputPath: "sample.png", outputPath: "converted.pdf" }, cwd);
    expect(pdf.status).toBe("ok");
    const rendered = await mediaConvert({ inputPath: "converted.pdf", outputPath: "page.png", page: 1 }, cwd);
    expect(rendered.status).toBe("ok");
    expect(rendered.backend).toContain("PyMuPDF");
    const meta = await sharp(path.join(cwd, "page.png")).metadata();
    expect(meta.width).toBeGreaterThan(10);
  });

  it("converts CSV to XLSX and exports first worksheet to CSV", async () => {
    const cwd = await fixture();
    await fs.writeFile(path.join(cwd, "table.csv"), "Name,Count\nCoffee,4\n");
    const xlsx = await mediaConvert({ inputPath: "table.csv", outputPath: "table.xlsx" }, cwd);
    expect(xlsx.status).toBe("ok");
    const csv = await mediaConvert({ inputPath: "table.xlsx", outputPath: "out.csv" }, cwd);
    expect(csv.status).toBe("ok");
    expect(await fs.readFile(path.join(cwd, "out.csv"), "utf8")).toContain("Coffee");
  });

  it("enforces no overwrite and rejects workspace traversal", async () => {
    const cwd = await fixture();
    await expect(mediaTransform({ inputPath: "sample.png", outputPath: "sample.png", operation: "convert" }, cwd)).rejects.toMatchObject({ code: "output_exists" });
    await expect(mediaInspect({ inputPath: "../outside.png" }, cwd)).rejects.toMatchObject({ code: "path_outside_workspace" });
    await expect(mediaTransform({ inputPath: "sample.png", outputPath: "../escape.png", operation: "resize" }, cwd)).rejects.toMatchObject({ code: "path_outside_workspace" });
  });

  it("returns per-item outcomes for a bounded batch", async () => {
    const cwd = await fixture();
    const result = await mediaBatch({ jobs: [
      { mode: "convert", inputPath: "sample.png", outputPath: "one.pdf" },
      { mode: "transform", inputPath: "absent.png", outputPath: "missing.webp", operation: "resize" },
    ] }, cwd);
    expect(result.status).toBe("failed");
    expect(result.completed).toBe(2);
    expect((result.jobs as any[])[0].status).toBe("ok");
    expect((result.jobs as any[])[1].code).toBe("input_missing");
  });

  it("exposes safe inspection and write-guarded transformations in MCP", () => {
    expect(MEDIA_MCP_TOOL_DEFS).toHaveLength(6);
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_inspect).toBe("safe");
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_capabilities).toBe("safe");
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_plan).toBe("safe");
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_transform).toBe("dangerous");
    expect(MEDIA_MCP_TOOL_CLASSIFICATIONS.superagent_media_batch).toBe("dangerous");
    expect(getProjectCapabilityForTool("superagent_media_convert")).toBe("write");
    expect(getProjectCapabilityForTool("superagent_media_inspect")).toBe("read");
  });

  it("reports optional engine availability without fabricating success", async () => {
    const status = await mediaCapabilities();
    expect(status.status).toBe("ok");
    expect(status.available.sharp).toBe(true);
    expect(mediaError(Object.assign(new Error("missing"), { code: "backend_unavailable" })).code).toBe("backend_unavailable");
  });
});
