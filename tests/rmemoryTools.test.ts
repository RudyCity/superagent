import { describe, it, expect, vi } from "vitest";
import {
  rmemorySearchTool,
  rmemoryConversationSearchTool,
  rmemoryReadCosTool,
  rmemorySaveTool,
  rmemoryConversationAddTool,
} from "../src/core/tools/rmemoryTools.js";

const mockAddConversation = vi.fn();
const mockSearchAtomic = vi.fn();
const mockSearchConversation = vi.fn();
const mockReadFile = vi.fn();
const mockUpdateAtomic = vi.fn();
const mockReadScenario = vi.fn();

vi.mock("../src/core/rmemoryUtil.js", () => {
  return {
    getRMemoryClient: () => ({
      addConversation: mockAddConversation,
      searchAtomic: mockSearchAtomic,
      searchConversation: mockSearchConversation,
      readFile: mockReadFile,
      updateAtomic: mockUpdateAtomic,
      readScenario: mockReadScenario,
    }),
    getRMemorySessionKey: () => "test-sess",
    isRmemoryActive: async () => true,
  };
});

describe("RMemory Tools", () => {
  it("should define tool metadata", () => {
    expect(rmemorySearchTool.name).toBe("rmemory_search");
    expect(rmemoryConversationSearchTool.name).toBe("rmemory_conversation_search");
    expect(rmemoryReadCosTool.name).toBe("rmemory_read_cos");
  });

  describe("rmemory_search", () => {
    it("should successfully search structured memories", async () => {
      mockSearchAtomic.mockResolvedValue({
        items: [
          { id: "1", content: "User likes dark mode", type: "persona" }
        ]
      });

      const result = await rmemorySearchTool.execute({ query: "preferences" }, ".");
      expect(result).toContain("- [persona] User likes dark mode");
      expect(mockSearchAtomic).toHaveBeenCalledWith({ query: "preferences", limit: 5 });
    });

    it("should return fallback message if no memories found", async () => {
      mockSearchAtomic.mockResolvedValue({ items: [] });
      const result = await rmemorySearchTool.execute({ query: "preferences" }, ".");
      expect(result).toBe("No memories found matching the query.");
    });

    it("should handle error when gateway fails", async () => {
      mockSearchAtomic.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemorySearchTool.execute({ query: "preferences" }, ".");
      expect(result).toContain("Memory search failed");
    });
  });

  describe("rmemory_conversation_search", () => {
    it("should successfully search conversation history", async () => {
      mockSearchConversation.mockResolvedValue({
        messages: [
          { role: "user", content: "hello world", timestamp: "2026-06-24T00:00:00.000Z" }
        ]
      });

      const result = await rmemoryConversationSearchTool.execute({ query: "hello" }, ".");
      expect(result).toContain("user: hello world");
      expect(mockSearchConversation).toHaveBeenCalledWith({ query: "hello", limit: 5 });
    });

    it("should handle error when gateway fails", async () => {
      mockSearchConversation.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemoryConversationSearchTool.execute({ query: "hello" }, ".");
      expect(result).toContain("Conversation search failed");
    });
  });

  describe("rmemory_read_cos", () => {
    it("should successfully read scenario file content", async () => {
      mockReadScenario.mockResolvedValue({
        path: "scene_blocks/style.md",
        content: "Coding style: use tabs instead of spaces",
        created_at: "2026-06-26T10:00:00.000Z",
        updated_at: "2026-06-26T10:00:00.000Z"
      });
      const result = await rmemoryReadCosTool.execute({ path: "scene_blocks/style.md" }, ".");
      expect(result).toContain("SCENARIO BLOCK FILE: scene_blocks/style.md");
      expect(result).toContain("use tabs instead of spaces");
      expect(mockReadScenario).toHaveBeenCalledWith({ path: "scene_blocks/style.md" });
    });

    it("should return error message when file is not found (content is null)", async () => {
      mockReadScenario.mockResolvedValue({
        path: "scene_blocks/style.md",
        content: null,
        created_at: null,
        updated_at: null
      });
      const result = await rmemoryReadCosTool.execute({ path: "scene_blocks/style.md" }, ".");
      expect(result).toContain("Failed to read scenario block file: File not found");
    });

    it("should handle error when file read fails", async () => {
      mockReadScenario.mockRejectedValue(new Error("Network error"));
      const result = await rmemoryReadCosTool.execute({ path: "scene_blocks/style.md" }, ".");
      expect(result).toContain("Failed to read scenario block file");
    });
  });

  describe("rmemory_save", () => {
    it("should successfully save memory with upsert and default project scope", async () => {
      mockUpdateAtomic.mockResolvedValue({
        id: "user-identity",
        updated_at: "2026-06-26T10:00:00.000Z",
      });

      const result = await rmemorySaveTool.execute(
        { id: "user-identity", content: "User name is Rudy", type: "identity" },
        "."
      );
      expect(result).toContain("Memory saved successfully");
      expect(result).toContain("user-identity");
      expect(mockUpdateAtomic).toHaveBeenCalledWith({
        id: "user-identity",
        content: "[project] User name is Rudy",
      });
    });

    it("should save memory with explicit global scope", async () => {
      mockUpdateAtomic.mockResolvedValue({
        id: "global-pref",
        updated_at: "2026-06-26T10:00:00.000Z",
      });

      const result = await rmemorySaveTool.execute(
        { id: "global-pref", content: "Prefer dark mode", scope: "global" },
        "."
      );
      expect(result).toContain("Memory saved successfully (global scope)");
      expect(mockUpdateAtomic).toHaveBeenCalledWith({
        id: "global-pref",
        content: "[global] Prefer dark mode",
      });
    });

    it("should save memory without type", async () => {
      mockUpdateAtomic.mockResolvedValue({
        id: "simple-note",
        updated_at: "2026-06-26T10:00:00.000Z",
      });

      const result = await rmemorySaveTool.execute(
        { id: "simple-note", content: "A simple note" },
        "."
      );
      expect(result).toContain("Memory saved successfully");
      expect(mockUpdateAtomic).toHaveBeenCalledWith({
        id: "simple-note",
        content: "[project] A simple note",
      });
    });

    it("should handle error when gateway fails", async () => {
      mockUpdateAtomic.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemorySaveTool.execute({ id: "test", content: "test" }, ".");
      expect(result).toContain("Failed to save memory");
    });
  });

  describe("rmemory_conversation_add", () => {
    it("should successfully add conversation message", async () => {
      mockAddConversation.mockResolvedValue({
        accepted_ids: ["msg-1"],
        total_count: 5,
      });

      const result = await rmemoryConversationAddTool.execute(
        { session_id: "session-1", role: "user", content: "Hello" },
        "."
      );
      expect(result).toContain("Conversation message added");
      expect(result).toContain("msg-1");
      expect(mockAddConversation).toHaveBeenCalledWith({
        session_id: "session-1",
        messages: [{ role: "user", content: "Hello", timestamp: expect.any(String) }],
      });
    });

    it("should handle error when gateway fails", async () => {
      mockAddConversation.mockRejectedValue(new Error("Gateway connection refused"));
      const result = await rmemoryConversationAddTool.execute(
        { session_id: "session-1", role: "user", content: "Hello" },
        "."
      );
      expect(result).toContain("Failed to add conversation message");
    });
  });
});
