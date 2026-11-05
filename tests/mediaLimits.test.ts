import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { mediaConvert } from "../src/core/media/mediaEngine.js";

const roots: string[] = [];
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-media-limit-"));
  roots.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }).catch(() => {})));
});
describe("Bounded image/PDF conversion preflight", () => {
  it("rejects giant PDF pages before allocating a PowerPoint raster", async () => {
    const cwd = await fixture();
    const pdf = await PDFDocument.create();
    pdf.addPage([12000, 12000]);
    await fs.writeFile(path.join(cwd, "giant.pdf"), await pdf.save());
    await expect(mediaConvert({ inputPath: "giant.pdf", outputPath: "giant.pptx" }, cwd))
      .rejects.toMatchObject({ code: "limit_exceeded" });
    await expect(fs.stat(path.join(cwd, "giant.pptx"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 45000);
  it("maintains a valid image-to-PDF output under its dimension budget", async () => {
    const cwd = await fixture();
    await sharp({ create: { width: 250, height: 100, channels: 3, background: "#1365bb" } })
      .png().toFile(path.join(cwd, "normal.png"));
    const result = await mediaConvert({ inputPath: "normal.png", outputPath: "normal.pdf" }, cwd);
    expect(result.status).toBe("ok");
    const document = await PDFDocument.load(await fs.readFile(path.join(cwd, "normal.pdf")));
    expect(document.getPageCount()).toBe(1);
  });
});
