import { describe, it, expect } from "vitest";
import { BudgetedPruningStrategy } from "../src/core/context/strategies/BudgetedPruningStrategy.js";
import { Message } from "../src/core/conversation.js";

describe("BudgetedPruningStrategy", () => {
  it("prunes lowest-importance messages to stay within budget", async () => {
    const strategy = new BudgetedPruningStrategy();
    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: Some detailed conversation content ` + "X".repeat(200),
        timestamp: Date.now() + i * 10,
      });
    }

    const result = await strategy.execute(messages, {
      tokenBudget: 300,
      pinnedMessageIds: new Set(),
      modelName: "gpt-4",
    });

    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.metadata.strategy).toBe("budgeted-pruning");
    expect(result.metadata.messagesPruned).toBeGreaterThan(0);
  });

  it("preserves pinned messages during budgeted pruning", async () => {
    const strategy = new BudgetedPruningStrategy();
    const pinnedMsg: Message = {
      role: "user",
      content: "# Implementation Plan for Critical Feature\nMust be kept.",
      timestamp: 1000,
    };
    const messages: Message[] = [pinnedMsg];
    for (let i = 1; i < 20; i++) {
      messages.push({
        role: "assistant",
        content: `Intermediate thought ${i}: ` + "Y".repeat(200),
        timestamp: 1000 + i * 10,
      });
    }

    const pinnedStableId = `user:1000:${pinnedMsg.content.slice(0, 64)}`;
    const result = await strategy.execute(messages, {
      tokenBudget: 200,
      pinnedMessageIds: new Set([pinnedStableId]),
      modelName: "gpt-4",
    });

    expect(result.messages.some((m) => m.content === pinnedMsg.content)).toBe(true);
    expect(result.messages.length).toBeLessThan(messages.length);
  });
});
