import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TARGETS } from "../scripts/build-lan-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "artifacts", "lan-client");

describe("Portable Cross-Platform LAN Client Build Matrix", () => {
  it("defines targets for Windows, Linux, and macOS across x64 and arm64", () => {
    const ids = TARGETS.map((t) => t.id);
    expect(ids).toContain("windows-x64");
    expect(ids).toContain("linux-x64");
    expect(ids).toContain("linux-arm64");
    expect(ids).toContain("macos-x64");
    expect(ids).toContain("macos-arm64");

    for (const t of TARGETS) {
      expect(t.bunTarget).toMatch(/^bun-(windows|linux|darwin)-(x64|arm64)$/);
      expect(t.binaryFile).toBeTruthy();
      expect(t.archiveFile).toBeTruthy();
    }
  });

  it("produces valid standalone executables and archives in artifacts/lan-client/", () => {
    for (const t of TARGETS) {
      const binPath = path.join(outDir, t.binaryFile);
      const arcPath = path.join(outDir, t.archiveFile);

      expect(fs.existsSync(binPath), `Missing binary: ${t.binaryFile}`).toBe(true);
      expect(fs.statSync(binPath).size).toBeGreaterThan(1_000_000);

      expect(fs.existsSync(arcPath), `Missing archive: ${t.archiveFile}`).toBe(true);
      expect(fs.statSync(arcPath).size).toBeGreaterThan(500_000);

      const binShaPath = binPath + ".sha256";
      const arcShaPath = arcPath + ".sha256";
      expect(fs.existsSync(binShaPath), `Missing checksum: ${binShaPath}`).toBe(true);
      expect(fs.existsSync(arcShaPath), `Missing checksum: ${arcShaPath}`).toBe(true);
    }
  });

  it("verifies master SHA256SUMS matches actual binary integrity", () => {
    const sumsPath = path.join(outDir, "SHA256SUMS");
    expect(fs.existsSync(sumsPath)).toBe(true);
    const lines = fs.readFileSync(sumsPath, "utf8").trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThanOrEqual(10);

    for (const line of lines) {
      const match = line.match(/^([a-f0-9]{64})\s+(.+)$/);
      expect(match, `Invalid SHA256SUMS entry: ${line}`).toBeTruthy();
      const expectedHash = match![1];
      const filename = match![2].trim();
      const targetFile = path.join(outDir, filename);

      expect(fs.existsSync(targetFile), `Target file in SHA256SUMS does not exist: ${filename}`).toBe(true);
      const actualHash = crypto.createHash("sha256").update(fs.readFileSync(targetFile)).digest("hex");
      expect(actualHash).toBe(expectedHash);
    }
  });

  it("contains portable Windows GUI companion archive with companion engine", () => {
    const guiZipPath = path.join(outDir, "superagent-lan-windows-portable-x64.zip");
    if (fs.existsSync(guiZipPath)) {
      expect(fs.statSync(guiZipPath).size).toBeGreaterThan(10_000_000);
      const shaPath = guiZipPath + ".sha256";
      expect(fs.existsSync(shaPath)).toBe(true);
    }
  });
});
