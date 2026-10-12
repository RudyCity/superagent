import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { saveCdpPdfArtifact } from "../src/core/tools/chromeCdpArtifacts.js";

const outputPath = path.join(process.cwd(), "cdp_artifact_test.pdf");

afterEach(() => {
  if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
});

describe("Chrome CDP artifact output", () => {
  it("writes a PDF and returns path/size metadata", async () => {
    const result = await saveCdpPdfArtifact("JVBERi0xLjQ=", outputPath);
    expect(result.savedPath).toBe(outputPath);
    expect(result.byteSize).toBeGreaterThan(0);
    expect(fs.readFileSync(outputPath).subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("rejects external paths unless explicitly enabled", async () => {
    const external = path.resolve(process.cwd(), "..", "cdp_artifact_outside.pdf");
    await expect(saveCdpPdfArtifact("JVBERi0xLjQ=", external)).rejects.toThrow("must remain inside");
  });

  it("rejects oversized payloads before writing", async () => {
    await expect(saveCdpPdfArtifact("A".repeat(36 * 1024 * 1024))).rejects.toThrow("25 MiB");
  });
});
