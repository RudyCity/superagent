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

    const pinnedId = `user:1000:Message 0`;
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
});
