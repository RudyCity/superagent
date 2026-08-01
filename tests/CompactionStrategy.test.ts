import { describe, it, expect } from "vitest";
import {
  CompactionStrategy,
  CompactionContext,
} from "../src/core/context/CompactionStrategy.js";
import { SummarizationStrategy } from "../src/core/context/strategies/SummarizationStrategy.js";
import { PruningStrategy } from "../src/core/context/strategies/PruningStrategy.js";
import { PinningStrategy } from "../src/core/context/strategies/PinningStrategy.js";
import { Message } from "../src/core/conversation.js";

describe("CompactionStrategy", () => {
  it("should define strategy interface", () => {
    const strategy: CompactionStrategy = {
      name: "test",
      canHandle: () => true,
      execute: async () => ({ messages: [], metadata: {} }),
      estimateCost: () => ({ tokens: 0, time: 0, apiCalls: 0 }),
    };

    expect(strategy.name).toBe("test");
  });

  it("should execute summarization strategy", async () => {
    const strategy = new SummarizationStrategy();
    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
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

    const result = await strategy.execute(messages, { preserveRecent: 10 });
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.metadata.strategy).toBe("summarization");
    expect(result.metadata.summary).toBeDefined();
  });

  it("should execute pruning strategy with emergency summary", async () => {
    const strategy = new PruningStrategy();
    const messages: Message[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i} with some content about src/file${i}.ts`,
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
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.metadata.strategy).toBe("pruning-with-emergency-summary");
    expect(result.metadata.summary).toContain("messages");
  });

  it("should execute pinning strategy when pinned messages exist", async () => {
    const strategy = new PinningStrategy();
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: 1000 + i,
      });
    }

    const pinnedId = `0:user:1000`;
    const pinnedIds = new Set<string>();
    pinnedIds.add(pinnedId);

    const context: CompactionContext = {
      messages,
      tokenBudget: 1000,
      hasPinnedMessages: true,
      pinnedMessageIds: pinnedIds,
    };

    expect(strategy.canHandle(context)).toBe(true);

    const result = await strategy.execute(messages, {
      preserveRecent: 5,
      pinnedMessageIds: pinnedIds,
    });
    expect(result.metadata.strategy).toBe("pinning");
    expect(result.metadata.pinnedCount).toBe(1);
  });

  it("pruning should always be able to handle", () => {
    const strategy = new PruningStrategy();
    const context: CompactionContext = {
      messages: [],
      tokenBudget: 0,
      hasPinnedMessages: false,
    };
    expect(strategy.canHandle(context)).toBe(true);
  });

  it("summarization should require more than 10 messages", () => {
    const strategy = new SummarizationStrategy();
    const smallContext: CompactionContext = {
      messages: [{ role: "user", content: "Hi", timestamp: 1 }],
      tokenBudget: 1000,
      hasPinnedMessages: false,
    };
    expect(strategy.canHandle(smallContext)).toBe(false);
  });

  it("should enforce byte budget in pruning strategy by truncating large contents and pruning if necessary", async () => {
    const strategy = new PruningStrategy();
    const messages: Message[] = [
      {
        role: "user",
        content: "c".repeat(5000), // older message to be pruned
        timestamp: 99,
      },
      {
        role: "user",
        content: "normal user input",
        timestamp: 100,
      },
      {
        role: "assistant",
        content: "a".repeat(60000), // very large content
        timestamp: 101,
      },
      {
        role: "tool",
        content: "tool message",
        toolResults: [
          {
            toolCallId: "call1",
            name: "run_command",
            result: "b".repeat(60000), // very large result
          }
        ],
        timestamp: 102,
      }
    ];

    const result = await strategy.execute(messages, {
      preserveRecent: 5,
      byteBudget: 102 * 1024,
    });

    expect(result.metadata.strategy).toBe("pruning-with-emergency-summary");
    // Verify that the oldest user message was pruned
    expect(result.messages.some(m => typeof m.content === "string" && m.content.includes("c".repeat(5000)))).toBe(false);
    
    // Verify that the truncated messages are kept
    const lastMsg = result.messages[result.messages.length - 1];
    expect(lastMsg.role).toBe("tool");
    expect(lastMsg.toolResults?.[0].result).toContain("TRUNCATED");
    expect(lastMsg.toolResults?.[0].result.length).toBeLessThan(60000);
  });


  it("should prevent starting kept slice with tool message in pruning strategy after byte budget pruning", async () => {
    const strategy = new PruningStrategy();
    const messages: Message[] = [
      { role: "user", content: "User 1", timestamp: 1 },
      { role: "assistant", content: "a".repeat(100), timestamp: 2 },
      {
        role: "tool",
        content: "",
        toolResults: [{ toolCallId: "c1", name: "t1", result: "b".repeat(100) }],
        timestamp: 3,
      },
      { role: "user", content: "User 2", timestamp: 4 }
    ];

    const result = await strategy.execute(messages, {
      preserveRecent: 3,
      byteBudget: 250,
    });

    const kept = result.messages.slice(1);
    expect(kept[0].role).not.toBe("tool");
    expect(kept[0].content).toBe("User 2");
  });

  it("should prevent starting kept slice with tool message in summarization strategy after token budget pruning", async () => {
    const strategy = new SummarizationStrategy();
    const messages: Message[] = [
      { role: "user", content: "User 1", timestamp: 1 },
      { role: "assistant", content: "a".repeat(800), timestamp: 2 },
      {
        role: "tool",
        content: "",
        toolResults: [{ toolCallId: "c1", name: "t1", result: "t1 result" }],
        timestamp: 3,
      },
      { role: "user", content: "User 2", timestamp: 4 }
    ];

    const result = await strategy.execute(messages, {
      preserveRecent: 3,
      tokenBudget: 900,
    });

    const kept = result.messages.slice(1);
    expect(kept[0].role).not.toBe("tool");
    expect(kept[0].content).toBe("User 2");
  });
});
