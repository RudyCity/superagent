import { describe, it, expect, beforeEach } from "vitest";
import { CompactionHistory, CompactionEvent } from "../src/core/context/CompactionHistory.js";

describe("CompactionHistory", () => {
  beforeEach(() => {
    const history = new CompactionHistory();
    history.clear();
  });

  it("should record compaction events", () => {
    const history = new CompactionHistory();

    const event: CompactionEvent = {
      id: "test-1",
      timestamp: Date.now(),
      strategy: "summarization",
      messagesBefore: 100,
      messagesAfter: 50,
      tokensBefore: 50000,
      tokensAfter: 25000,
      reason: "threshold",
    };

    history.record(event);

    const events = history.getHistory();
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("test-1");
  });

  it("should find last summary", () => {
    const history = new CompactionHistory();

    history.record({
      id: "1",
      timestamp: 1000,
      strategy: "summarization",
      messagesBefore: 100,
      messagesAfter: 50,
      tokensBefore: 50000,
      tokensAfter: 25000,
      summary: "First summary",
      reason: "threshold",
    });

    history.record({
      id: "2",
      timestamp: 2000,
      strategy: "pruning",
      messagesBefore: 80,
      messagesAfter: 40,
      tokensBefore: 40000,
      tokensAfter: 20000,
      reason: "emergency",
    });

    const lastSummary = history.getLastSummary();
    expect(lastSummary?.id).toBe("1");
    expect(lastSummary?.summary).toBe("First summary");
  });

  it("should calculate total tokens saved", () => {
    const history = new CompactionHistory();

    history.record({
      id: "1",
      timestamp: 1000,
      strategy: "summarization",
      messagesBefore: 100,
      messagesAfter: 50,
      tokensBefore: 50000,
      tokensAfter: 25000,
      reason: "threshold",
    });

    history.record({
      id: "2",
      timestamp: 2000,
      strategy: "pruning",
      messagesBefore: 80,
      messagesAfter: 40,
      tokensBefore: 40000,
      tokensAfter: 20000,
      reason: "emergency",
    });

    expect(history.getTokensSaved()).toBe(45000);
  });

  it("should return null when no summaries exist", () => {
    const history = new CompactionHistory();
    expect(history.getLastSummary()).toBeNull();
  });

  it("should count compactions", () => {
    const history = new CompactionHistory();
    expect(history.getCompactionCount()).toBe(0);

    history.record({
      id: "1",
      timestamp: 1000,
      strategy: "summarization",
      messagesBefore: 10,
      messagesAfter: 5,
      tokensBefore: 100,
      tokensAfter: 50,
      reason: "threshold",
    });

    expect(history.getCompactionCount()).toBe(1);
  });

  it("should trim history to max 50 events", () => {
    const history = new CompactionHistory();

    for (let i = 0; i < 60; i++) {
      history.record({
        id: `event-${i}`,
        timestamp: i,
        strategy: "summarization",
        messagesBefore: 10,
        messagesAfter: 5,
        tokensBefore: 100,
        tokensAfter: 50,
        reason: "threshold",
      });
    }

    expect(history.getHistory().length).toBe(50);
    // Should keep the last 50
    expect(history.getHistory()[0].id).toBe("event-10");
    expect(history.getHistory()[49].id).toBe("event-59");
  });

  it("should persist to DB when recorded", async () => {
    const history = new CompactionHistory();
    await history.record({
      id: "persist-1",
      timestamp: 1000,
      strategy: "summarization",
      messagesBefore: 10,
      messagesAfter: 5,
      tokensBefore: 100,
      tokensAfter: 50,
      reason: "threshold",
    });

    const secondHistory = new CompactionHistory();
    expect(secondHistory.getHistory()).toHaveLength(1);
    expect(secondHistory.getHistory()[0].id).toBe("persist-1");
  });
});
