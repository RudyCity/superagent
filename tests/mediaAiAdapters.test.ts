import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { mediaTransform, mediaConvert, mediaCapabilities } from "../src/core/media/mediaEngine.js";

const roots: string[] = [];
async function createImageWorkspace() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-media-ai-"));
  roots.push(cwd);
  await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 251, g: 251, b: 251 } },
  }).png().toFile(path.join(cwd, "subject.png"));
  return cwd;
}
afterAll(async () => {
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 }).catch(() => {})));
});
describe("Installed media adapters", () => {
  it("uses the provisioned U2NetP model for actual background removal", async () => {
    const caps = await mediaCapabilities();
    if (!caps.available.rembg_model_u2netp) return;
    const workspace = await createImageWorkspace();
    const result = await mediaTransform({ inputPath: "subject.png", outputPath: "transparent.png", operation: "remove_background", model: "u2netp" }, workspace);
    expect(result.status).toBe("ok");
    expect(result.backend).toContain("rembg");
    const meta = await sharp(path.join(workspace, "transparent.png")).metadata();
    expect(meta.hasAlpha).toBe(true);
  }, 120000);

  it("actually upscales using the portable Real-ESRGAN Vulkan binary", async () => {
    const caps = await mediaCapabilities();
    if (!caps.available.realesrgan_ncnn) return;
    const workspace = await createImageWorkspace();
    const result = await mediaTransform({ inputPath: "subject.png", outputPath: "upscaled.png", operation: "upscale_ai", scale: 2 }, workspace);
    expect(result.status).toBe("ok");
    expect(result.backend).toContain("Real-ESRGAN");
    const meta = await sharp(path.join(workspace, "upscaled.png")).metadata();
    expect(meta.width).toBe(128);
    expect(meta.height).toBe(128);
  }, 120000);

  it("creates editable DOCX text from a PDF using provisioned python-docx", async () => {
    const caps = await mediaCapabilities();
    if (!caps.available.python_docx || !caps.available.pymupdf) return;
    const workspace = await createImageWorkspace();
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([320, 240]);
    page.drawText("Hello universal media", { x: 30, y: 190, font, size: 12, color: rgb(0, 0, 0) });
    await fs.writeFile(path.join(workspace, "text.pdf"), await pdf.save());
    const result = await mediaConvert({ inputPath: "text.pdf", outputPath: "text.docx" }, workspace);
    expect(result.status).toBe("ok");
    const binary = await fs.readFile(path.join(workspace, "text.docx"));
    expect(binary.subarray(0, 2).toString()).toBe("PK");
  }, 60000);

  it("embeds a source image into a Word document and Excel workbook", async () => {
    const workspace = await createImageWorkspace();
    const word = await mediaConvert({ inputPath: "subject.png", outputPath: "picture.docx" }, workspace);
    const sheet = await mediaConvert({ inputPath: "subject.png", outputPath: "picture.xlsx" }, workspace);
    expect(word.status).toBe("ok");
    expect(sheet.status).toBe("ok");
  }, 60000);
});
