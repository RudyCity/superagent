import { describe, it, expect } from "vitest";
import { ContextManager } from "../src/core/context/ContextManager.js";
import { PinningStrategy } from "../src/core/context/strategies/PinningStrategy.js";
import type { Message } from "../src/core/conversation.js";
import { subagentInstances } from "../src/core/tools/state.js";
import { manageSubagentsTool } from "../src/core/tools/subagentTools.js";

describe("ContextManager autoPinKeyMessages & PinningStrategy Safety", () => {
  it("does NOT auto-pin tool results or assistant messages containing task.md", () => {
    const cm = new ContextManager({
      model: "test-model",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [
      {
        role: "user",
        content: "Please inspect our repo and review tests.",
        timestamp: 1000,
      },
      {
        role: "assistant",
        content: "I will check sess_123_task.md to see existing tasks.",
        timestamp: 2000,
      },
      {
        role: "tool",
        content: "--- File: ~/.superagent-r/history/single/sess_123/sess_123_task.md ---\n- [ ] task 1",
        timestamp: 3000,
      },
      {
        role: "tool",
        content: "git diff showing modification to implementation_plan.md",
        timestamp: 4000,
      },
      {
        role: "user",
        content: "# Implementation Plan\n\n1. Setup database schema\n2. Run tests",
        timestamp: 5000,
      },
    ];

    cm.autoPinKeyMessages(messages);
    const pinned = cm.getPinnedMessages();

    // Only message 0 (initial user query) and message 4 (actual implementation plan) should be pinned
    expect(pinned.size).toBe(2);

    for (const key of pinned) {
      expect(key.startsWith("tool:")).toBe(false);
      expect(key.startsWith("assistant:")).toBe(false);
    }
  });

  it("PinningStrategy reduces context when token budget is exceeded", async () => {
    const strategy = new PinningStrategy();

    // Create 15 unpinned messages with significant content
    const messages: Message[] = [
      {
        role: "user",
        content: "Initial query",
        timestamp: 1000,
      },
    ];

    for (let i = 1; i <= 15; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Iteration ${i}: ` + "Long detailed analysis text ".repeat(50),
        timestamp: 1000 + i * 100,
      });
    }

    // Pass tight tokenBudget to force compaction
    const result = await strategy.execute(messages, {
      tokenBudget: 1500,
      preserveRecent: 20,
    });

    // Should have pruned older messages and created a summary
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0].content).toContain("[System Conversation Summary]");
  });

  it("manageSubagentsTool does not crash when subagent instance has undefined typeName or role", async () => {
    subagentInstances.clear();
    subagentInstances.set("test-undef", {
      id: "test-undef",
      typeName: undefined as any,
      role: undefined as any,
      agent: {} as any,
      status: "error",
      logs: [],
    });

    // Calling status on a non-existent or existing subagent should not throw TypeError
    const res = await manageSubagentsTool.execute(
      { action: "status", conversationIds: ["other-id"] },
      {} as any
    );
    expect(res).toBeDefined();
    subagentInstances.clear();
  });
});
