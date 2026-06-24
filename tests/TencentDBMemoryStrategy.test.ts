import { describe, it, expect, vi } from "vitest";
import { TencentDBMemoryStrategy } from "../src/core/context/strategies/TencentDBMemoryStrategy.js";
import { Message } from "../src/core/conversation.js";
import { CompactionContext } from "../src/core/context/CompactionStrategy.js";

const mockAddConversation = vi.fn();
const mockSearchAtomic = vi.fn();
const mockReadCore = vi.fn();
const mockListScenarios = vi.fn();

vi.mock("@tencentdb-agent-memory/memory-sdk-ts", () => {
  class MockMemoryClient {
    addConversation = mockAddConversation;
    searchAtomic = mockSearchAtomic;
    readCore = mockReadCore;
    listScenarios = mockListScenarios;
  }
  return {
    MemoryClient: MockMemoryClient,
  };
});

describe("TencentDBMemoryStrategy", () => {
  it("should define strategy interface", () => {
    const strategy = new TencentDBMemoryStrategy();
    expect(strategy.name).toBe("tencentdb-memory");
  });

  it("should successfully compact and format memories when gateway is active", async () => {
    mockAddConversation.mockResolvedValue({ total_count: 10 });
    mockSearchAtomic.mockResolvedValue({
      items: [
        { id: "1", content: "User loves coding in TypeScript", type: "persona", score: 0.9 }
      ]
    });
    mockReadCore.mockResolvedValue({
      content: "User profile: Software Engineer, prefers light mode."
    });
    mockListScenarios.mockResolvedValue({
      entries: [{ path: "scene_blocks/coding-style.md" }]
    });

    const strategy = new TencentDBMemoryStrategy({ historyFilePath: "conversation_test.json" });
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
    expect(mockSearchAtomic).toHaveBeenCalled();
    expect(mockReadCore).toHaveBeenCalled();
    expect(mockListScenarios).toHaveBeenCalled();

    // Verify output structure
    expect(result.messages.length).toBeLessThanOrEqual(6); // 1 system memory message + 5 preserved
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toContain("[TencentDB Agent Memory Context]");
    expect(result.messages[0].content).toContain("User profile");
    expect(result.messages[0].content).toContain("TypeScript");
    expect(result.messages[0].content).toContain("scene_blocks/coding-style.md");
    expect(result.metadata.strategy).toBe("tencentdb-memory");
  });

  it("should fallback to SummarizationStrategy when gateway calls throw an error", async () => {
    mockAddConversation.mockRejectedValue(new Error("Gateway connection timeout"));

    const strategy = new TencentDBMemoryStrategy({ historyFilePath: "conversation_test.json" });
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
});
