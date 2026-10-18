import { describe, it, expect, vi, beforeEach, mock, afterAll } from "vitest";
import path from "path";

const mockAddConversation = vi.fn();
const mockSearchAtomic = vi.fn();
const mockReadCore = vi.fn();
const mockListScenarios = vi.fn();


vi.mock("../src/core/config.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    getSettings: () => ({
      rmemoryGatewayUrl: "http://127.0.0.1:8420",
      rmemoryGatewayApiKey: "sk-xxxx",
      rmemoryServiceId: "default",
      enableRmemory: true,
    }),
  };
});

vi.mock("../src/core/config/jsonConfig.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    getSettings: () => ({
      rmemoryGatewayUrl: "http://127.0.0.1:8420",
      rmemoryGatewayApiKey: "sk-xxxx",
      rmemoryServiceId: "default",
      enableRmemory: true,
    }),
  };
});

import * as configModule from "../src/core/config.js";
import * as rmemoryUtilModule from "../src/core/rmemoryUtil.js";
import { RMemoryStrategy } from "../src/core/context/strategies/RMemoryStrategy.js";

describe("RMemoryStrategy", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAddConversation.mockResolvedValue({ total_count: 10 });
    mockSearchAtomic.mockResolvedValue({ items: [] });
    mockReadCore.mockResolvedValue({ content: "" });
    mockListScenarios.mockResolvedValue({ entries: [] });

    vi.spyOn(rmemoryUtilModule, "getRMemoryClient").mockReturnValue({
      addConversation: mockAddConversation,
      searchAtomic: mockSearchAtomic,
      readCore: mockReadCore,
      listScenarios: mockListScenarios,
    } as any);
    vi.spyOn(rmemoryUtilModule, "getRMemorySessionKey").mockReturnValue("test-sess");
    vi.spyOn(rmemoryUtilModule, "getRMemoryProjectId").mockReturnValue("p_test_project");

    vi.spyOn(configModule, "getSettings").mockReturnValue({
      rmemoryGatewayUrl: "http://127.0.0.1:8420",
      rmemoryGatewayApiKey: "sk-xxxx",
      rmemoryServiceId: "default",
      enableRmemory: true,
    } as any);
  });
  it("should define strategy interface", () => {
    const strategy = new RMemoryStrategy();
    expect(strategy.name).toBe("rmemory");
  });

  it("should successfully compact and format memories when gateway is active", async () => {
    mockAddConversation.mockResolvedValue({ total_count: 10 });
    mockSearchAtomic.mockResolvedValue({
      items: [
        {
          id: "1", content: "[project:p_test_project] User loves coding in TypeScript", type: "decision", score: 0.9,
          metadata: { scope: "project", projectId: "p_test_project", schemaVersion: 1, validationStatus: "unverified", provenance: { source: "rmemory_save" } },
        }
      ]
    });
    mockReadCore.mockResolvedValue({
      content: "User profile: Software Engineer, prefers light mode."
    });
    mockListScenarios.mockResolvedValue({
      entries: [{ path: "scene_blocks/coding-style.md" }]
    });

    const strategy = new RMemoryStrategy();
    const messages: Message[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      });
    }

    const context: CompactionContext = {
      messages,
      tokenBudget: 1000,
      hasPinnedMessages: false,
    };

    expect(strategy.canHandle(context)).toBe(true);

    const result = await strategy.execute(messages, { preserveRecent: 5 });

    // Check that we captured conversation
    expect(mockAddConversation).toHaveBeenCalled();

    // Check that we recalled memories
    expect(mockSearchAtomic).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p_test_project" }));
    expect(mockAddConversation).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p_test_project", session_id: "test-sess" }));
    expect(mockReadCore).toHaveBeenCalled();
    expect(mockListScenarios).toHaveBeenCalled();

    // Verify output structure
    expect(result.messages.length).toBeLessThanOrEqual(6); // 1 memory message + 5 preserved
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("[RMemory Agent Memory Context]");
    expect(result.messages[0].content).toContain("User profile");
    expect(result.messages[0].content).toContain("TypeScript");
    expect(result.messages[0].content).toContain("scope=project");
    expect(result.messages[0].content).toContain("validation=unverified");
    expect(result.messages[0].content).toContain("source=rmemory_save");
    expect(result.messages[0].content).toContain("scene_blocks/coding-style.md");
    expect(result.metadata.strategy).toBe("rmemory");
  });

  it("should fallback to SummarizationStrategy when gateway calls throw an error", async () => {
    mockAddConversation.mockRejectedValue(new Error("Gateway connection timeout"));

    const strategy = new RMemoryStrategy();
    const messages: Message[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      });
    }

    const result = await strategy.execute(messages, { preserveRecent: 5 });

    // Verify it fell back to summarization
    expect(result.metadata.strategy).toBe("summarization");
    expect(result.messages[0].content).toContain("[System Conversation Summary]");
  });

  it("should use offline cooldown after first failure and skip gateway calls within 5 minutes", async () => {
    // First call: gateway fails
    mockAddConversation.mockRejectedValue(new Error("Connection refused"));

    const strategy = new RMemoryStrategy();
    const messages: Message[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      });
    }

    // First call — should try gateway, fail, and cache offline state
    const result1 = await strategy.execute(messages, { preserveRecent: 5 });
    expect(result1.metadata.strategy).toBe("summarization");

    // Clear mock call count
    mockAddConversation.mockClear();

    // Second call immediately — should skip gateway calls due to offline cooldown
    const result2 = await strategy.execute(messages, { preserveRecent: 5 });
    expect(mockAddConversation).not.toHaveBeenCalled(); // key: no gateway call
    expect(result2.metadata.strategy).toBe("summarization");

    // Third call also hits cooldown
    mockAddConversation.mockClear();
    const result3 = await strategy.execute(messages, { preserveRecent: 5 });
    expect(mockAddConversation).not.toHaveBeenCalled();
    expect(result3.metadata.strategy).toBe("summarization");
  });

  it("should inject warning header and tag past vs current sessions in brand new session", async () => {
    mockAddConversation.mockResolvedValue({ total_count: 1 });
    mockSearchAtomic.mockResolvedValue({
      items: [
        {
          id: "msg-1",
          content: "Previous session command",
          type: "message",
          score: 0.9,
          metadata: { type: "message", scope: "project", projectId: "p_test_project", session: "other-sess", role: "user" }
        },
        {
          id: "msg-2",
          content: "Current session message",
          type: "message",
          score: 0.85,
          metadata: { type: "message", scope: "project", projectId: "p_test_project", session: "test-sess", role: "assistant" }
        }
      ]
    });
    mockReadCore.mockResolvedValue({ content: "" });
    mockListScenarios.mockResolvedValue({ entries: [] });

    const strategy = new RMemoryStrategy();
    const messages: Message[] = [
      { role: "user", content: "hello", timestamp: Date.now() }
    ];

    const result = await strategy.execute(messages, { preserveRecent: 5 });

    // Expect warning header to be injected because messages.length <= 2
    expect(result.messages[0].content).toContain("IMPORTANT: This is a NEW, clean session.");
    // Expect type tags to be formatted correctly based on session matching
    expect(result.messages[0].content).toContain("- [past session user | scope=project | project=p_test_project] Previous session command");
    expect(result.messages[0].content).toContain("- [current session assistant | scope=project | project=p_test_project] Current session message");
  });

  it("withholds stale/quarantined atomics and reports bounded recall quality metrics", async () => {
    mockSearchAtomic.mockResolvedValue({ items: [
      { id: "stale-temp", content: "OLD_DEPLOYMENT_SECRET_VERSION", type: "decision", metadata: { scope: "project", projectId: "p_test_project", retentionClass: "temporary", updatedAt: "2026-01-01T00:00:00.000Z", validationStatus: "verified" } },
      { id: "quarantined", content: "QUARANTINED_LEGACY_RECORD", type: "fact", metadata: { scope: "project", projectId: "p_test_project", reviewState: "quarantined" } },
      { id: "durable", content: "STABLE_PREFERENCE_FOR_CONCISE_REPORTS", type: "preference", metadata: { scope: "global", retentionClass: "durable", validationStatus: "verified", updatedAt: "2026-01-01T00:00:00.000Z" } },
    ] });
    const result = await new RMemoryStrategy().execute([{ role: "user", content: "deployment preference", timestamp: Date.now() }], { preserveRecent: 1 });
    const context = result.messages[0].content;
    expect(context).toContain("STABLE_PREFERENCE_FOR_CONCISE_REPORTS");
    expect(context).not.toContain("OLD_DEPLOYMENT_SECRET_VERSION");
    expect(context).not.toContain("QUARANTINED_LEGACY_RECORD");
    expect(context).toContain("2 scoped memory record(s) were withheld");
    expect(result.metadata.memoryRecallStatus).toBe("partial");
    expect(result.metadata.memoryRecallScopedRecordCount).toBe(3);
    expect(result.metadata.memoryRecallInjectedCount).toBe(1);
    expect(result.metadata.memoryRecallWithheldCount).toBe(2);
    expect(result.metadata.memoryRecallEstimatedTokens).toBeGreaterThan(0);
  });

  it("distinguishes a successful empty memory search from an unavailable search", async () => {
    const strategy = new RMemoryStrategy();
    const messages: Message[] = [{ role: "user", content: "query", timestamp: Date.now() }];
    mockSearchAtomic.mockResolvedValue({ items: [] });
    const empty = await strategy.execute(messages, { preserveRecent: 1 });
    expect(empty.metadata.memoryRecallStatus).toBe("empty");
    expect(empty.messages[0].content).toContain("search completed successfully and returned no records eligible for this project/global scope");

    mockSearchAtomic.mockRejectedValue(new Error("memory provider offline"));
    // Use another query so the previous deterministic result is not a cache hit.
    const unavailable = await strategy.execute([{ role: "user", content: "different query", timestamp: Date.now() + 1 }], { preserveRecent: 1 });
    expect(unavailable.metadata.memoryRecallStatus).toBe("unavailable");
    expect(unavailable.messages[0].content).toContain("search was unavailable for this compaction");
    expect(unavailable.messages[0].content).not.toContain("search completed successfully and returned no records eligible for this project/global scope");
  });

  it("withholds same-key conflicting assertions and rejects other-project results before injection", async () => {
    mockSearchAtomic.mockResolvedValue({ items: [
      { id: "node-a", content: "[project:p_test_project] Runtime uses Node 20", type: "decision", metadata: { scope: "project", projectId: "p_test_project", assertionKey: "runtime-node-version", validationStatus: "verified", updatedAt: "2026-10-17T00:00:00.000Z" } },
      { id: "node-b", content: "[project:p_test_project] Runtime uses Node 22", type: "decision", metadata: { scope: "project", projectId: "p_test_project", assertionKey: "runtime-node-version", validationStatus: "verified", updatedAt: "2026-10-17T00:00:00.000Z" } },
      { id: "foreign", content: "FOREIGN_PROJECT_RUNTIME_SECRET", type: "fact", metadata: { scope: "project", projectId: "p_other_project", validationStatus: "verified" } },
    ] });
    const result = await new RMemoryStrategy().execute([{ role: "user", content: "runtime version", timestamp: Date.now() }], { preserveRecent: 1 });
    const context = result.messages[0].content;
    expect(context).not.toContain("Runtime uses Node 20");
    expect(context).not.toContain("Runtime uses Node 22");
    expect(context).not.toContain("FOREIGN_PROJECT_RUNTIME_SECRET");
    expect(context).toContain("2 scoped memory record(s) were withheld");
    expect(result.metadata.memoryRecallStatus).toBe("conflict");
    expect(result.metadata.memoryRecallConflictPairCount).toBe(1);
    expect(result.metadata.memoryRecallConflictingRecordCount).toBe(2);
    expect(result.metadata.memoryRecallCrossScopeRejectedCount).toBe(1);
  });

  afterAll(() => {});
});