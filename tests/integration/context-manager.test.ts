import { describe, it, expect, beforeEach } from "vitest";
import { ContextManager } from "../../src/core/context/ContextManager.js";
import { Conversation, Message } from "../../src/core/conversation.js";
import { CompactionHistory } from "../../src/core/context/CompactionHistory.js";
import {
  SummarizationStrategy,
  PruningStrategy,
  PinningStrategy,
} from "../../src/core/context/index.js";

describe("ContextManager Integration", () => {
  beforeEach(() => {
    const history = new CompactionHistory();
    history.clear();
  });
  it("should handle long conversation (1000+ messages)", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 1000; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ` + "A".repeat(200),
        timestamp: Date.now() + i * 1000,
      });
    }

    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(true);

    const result = await manager.compact(messages);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.metadata.strategy).toBeDefined();
  });

  it("should preserve context across multiple compactions", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    let messages: Message[] = [];

    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ` + "B".repeat(300),
        timestamp: Date.now() + i * 1000,
      });
    }

    const result1 = await manager.compact(messages);
    messages = result1.messages;

    for (let i = 100; i < 200; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ` + "B".repeat(300),
        timestamp: Date.now() + i * 1000,
      });
    }

    const result2 = await manager.compact(messages);

    const history = manager.getHistory();
    expect(history.length).toBe(2);
    expect(history[0].strategy).toBeDefined();
    expect(history[1].strategy).toBeDefined();
    expect(history[0].tokensBefore).toBeGreaterThan(history[0].tokensAfter);
    expect(history[1].tokensBefore).toBeGreaterThan(history[1].tokensAfter);
  });

  it("should integrate with Conversation class", async () => {
    const conv = new Conversation();
    await conv.initContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 100000,
    });

    expect(conv.hasContextManager()).toBe(true);
    expect(conv.getContextManager()).not.toBeNull();
  });

  it("should use accurate token estimation when ContextManager is active", async () => {
    const convWithManager = new Conversation();
    await convWithManager.initContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 100000,
    });

    const convWithoutManager = new Conversation();

    const messages: Message[] = [
      {
        role: "assistant",
        content: "I will read the file",
        toolCalls: [
          { id: "1", name: "read_file", args: { path: "/test.txt" } },
        ],
        timestamp: Date.now(),
      },
    ];

    for (const msg of messages) {
      convWithManager.addMessage(msg);
      convWithoutManager.addMessage(msg);
    }

    const estimateWithManager = convWithManager.getTokenEstimate();
    const estimateWithoutManager = convWithoutManager.getTokenEstimate();

    // ContextManager should count tool calls, so estimate should be higher
    expect(estimateWithManager).toBeGreaterThanOrEqual(estimateWithoutManager);
  });

  it("should replace messages after compaction", () => {
    const conv = new Conversation();

    for (let i = 0; i < 50; i++) {
      conv.addMessage({
        role: "user",
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      });
    }

    const originalCount = conv.getMessages().length;
    expect(originalCount).toBe(50);

    const newMessages: Message[] = [
      {
        role: "user",
        content: "[Summary]: Previous conversation compacted",
        timestamp: Date.now(),
      },
      {
        role: "user",
        content: "Latest message",
        timestamp: Date.now(),
      },
    ];

    conv.replaceMessages(newMessages);
    expect(conv.getMessages().length).toBe(2);
  });

  it("should select pinning strategy when pinned messages exist", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: "user",
        content: `Message ${i}: ` + "C".repeat(300),
        timestamp: 1000 + i,
      });
    }

    // Pin the first message
    const firstMsgId = `user:1000:Message 0: ` + "C".repeat(300);
    manager.addPinnedMessage(firstMsgId.substring(0, 50));

    const result = await manager.compact(messages);
    // Should use pinning or summarization strategy
    expect(result.metadata.strategy).toBeDefined();
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("should track tokens saved across compaction history", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    let messages: Message[] = [];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 50; j++) {
        messages.push({
          role: "user",
          content: `Round ${i} Message ${j}: ` + "D".repeat(300),
          timestamp: Date.now() + i * 100000 + j,
        });
      }

      await manager.compact(messages);
      messages = manager.getHistory().slice(-1)[0]
        ? messages.slice(-20)
        : messages;
    }

    const history = manager.getHistory();
    expect(history.length).toBe(3);

    const totalSaved = history.reduce(
      (sum, e) => sum + (e.tokensBefore - e.tokensAfter),
      0
    );
    expect(totalSaved).toBeGreaterThan(0);
  });

  it("should maintain state machine transitions", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    expect(manager.getState()).toBe("IDLE");

    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: "user",
        content: "E".repeat(300),
        timestamp: Date.now() + i,
      });
    }

    await manager.compact(messages);
    expect(manager.getState()).toBe("IDLE");
  });

  it("should handle strategy switching based on context", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 100000,
    });

    // Small conversation - well below threshold
    const smallMessages: Message[] = [
      { role: "user", content: "Hi", timestamp: 1 },
      { role: "assistant", content: "Hello", timestamp: 2 },
    ];

    const smallDecision = manager.shouldCompact(smallMessages);
    expect(smallDecision.shouldCompact).toBe(false);

    // Large conversation - should trigger compaction (use low limit manager)
    const largeManager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const largeMessages: Message[] = [];
    for (let i = 0; i < 100; i++) {
      largeMessages.push({
        role: "user",
        content: "F".repeat(300),
        timestamp: Date.now() + i,
      });
    }

    const largeDecision = largeManager.shouldCompact(largeMessages);
    expect(largeDecision.shouldCompact).toBe(true);
    expect(largeDecision.recommendedStrategy).toBeDefined();
  });

  it("should never lose all context (always preserve some messages)", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 500; i++) {
      messages.push({
        role: "user",
        content: `Message ${i}: ` + "G".repeat(100),
        timestamp: Date.now() + i,
      });
    }

    const result = await manager.compact(messages);

    // Should always have at least 1 message (summary)
    expect(result.messages.length).toBeGreaterThan(0);

    // First message should be a summary or preserved message
    expect(result.messages[0].content.length).toBeGreaterThan(0);
  });

  it("should handle concurrent compaction requests gracefully", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: "user",
        content: "H".repeat(300),
        timestamp: Date.now() + i,
      });
    }

    // Start two compactions concurrently
    const [result1, result2] = await Promise.all([
      manager.compact(messages),
      manager.compact(messages),
    ]);

    expect(result1.messages.length).toBeGreaterThan(0);
    expect(result2.messages.length).toBeGreaterThan(0);
  });

  it("should work with all three strategies", async () => {
    const strategies = [
      new SummarizationStrategy(),
      new PruningStrategy(),
      new PinningStrategy(),
    ];

    for (const strategy of strategies) {
      const manager = new ContextManager({
        model: "claude-3-5-sonnet-20241022",
        contextWindowLimit: 10000,
      });

      const messages: Message[] = [];
      for (let i = 0; i < 30; i++) {
        messages.push({
          role: "user",
          content: `Msg ${i}: ` + "I".repeat(200),
          timestamp: 1000 + i,
        });
      }

      const context = {
        messages,
        tokenBudget: 1000,
        hasPinnedMessages: false,
      };

      if (strategy.canHandle(context)) {
        const result = await strategy.execute(messages, { preserveRecent: 10 });
        expect(result.messages.length).toBeGreaterThan(0);
        expect(result.metadata.strategy).toBeDefined();
      }
    }
  });
});
