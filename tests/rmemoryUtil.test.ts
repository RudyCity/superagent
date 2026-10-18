import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { getRMemoryStorageId } from "../src/core/rmemoryUtil.js";
import {
  checkAndPerformDbMigration,
  OptimizedLocalTextEmbeddingProvider,
  resolveScenarioPath,
} from "../src/core/rmemoryUtil.js";

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

  it("namespaces physical IDs for the same logical memory in different projects", () => {
    const projectAId = getRMemoryStorageId("framework-choice", { scope: "project", projectId: "p_project_a" });
    const projectBId = getRMemoryStorageId("framework-choice", { scope: "project", projectId: "p_project_b" });
    const globalId = getRMemoryStorageId("framework-choice", { scope: "global" });

    expect(projectAId).toBe("p_project_a:framework-choice");
    expect(projectBId).toBe("p_project_b:framework-choice");
    expect(projectAId).not.toBe(projectBId);
    expect(globalId).toBe("framework-choice");
  });

  it("should perform migration and remove stale DB files when dimensions mismatch", () => {
    // Setup existing metadata with 384 dims and a dummy vector DB file
    const metadataPath = path.join(testDir, "metadata.json");
    fs.writeFileSync(metadataPath, JSON.stringify({ modelName: "Xenova/all-MiniLM-L6-v2", dimensions: 384 }), "utf-8");
    const dbFile = path.join(testDir, "vectors.db");
    fs.writeFileSync(dbFile, "dummy db content", "utf-8");
    const personaFile = path.join(testDir, "persona.md");
    fs.writeFileSync(personaFile, "Keep user persona", "utf-8");
    const scenariosDir = path.join(testDir, "scene_blocks");
    fs.mkdirSync(scenariosDir, { recursive: true });
    fs.writeFileSync(path.join(scenariosDir, "style.md"), "Keep scenario", "utf-8");
    const notesFile = path.join(testDir, "notes.txt");
    fs.writeFileSync(notesFile, "Keep unknown files", "utf-8");
    const unrelatedDbFile = path.join(testDir, "customer-data.db");
    fs.writeFileSync(unrelatedDbFile, "Do not delete unknown databases", "utf-8");

    // Perform migration to 768 dims (e.g. nomic model)
    checkAndPerformDbMigration(testDir, "nomic-ai/nomic-embed-text-v1.5", 768);

    // Dummy DB file should be wiped
    expect(fs.existsSync(dbFile)).toBe(false);
    expect(fs.readFileSync(personaFile, "utf-8")).toBe("Keep user persona");
    expect(fs.readFileSync(path.join(scenariosDir, "style.md"), "utf-8")).toBe("Keep scenario");
    expect(fs.readFileSync(notesFile, "utf-8")).toBe("Keep unknown files");
    expect(fs.readFileSync(unrelatedDbFile, "utf-8")).toBe("Do not delete unknown databases");

    // Metadata should be updated to 768
    const updatedMetadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    expect(updatedMetadata.modelName).toBe("nomic-ai/nomic-embed-text-v1.5");
    expect(updatedMetadata.dimensions).toBe(768);
  });

  it("keeps migration backups until commit and restores the old index on rollback", () => {
    const metadataPath = path.join(testDir, "metadata.json");
    const dbFile = path.join(testDir, "vectors.db");
    const walFile = path.join(testDir, "vectors.db-wal");
    fs.writeFileSync(metadataPath, JSON.stringify({ modelName: "old-model", dimensions: 384 }), "utf-8");
    fs.writeFileSync(dbFile, "old vector index", "utf-8");
    fs.writeFileSync(walFile, "old WAL", "utf-8");

    const migration = checkAndPerformDbMigration(testDir, "new-model", 768, { deferCommit: true });
    expect(migration).toBeDefined();
    expect(fs.existsSync(dbFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(metadataPath, "utf-8")).modelName).toBe("new-model");

    fs.writeFileSync(dbFile, "partially initialized new index", "utf-8");
    migration!.rollback();
    expect(fs.readFileSync(dbFile, "utf-8")).toBe("old vector index");
    expect(fs.readFileSync(walFile, "utf-8")).toBe("old WAL");
    expect(JSON.parse(fs.readFileSync(metadataPath, "utf-8"))).toEqual({ modelName: "old-model", dimensions: 384 });
  });

  it("finalizes staged migration without deleting the replacement index", () => {
    const metadataPath = path.join(testDir, "metadata.json");
    const dbFile = path.join(testDir, "vectors.db");
    fs.writeFileSync(metadataPath, JSON.stringify({ modelName: "old-model", dimensions: 384 }), "utf-8");
    fs.writeFileSync(dbFile, "old vector index", "utf-8");

    const migration = checkAndPerformDbMigration(testDir, "new-model", 768, { deferCommit: true });
    fs.writeFileSync(dbFile, "healthy replacement index", "utf-8");
    migration!.commit();

    expect(fs.readFileSync(dbFile, "utf-8")).toBe("healthy replacement index");
    expect(JSON.parse(fs.readFileSync(metadataPath, "utf-8"))).toEqual({ modelName: "new-model", dimensions: 768 });
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

  it("rejects scenario paths outside the top-level scene_blocks directory", () => {
    const dataDir = path.join(testDir, "memory");
    const scenarioDir = path.join(dataDir, "scene_blocks");
    fs.mkdirSync(scenarioDir, { recursive: true });
    fs.writeFileSync(path.join(scenarioDir, "style.md"), "safe", "utf-8");

    expect(resolveScenarioPath(dataDir, "scene_blocks/style.md")).toBe(path.join(scenarioDir, "style.md"));
    expect(resolveScenarioPath(dataDir, "scene_blocks\\style.md")).toBe(path.join(scenarioDir, "style.md"));
    for (const unsafePath of [
      "../../outside.md",
      path.resolve(testDir, "outside.md"),
      "C:\\private\\secret.md",
      "scene_blocks/nested/secret.md",
      "scene_blocks\\\\..\\\\outside.md",
      "scene_blocks/%2e%2e/outside.md",
      "other/secret.md",
    ]) {
      expect(() => resolveScenarioPath(dataDir, unsafePath), unsafePath).toThrow();
    }
  });

  it("rejects scenario symlinks that resolve outside the memory directory", () => {
    const dataDir = path.join(testDir, "memory");
    const scenarioDir = path.join(dataDir, "scene_blocks");
    fs.mkdirSync(scenarioDir, { recursive: true });
    const outsideFile = path.join(testDir, "outside.md");
    const linkFile = path.join(scenarioDir, "linked.md");
    fs.writeFileSync(outsideFile, "outside secret", "utf-8");
    try {
      fs.symlinkSync(outsideFile, linkFile, "file");
    } catch (error) {
      if (process.platform === "win32") return;
      throw error;
    }

    expect(() => resolveScenarioPath(dataDir, "scene_blocks/linked.md")).toThrow();
  });

  it("propagates embedding failures instead of returning substitute vectors and can retry", async () => {
    const provider = new OptimizedLocalTextEmbeddingProvider({ modelName: "test-model" });
    const getExtractor = vi.spyOn(provider as any, "getExtractor");
    getExtractor
      .mockRejectedValueOnce(new Error("model unavailable"))
      .mockResolvedValueOnce(async () => ({ data: new Float32Array(provider.dimensions).fill(0.25) }));

    await expect(provider.embedText("test input")).rejects.toThrow(/model unavailable/i);
    await expect(provider.embedText("test input")).resolves.toHaveLength(provider.dimensions);
  });
});
