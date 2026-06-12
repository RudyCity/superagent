import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { fuzzyScore, searchHistory } from "../src/core/historySearch.js";
import { searchHistoryTool } from "../src/core/tools/otherTools.js";
import { agentLocalStorage } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";
import { generateText } from "ai";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModule>();
  return {
    ...actual,
    listHistorySessions: vi.fn(),
    getConfig: vi.fn().mockReturnValue({ apiKey: "" }),
    getModelInstance: vi.fn().mockReturnValue({}),
  };
});

describe("historySearch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("fuzzyScore", () => {
    it("should return 1.0 for exact substring match", () => {
      expect(fuzzyScore("Hello world from unit tests", "unit tests")).toBe(1.0);
    });

    it("should match words out of order with partial scores", () => {
      const score = fuzzyScore("Implement search history command", "command search");
      expect(score).toBe(1.0); // Both words are present
    });

    it("should fuzzy score character subsequences", () => {
      const score = fuzzyScore("refactor background task", "rfctr bckgrnd");
      expect(score).toBeGreaterThan(0.4);
    });
  });

  describe("searchHistory", () => {
    it("should support both array format and object format with messages field", async () => {
      const mockSessions = [
        {
          filePath: "/path/to/session1.json",
          displayName: "Session Array Format",
          messageCount: 2,
          lastModified: new Date("2026-06-12T10:00:00Z"),
          preview: "First preview",
        },
        {
          filePath: "/path/to/session2.json",
          displayName: "Session Object Format",
          messageCount: 2,
          lastModified: new Date("2026-06-12T11:00:00Z"),
          preview: "Second preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);

      const spyReadFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        const pathStr = typeof p === "string" ? p : p.toString();
        if (pathStr.includes("session1")) {
          // Array format
          return JSON.stringify([
            { role: "user", content: "Implement a background task runner" },
            { role: "assistant", content: "Here is the background task code" },
          ]);
        }
        if (pathStr.includes("session2")) {
          // Object format
          return JSON.stringify({
            messages: [
              { role: "user", content: "Optimize history search feature" },
              { role: "assistant", content: "We can use subsequence fuzzy scoring" },
            ],
            planState: "IDLE",
          });
        }
        throw new Error("File not found");
      });

      // Search for "background task"
      const resultBg = await searchHistory("background task", false);
      expect(resultBg).toContain("Session Array Format");
      expect(resultBg).not.toContain("Session Object Format");

      // Search for "subsequence fuzzy"
      const resultFuzzy = await searchHistory("subsequence fuzzy", false);
      expect(resultFuzzy).toContain("Session Object Format");
      expect(resultFuzzy).not.toContain("Session Array Format");
    });

    it("should handle messages with non-string or missing content gracefully without throwing", async () => {
      const mockSessions = [
        {
          filePath: "/path/to/bad_session.json",
          displayName: "Bad Session",
          messageCount: 3,
          lastModified: new Date(),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        JSON.stringify([
          { role: "user" }, // missing content
          { role: "assistant", content: null }, // non-string content
          { role: "user", content: "valid search query here" },
        ])
      );

      const result = await searchHistory("search query", false);
      expect(result).toContain("Bad Session");
    });

    it("should perform AI Semantic Search when apiKey is configured, using correct index bounds", async () => {
      const mockSessions = [
        {
          filePath: "/path/to/ai_session.json",
          displayName: "AI Session",
          messageCount: 1,
          lastModified: new Date(),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);
      vi.mocked(configModule.getConfig).mockReturnValue({ apiKey: "valid-api-key" });
      vi.spyOn(fs, "readFileSync").mockReturnValue(
        JSON.stringify([
          { role: "user", content: "Query about neural networks" },
        ])
      );

      // 1. Success case: AI returns valid candidate index [0]
      vi.mocked(generateText)
        .mockResolvedValueOnce({ text: "[0]" } as any) // Filter prompt
        .mockResolvedValueOnce({ text: "This session is about neural networks." } as any); // Summary prompt

      const result = await searchHistory("neural networks", false);
      expect(result).toContain("[AI SEMANTIC SEARCH]");
      expect(result).toContain("This session is about neural networks.");

      // 2. Hallucinated out-of-bounds case: AI returns indices that are out of bounds of candidates
      vi.mocked(generateText)
        .mockResolvedValueOnce({ text: "[5]" } as any); // Filter prompt returns out of bounds index (only 1 candidate)

      const resultOob = await searchHistory("neural networks", false);
      expect(resultOob).toContain("No semantically relevant conversation history found");
    });
  });

  describe("searchHistoryTool", () => {
    it("should detect isMultiAgent status from agentLocalStorage and call searchHistory", async () => {
      const mockSessions = [
        {
          filePath: "/path/to/session_multi.json",
          displayName: "Multi Session",
          messageCount: 1,
          lastModified: new Date(),
          preview: "Preview",
        },
      ];

      const listSpy = vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);
      const spyReadFileSync = vi.spyOn(fs, "readFileSync").mockReturnValue(
        JSON.stringify([
          { role: "user", content: "Query keyword search" },
        ])
      );

      const mockAgent = {
        isMultiAgent: true,
      };

      const toolResult = await agentLocalStorage.run(mockAgent as any, async () => {
        return await searchHistoryTool.execute({ query: "keyword" }, process.cwd(), new AbortController().signal);
      });

      // Verify listHistorySessions was called with true (multi-agent mode)
      expect(listSpy).toHaveBeenCalledWith(true);
      expect(toolResult).toContain("Multi Session");
    });
  });
});
