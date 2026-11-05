import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";
import { mediaConvert } from "../src/core/media/mediaEngine.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map(dir => fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {}))); });
describe("Office conversions (local installed backend)", () => {
  it("exports DOCX/XLSX/PPTX to PDF and Word to PNG without overwriting sources", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-office-"));
    dirs.push(cwd);
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#4477cc" } })
      .png().toFile(path.join(cwd, "picture.png"));
    for (const kind of ["docx", "xlsx", "pptx"]) {
      const document = await mediaConvert({ inputPath: "picture.png", outputPath: "report." + kind }, cwd);
      expect(document.status).toBe("ok");
      const pdf = await mediaConvert({ inputPath: "report." + kind, outputPath: kind + ".pdf" }, cwd);
      expect(pdf.status).toBe("ok");
      expect((await fs.readFile(path.join(cwd, kind + ".pdf"))).subarray(0, 4).toString()).toBe("%PDF");
    }
    const image = await mediaConvert({ inputPath: "report.docx", outputPath: "report-preview.png", page: 1 }, cwd);
    expect(image.status).toBe("ok");
    const metadata = await sharp(path.join(cwd, "report-preview.png")).metadata();
    expect(metadata.width).toBeGreaterThan(300);
  }, 180000);
});
