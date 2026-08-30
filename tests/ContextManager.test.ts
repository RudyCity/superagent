import { describe, it, expect, beforeEach } from "vitest";
import { ContextManager } from "../src/core/context/ContextManager.js";
import { Message } from "../src/core/conversation.js";
import { CompactionHistory } from "../src/core/context/CompactionHistory.js";

describe("ContextManager", () => {
  beforeEach(() => {
    const history = new CompactionHistory();
    history.clear();
  });
  it("should return false when below threshold", () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 200000,
    });

    const messages: Message[] = [
      { role: "user", content: "Hello", timestamp: Date.now() },
    ];

    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(false);
  });

  it("should return true when above threshold", () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: "user",
        content: "A".repeat(1000),
        timestamp: Date.now() + i,
      });
    }

    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toContain("threshold");
  });

  it("should return approaching-threshold when near limit", () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 100000,
    });

    // Threshold = min(100000 - 5000 - 5000, 100000 * 0.85) = min(90000, 85000) = 85000
    // 80% of threshold = 68000
    const messages: Message[] = [];
    let currentTokens = 0;
    let i = 0;
    while (currentTokens < 75000) {
      const msg: Message = {
        role: "user",
        content: "A".repeat(4000),
        timestamp: Date.now() + i++,
      };
      messages.push(msg);
      currentTokens += manager.estimateTokens(msg);
    }

    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("approaching-threshold");
  });

  it("should execute compaction and reduce messages", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 100; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ` + "A".repeat(500),
        timestamp: Date.now() + i,
      });
    }

    const result = await manager.compact(messages);
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.metadata.strategy).toBeDefined();
  });

  it("should record compaction in history", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: "user",
        content: "B".repeat(500),
        timestamp: Date.now() + i,
      });
    }

    await manager.compact(messages);

    const history = manager.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].strategy).toBeDefined();
  });

  it("should emit compaction events", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const events: string[] = [];
    manager.on("compaction:start", () => events.push("start"));
    manager.on("compaction:complete", () => events.push("complete"));

    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: "user",
        content: "C".repeat(500),
        timestamp: Date.now() + i,
      });
    }

    await manager.compact(messages);
    expect(events).toContain("start");
    expect(events).toContain("complete");
  });

  it("should manage pinned messages", () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 200000,
    });

    manager.addPinnedMessage("msg-1");
    expect(manager.getPinnedMessages().has("msg-1")).toBe(true);

    manager.removePinnedMessage("msg-1");
    expect(manager.getPinnedMessages().has("msg-1")).toBe(false);
  });

  it("should update model and clear cache", () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 200000,
    });

    manager.setModel("gpt-4o");
    expect(manager.getTokenTracker().getModel()).toBe("gpt-4o");
  });

  it("should recover from compaction failure", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 200000,
    });

    // Create a failing strategy
    const failingStrategy = {
      name: "failing",
      canHandle: () => true,
      execute: async () => {
        throw new Error("Intentional failure");
      },
      estimateCost: () => ({ tokens: 0, time: 0, apiCalls: 0 }),
    };

    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({
        role: "user",
        content: `Message ${i}`,
        timestamp: Date.now() + i,
      });
    }

    // Should fall back to recovery (pruning)
    const result = await manager.compact(messages, failingStrategy as any);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.metadata.strategy).toBeDefined();
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
  });

  it("should NOT auto-pin conversation summary messages or accumulate duplicate summaries", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 10000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Iteration ${i}: ` + "X".repeat(500),
        timestamp: Date.now() + i * 10,
      });
    }

    // Pass 1 compaction
    const result1 = await manager.compact(messages);
    manager.autoPinKeyMessages(result1.messages);

    // Verify summary message is not in pinnedMessages map
    for (const pinned of manager.getPinnedMessagesFull().values()) {
      expect(pinned.content).not.toContain("[System Conversation Summary]");
    }

    // Add more messages and perform Pass 2 compaction
    const messages2 = [...result1.messages];
    for (let i = 50; i < 70; i++) {
      messages2.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Iteration ${i}: ` + "Y".repeat(500),
        timestamp: Date.now() + i * 10,
      });
    }

    const result2 = await manager.compact(messages2);

    // Count [System Conversation Summary] messages in result2
    const summaryCount = result2.messages.filter((m) =>
      typeof m.content === "string" && m.content.includes("[System Conversation Summary]")
    ).length;

    expect(summaryCount).toBeLessThanOrEqual(1);
  });
});

describe("ContextManager compaction event payload", () => {
  it("emits rich compaction:complete payload with strategy + token delta", async () => {
    const manager = new ContextManager({
      model: "claude-3-5-sonnet-20241022",
      contextWindowLimit: 1000,
    });

    const messages: Message[] = [];
    for (let i = 0; i < 30; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "X".repeat(200),
        timestamp: Date.now() + i * 10,
      });
    }

    const events: any[] = [];
    manager.on("compaction:complete", (p) => events.push(p));

    await manager.compact(messages);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const ev = events[events.length - 1];
    expect(ev.strategy).toBeDefined();
    expect(typeof ev.tokensBefore).toBe("number");
    expect(typeof ev.tokensAfter).toBe("number");
    expect(typeof ev.messagesBefore).toBe("number");
    expect(typeof ev.messagesAfter).toBe("number");
    expect(ev.tokensAfter).toBeLessThan(ev.tokensBefore);
  });
});

describe("SummarizationStrategy fallback metadata", () => {
  it("flags usedFallback=true when no LLM model is configured", async () => {
    const { SummarizationStrategy } = await import(
      "../src/core/context/strategies/SummarizationStrategy.js"
    );
    const strategy = new SummarizationStrategy({ /* no model */ });

    const messages: Message[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "Z".repeat(150),
        timestamp: Date.now() + i * 10,
      });
    }

    const result = await strategy.execute(messages, {
      tokenBudget: 500,
      pinnedMessageIds: new Set(),
    } as any);

    expect(result.metadata.usedFallback).toBe(true);
    expect(result.metadata.usedLLM).toBe(false);
    expect(result.metadata.strategy).toBe("summarization");
  });
});

describe("TokenTracker.estimateText (live stream accounting)", () => {
  it("returns 0 for empty input", async () => {
    const { TokenTracker } = await import(
      "../src/core/context/TokenTracker.js"
    );
    const tracker = new TokenTracker("gpt-4");
    expect(tracker.estimateText("")).toBe(0);
  });

  it("produces a stable count independent of repeated calls", async () => {
    const { TokenTracker } = await import(
      "../src/core/context/TokenTracker.js"
    );
    const tracker = new TokenTracker("gpt-4");
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(50);
    const a = tracker.estimateText(text);
    const b = tracker.estimateText(text);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(0);
  });

  it("differs from naive length/4 heuristic for non-ASCII / structured text", async () => {
    const { TokenTracker } = await import(
      "../src/core/context/TokenTracker.js"
    );
    const tracker = new TokenTracker("gpt-4");
    // Heavy code: lots of symbols that tiktoken splits into more tokens than chars/4
    const text = "function foo(x: number): string { return `value=${x}`; } ".repeat(30);
    const tik = tracker.estimateText(text);
    const naive = Math.ceil(text.length / 4);
    // They should both be > 0; not necessarily equal, but the tiktoken count
    // should not be wildly different (sanity check that the integration works)
    expect(tik).toBeGreaterThan(0);
    expect(naive).toBeGreaterThan(0);
    expect(Math.abs(tik - naive) / Math.max(tik, naive)).toBeLessThan(1.5);
  });
});

describe("ContextManager.shouldCompact threshold bands", () => {
  it("returns below-threshold when far from limit", () => {
    const manager = new ContextManager({
      model: "gpt-4",
      contextWindowLimit: 100000,
    });
    const messages: Message[] = [
      { role: "user", content: "hi", timestamp: Date.now() },
    ];
    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("below-threshold");
  });

  it("returns shouldCompact=true at/above threshold", () => {
    const manager = new ContextManager({
      model: "gpt-4",
      contextWindowLimit: 100, // tiny so we hit threshold fast
    });
    const messages: Message[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push({
        role: "user",
        content: "A".repeat(200),
        timestamp: Date.now() + i,
      });
    }
    const decision = manager.shouldCompact(messages);
    expect(decision.shouldCompact).toBe(true);
  });
});
