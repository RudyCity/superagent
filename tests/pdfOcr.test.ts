import { describe, it, expect, beforeEach } from "vitest";
import { runEnhancedPdfOcr, clearPdfOcrCache, checkOcrSystemStatus } from "../src/core/setup/pdfOcrEngine.js";
import path from "path";
import os from "os";

describe("pdfOcrEngine", () => {
  beforeEach(async () => {
    await clearPdfOcrCache();
  });

  it("should handle cache clearing without errors", async () => {
    await clearPdfOcrCache();
    expect(true).toBe(true);
  });

  it("should check OCR system status and return diagnostics", async () => {
    const status = await checkOcrSystemStatus();
    expect(status).toHaveProperty("pythonAvailable");
    expect(status).toHaveProperty("paddleOcrAvailable");
    expect(status).toHaveProperty("tesseractAvailable");
    expect(status).toHaveProperty("recommendations");
    expect(Array.isArray(status.recommendations)).toBe(true);
  });

  it("should reject non-existent PDF file gracefully", async () => {
    const fakePath = path.join(os.tmpdir(), "non_existent_file_12345.pdf");
    await expect(runEnhancedPdfOcr(fakePath)).rejects.toThrow();
  });
});
