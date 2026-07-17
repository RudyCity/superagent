import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  addToKnowledge,
  removeFromKnowledge,
  removeKnowledgeByPin,
  updateKnowledgeTag,
  searchKnowledge,
  syncAllPinnedToRMemory
} from "../src/core/pinnedKnowledge.js";
import * as configModule from "../src/core/config.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";

vi.mock("../src/core/config.js", () => ({
  getSettings: vi.fn().mockReturnValue({ enableRmemory: false }),
  getRootConfigDir: vi.fn(),
  ensureGlobalConfigDir: vi.fn(),
}));

vi.mock("../src/core/rmemoryUtil.js", () => {
  const mockClient = {
    updateAtomic: vi.fn().mockResolvedValue({ id: "test", updated_at: "now" }),
    deleteAtomic: vi.fn().mockResolvedValue(undefined),
    searchAtomic: vi.fn().mockResolvedValue({ items: [] }),
  };
  return {
    getRMemoryClient: vi.fn().mockReturnValue(mockClient),
  };
});

describe("pinnedKnowledge", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-pinned-knowledge-test-${process.pid}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    clearModelConfigCache();
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    fs.mkdirSync(testConfigDir, { recursive: true });
    
    // Setup getRootConfigDir mock
    vi.mocked(configModule.getRootConfigDir).mockReturnValue(testConfigDir);
  });

  afterEach(() => {
    clearModelConfigCache();
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  describe("local CRUD operations", () => {
    it("should add, update tag, and remove pinned knowledge locally", async () => {
      const pin = {
        id: "msg1",
        role: "user",
        content: "Important code architecture decision",
        timestamp: Date.now(),
        pinnedAt: Date.now(),
        originalIndex: 0,
      };

      const id = addToKnowledge(pin, "/path/to/session.json", "/path/to/project");
      expect(id).toBeDefined();

      // Read file to check if it's there
      const storeFile = path.join(testConfigDir, "pinned-knowledge.json");
      expect(fs.existsSync(storeFile)).toBe(true);
      const storeContent = JSON.parse(fs.readFileSync(storeFile, "utf-8"));
      expect(storeContent.entries.length).toBe(1);
      expect(storeContent.entries[0].content).toBe(pin.content);

      // Search it
      const results = await searchKnowledge("architecture");
      expect(results.length).toBe(1);
      expect(results[0].id).toBe(id);

      // Update tag
      updateKnowledgeTag("/path/to/session.json", pin.content, "auth");
      const updatedResults = await searchKnowledge("architecture");
      expect(updatedResults[0].tag).toBe("auth");

      // Remove it
      const removed = removeFromKnowledge(id);
      expect(removed).toBe(true);
      const postRemoveResults = await searchKnowledge("architecture");
      expect(postRemoveResults.length).toBe(0);
    });
  });

  describe("rmemory sync operations", () => {
    it("should trigger rmemory sync if enabled", async () => {
      vi.mocked(configModule.getSettings).mockReturnValue({ enableRmemory: true });
      const { getRMemoryClient } = await import("../src/core/rmemoryUtil.js");
      const mockClient = getRMemoryClient();

      const pin = {
        id: "msg_rmemory",
        role: "user",
        content: "RMemory Sync Test Content",
        timestamp: Date.now(),
        pinnedAt: Date.now(),
        originalIndex: 1,
      };

      const id = addToKnowledge(pin, "/path/to/session.json", "/path/to/project");
      expect(id).toBeDefined();

      // Wait a moment for fire-and-forget Promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(mockClient.updateAtomic).toHaveBeenCalled();

      // Update tag
      updateKnowledgeTag("/path/to/session.json", pin.content, "tag-test");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockClient.updateAtomic).toHaveBeenCalledTimes(2);

      // Remove pin
      removeKnowledgeByPin("/path/to/session.json", pin.content);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockClient.deleteAtomic).toHaveBeenCalled();
    });

    it("should perform search using RMemory when enabled", async () => {
      vi.mocked(configModule.getSettings).mockReturnValue({ enableRmemory: true });
      const { getRMemoryClient } = await import("../src/core/rmemoryUtil.js");
      const mockClient = getRMemoryClient();

      const pin = {
        id: "msg_search",
        role: "user",
        content: "Search Semantic Test",
        timestamp: Date.now(),
        pinnedAt: Date.now(),
        originalIndex: 2,
      };

      const id = addToKnowledge(pin, "/path/to/session.json", "/path/to/project");

      vi.mocked(mockClient.searchAtomic).mockResolvedValueOnce({
        items: [
          {
            id: `pinned-knowledge-${id}`,
            content: "Search Semantic Test",
            type: "memory",
            score: 0.9,
          },
        ],
      });

      const results = await searchKnowledge("Semantic");
      expect(mockClient.searchAtomic).toHaveBeenCalledWith({ query: "Semantic", limit: 40 });
      expect(results.length).toBe(1);
      expect(results[0].content).toBe(pin.content);

      // Clean up for test isolation
      removeFromKnowledge(id);
    });

    it("should sync all existing pinned entries to RMemory", async () => {
      vi.mocked(configModule.getSettings).mockReturnValue({ enableRmemory: true });
      const { getRMemoryClient } = await import("../src/core/rmemoryUtil.js");
      const mockClient = getRMemoryClient();

      // Seed local storage with two entries directly (rmemory disabled)
      vi.mocked(configModule.getSettings).mockReturnValue({ enableRmemory: false });
      addToKnowledge(
        { id: "e1", role: "user", content: "Entry 1", timestamp: Date.now(), pinnedAt: Date.now(), originalIndex: 0 },
        "/session",
        "/project"
      );
      addToKnowledge(
        { id: "e2", role: "user", content: "Entry 2", timestamp: Date.now(), pinnedAt: Date.now(), originalIndex: 1 },
        "/session",
        "/project"
      );

      vi.mocked(configModule.getSettings).mockReturnValue({ enableRmemory: true });
      vi.mocked(mockClient.updateAtomic).mockClear();

      await syncAllPinnedToRMemory();
      expect(mockClient.updateAtomic).toHaveBeenCalledTimes(2);
    });
  });
});
