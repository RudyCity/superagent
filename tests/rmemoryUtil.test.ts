import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { checkAndPerformDbMigration } from "../src/core/rmemoryUtil.js";

describe("checkAndPerformDbMigration", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = path.join(os.tmpdir(), `superagent-test-rmemory-${Date.now()}-${Math.random().toString(36).substring(7)}`);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should create metadata.json when starting fresh", () => {
    checkAndPerformDbMigration(testDir, "Xenova/all-MiniLM-L6-v2", 384);
    const metadataPath = path.join(testDir, "metadata.json");
    expect(fs.existsSync(metadataPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    expect(content.modelName).toBe("Xenova/all-MiniLM-L6-v2");
    expect(content.dimensions).toBe(384);
  });

  it("should perform migration and remove stale DB files when dimensions mismatch", () => {
    // Setup existing metadata with 384 dims and a dummy vector DB file
    const metadataPath = path.join(testDir, "metadata.json");
    fs.writeFileSync(metadataPath, JSON.stringify({ modelName: "Xenova/all-MiniLM-L6-v2", dimensions: 384 }), "utf-8");
    const dbFile = path.join(testDir, "vectors.db");
    fs.writeFileSync(dbFile, "dummy db content", "utf-8");

    // Perform migration to 768 dims (e.g. nomic model)
    checkAndPerformDbMigration(testDir, "nomic-ai/nomic-embed-text-v1.5", 768);

    // Dummy DB file should be wiped
    expect(fs.existsSync(dbFile)).toBe(false);

    // Metadata should be updated to 768
    const updatedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    expect(updatedMetadata.modelName).toBe("nomic-ai/nomic-embed-text-v1.5");
    expect(updatedMetadata.dimensions).toBe(768);
  });

  it("should preserve DB files when model and dimensions match", () => {
    const metadataPath = path.join(testDir, "metadata.json");
    fs.writeFileSync(metadataPath, JSON.stringify({ modelName: "nomic-ai/nomic-embed-text-v1.5", dimensions: 768 }), "utf-8");
    const dbFile = path.join(testDir, "vectors.db");
    fs.writeFileSync(dbFile, "important db content", "utf-8");

    checkAndPerformDbMigration(testDir, "nomic-ai/nomic-embed-text-v1.5", 768);

    expect(fs.existsSync(dbFile)).toBe(true);
    expect(fs.readFileSync(dbFile, "utf-8")).toBe("important db content");
  });
});
