import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { fuzzyScore, searchHistory, clearSemanticSearchCache, computeBm25FuzzyScore } from "../src/core/historySearch.js";
import { searchHistoryTool } from "../src/core/tools/otherTools.js";
import { agentLocalStorage } from "../src/core/agent.js";
import * as configModule from "../src/core/config.js";
import { clearModelConfigCache } from "../src/core/config/jsonConfig.js";
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

vi.mock("../src/core/rmemoryUtil.js", () => {
  const mockClient = {
    searchConversation: vi.fn().mockResolvedValue({ messages: [] }),
    searchAtomic: vi.fn().mockResolvedValue({ items: [] }),
    getConversationMessages: vi.fn().mockResolvedValue([]),
    addConversation: vi.fn().mockResolvedValue({ accepted_ids: ["ok"], total_count: 1 }),
  };
  return {
    getRMemoryClient: vi.fn().mockReturnValue(mockClient),
    getRMemorySessionKey: vi.fn().mockReturnValue("test-session"),
  };
});

describe("historySearch", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-history-search-${process.pid}`);

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    clearModelConfigCache();
    clearSemanticSearchCache();
    fs.rmSync(testConfigDir, { recursive: true, force: true });
  });

  afterEach(() => {
    clearModelConfigCache();
    clearSemanticSearchCache();
    fs.rmSync(testConfigDir, { recursive: true, force: true });
    process.env = originalEnv;
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

  describe("computeBm25FuzzyScore", () => {
    const docFreqs = { react: 1, vue: 2 };
    const numDocs = 3;

    it("should award higher score to rare terms (higher IDF)", () => {
      // "react" is rarer (df=1) than "vue" (df=2), so its IDF is higher
      const scoreReact = computeBm25FuzzyScore("react framework", ["react"], docFreqs, numDocs, 10, 10);
      const scoreVue = computeBm25FuzzyScore("vue framework", ["vue"], docFreqs, numDocs, 10, 10);
      expect(scoreReact).toBeGreaterThan(scoreVue);
    });

    it("should saturate term frequency score growth", () => {
      // Document 1 mentions "react" once
      const scoreOnce = computeBm25FuzzyScore("react", ["react"], docFreqs, numDocs, 10, 10);
      // Document 2 mentions "react" 5 times
      const scoreFive = computeBm25FuzzyScore("react react react react react", ["react"], docFreqs, numDocs, 10, 10);

      // Score for 5 mentions should be larger, but NOT 5 times larger due to saturation limit
      expect(scoreFive).toBeGreaterThan(scoreOnce);
      expect(scoreFive).toBeLessThan(scoreOnce * 2.5);
    });

    it("should normalize score based on document length", () => {
      // Document 1 is short (10 words)
      const scoreShort = computeBm25FuzzyScore("react coding tutorial", ["react"], docFreqs, numDocs, 10, 10);
      // Document 2 is very long (100 words) but also mentions "react" once
      const scoreLong = computeBm25FuzzyScore("react " + "word ".repeat(99), ["react"], docFreqs, numDocs, 100, 10);

      // Shorter document wins because it has higher keyword density/less noise
      expect(scoreShort).toBeGreaterThan(scoreLong);
    });

    it("should apply penalty for fuzzy/subsequence matches", () => {
      // Exact match "react"
      const scoreExact = computeBm25FuzzyScore("react coding", ["react"], docFreqs, numDocs, 10, 10);
      // Fuzzy subsequence match "rct" -> matches "react"
      const scoreFuzzy = computeBm25FuzzyScore("react coding", ["rct"], { rct: 1 }, numDocs, 10, 10);

      expect(scoreExact).toBeGreaterThan(scoreFuzzy);
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

      const spyReadFile = vi.spyOn(fs.promises, "readFile").mockImplementation(async (p) => {
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
      }) as any;

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
      vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        JSON.stringify([
          { role: "user" }, // missing content
          { role: "assistant", content: null }, // non-string content
          { role: "user", content: "valid search query here" },
        ])
      );

      const result = await searchHistory("search query", false);
      expect(result).toContain("Bad Session");
    });

    it("should perform Hybrid TF-IDF + Fuzzy Search and return matched highlights", async () => {
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
      vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        JSON.stringify([
          { role: "user", content: "Query about neural networks" },
        ])
      );

      const result = await searchHistory("neural networks", false);
      expect(result).toContain("[HYBRID SEMANTIC SEARCH]");
      expect(result).toContain("AI Session");
      expect(result).toContain("[USER] Query about neural networks");
    });

    it("should call onDebug callback with detailed step-by-step logs when provided", async () => {
      const mockSessions = [
        {
          filePath: "/path/to/ai_session_debug.json",
          displayName: "Debug Session",
          messageCount: 1,
          lastModified: new Date("2026-06-25T10:00:00Z"),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);
      vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        JSON.stringify([
          { role: "user", content: "Query about deep learning" },
        ])
      );

      const debugLogs: string[] = [];
      const onDebug = (msg: string) => debugLogs.push(msg);

      await searchHistory("deep learning", false, false, onDebug);

      expect(debugLogs.length).toBeGreaterThan(0);
      expect(debugLogs.some(log => log.includes("Starting history search"))).toBe(true);
      expect(debugLogs.some(log => log.includes("Scored 1 session(s) using hybrid"))).toBe(true);
      expect(debugLogs.some(log => log.includes("Tokenized query terms"))).toBe(true);
    });

    it("should hit the in-memory cache when file is unmodified, and re-read when modified", async () => {
      const mockSessions = [
        {
          filePath: "/path/to/cache_session.json",
          displayName: "Cache Session",
          messageCount: 1,
          lastModified: new Date("2026-06-26T10:00:00Z"),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);
      const spyReadFile = vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        JSON.stringify([
          { role: "user", content: "Unique query term for caching" },
        ])
      );

      // First call - should read from file
      const result1 = await searchHistory("Unique query term", false);
      expect(result1).toContain("Cache Session");
      expect(spyReadFile).toHaveBeenCalledTimes(1);

      // Second call - same lastModified, should hit cache (no readFile)
      const result2 = await searchHistory("Unique query term", false);
      expect(result2).toContain("Cache Session");
      expect(spyReadFile).toHaveBeenCalledTimes(1);

      // Modify the session's lastModified
      mockSessions[0].lastModified = new Date("2026-06-26T11:00:00Z");

      // Third call - modified timestamp, should re-read file
      const result3 = await searchHistory("Unique query term", false);
      expect(result3).toContain("Cache Session");
      expect(spyReadFile).toHaveBeenCalledTimes(2);
    });

    it("should hit the semantic search cache on repeated exact queries when history is unchanged", async () => {
      const mockSessions = [
        {
          filePath: "/path/to/semantic_cache_session.json",
          displayName: "Semantic Cache Session",
          messageCount: 1,
          lastModified: new Date("2026-06-26T10:00:00Z"),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);
      const spyReadFile = vi.spyOn(fs.promises, "readFile").mockResolvedValue(
        JSON.stringify([
          { role: "user", content: "AI query term" },
        ])
      );

      // First call - should read the file and generate fallback
      const result1 = await searchHistory("AI query term", false);
      expect(result1).toContain("Semantic Cache Session");
      expect(spyReadFile).toHaveBeenCalledTimes(1);

      // Second call - should hit the semantic cache directly (no readFile)
      const result2 = await searchHistory("AI query term", false);
      expect(result2).toBe(result1);
      expect(spyReadFile).toHaveBeenCalledTimes(1);

      // Modify the session's lastModified to invalidate cache
      mockSessions[0].lastModified = new Date("2026-06-26T11:00:00Z");

      // Third call - should re-read because of signature mismatch
      const result3 = await searchHistory("AI query term", false);
      expect(result3).toContain("Semantic Cache Session");
      expect(spyReadFile).toHaveBeenCalledTimes(2);
    });

    it("should perform semantic search via RMemory when enabled", async () => {
      const mockSessions = [
        {
          id: "session123",
          filePath: "/path/to/session123.json",
          displayName: "RMemory Matched Session",
          messageCount: 2,
          lastModified: new Date(),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);

      const { getRMemoryClient } = await import("../src/core/rmemoryUtil.js");
      const mockClient = getRMemoryClient();
      vi.mocked(mockClient.searchConversation).mockResolvedValueOnce({
        messages: [
          {
            role: "user",
            content: "Semantic search query testing",
            timestamp: new Date().toISOString(),
            session_id: "session123"
          }
        ]
      });

      const result = await searchHistory("Semantic search query", false);
      expect(result).toContain("[RMEMORY SEMANTIC SEARCH]");
      expect(result).toContain("RMemory Matched Session");
      expect(result).toContain("[USER] Semantic search query testing");
    });

    it("should return contextual results (before, matching, after) when full messages are available", async () => {
      const mockSessions = [
        {
          id: "session_context",
          filePath: "/path/to/session_context.json",
          displayName: "Context Session",
          messageCount: 3,
          lastModified: new Date(),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);

      const { getRMemoryClient } = await import("../src/core/rmemoryUtil.js");
      const mockClient = getRMemoryClient();
      vi.mocked(mockClient.searchConversation).mockResolvedValueOnce({
        messages: [
          {
            role: "assistant",
            content: "Matching search query",
            timestamp: new Date().toISOString(),
            session_id: "session_context"
          }
        ]
      });

      vi.mocked(mockClient.getConversationMessages).mockResolvedValueOnce([
        { role: "user", content: "Before message", timestamp: new Date().toISOString() },
        { role: "assistant", content: "Matching search query", timestamp: new Date().toISOString() },
        { role: "user", content: "After message", timestamp: new Date().toISOString() },
      ]);

      const result = await searchHistory("Matching search query", false);
      expect(result).toContain("Context Session");
      expect(result).toContain("  [USER] Before message");
      expect(result).toContain("→ [ASSISTANT] Matching search query");
      expect(result).toContain("  [USER] After message");
    });

    it("should sync all unindexed historical files to RMemory", async () => {
      const mockSessions = [
        {
          id: "session_sync1",
          filePath: path.join(testConfigDir, "session_sync1.json"),
          displayName: "Sync 1",
          messageCount: 1,
          lastModified: new Date(),
          preview: "Preview",
        },
      ];

      vi.mocked(configModule.listHistorySessions).mockReturnValue(mockSessions);

      // Seed SQLite database so syncAllHistoryToRMemory can read the messages
      configModule.saveSessionToDb(
        {
          id: "session_sync1",
          filePath: path.join(testConfigDir, "session_sync1.json"),
          displayName: "Sync 1",
          messageCount: 1,
          lastModified: Date.now(),
          preview: "History message to index",
          workingDirectory: process.cwd(),
        },
        [
          { sessionId: "session_sync1", role: "user", content: "History message to index", timestamp: Date.now(), sequenceOrder: 0 }
        ]
      );

      fs.mkdirSync(testConfigDir, { recursive: true });
      fs.writeFileSync(
        path.join(testConfigDir, "session_sync1.json"),
        JSON.stringify([
          { role: "user", content: "History message to index", timestamp: Date.now() }
        ])
      );

      const { getRMemoryClient } = await import("../src/core/rmemoryUtil.js");
      const mockClient = getRMemoryClient();
      vi.mocked(mockClient.addConversation).mockClear();

      const { syncAllHistoryToRMemory } = await import("../src/core/historySearch.js");
      await syncAllHistoryToRMemory();

      expect(mockClient.addConversation).toHaveBeenCalledTimes(1);
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
      const spyReadFile = vi.spyOn(fs.promises, "readFile").mockResolvedValue(
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
      expect(listSpy).toHaveBeenCalledWith(true, false);
      expect(toolResult).toContain("Multi Session");
    });
  });
});
