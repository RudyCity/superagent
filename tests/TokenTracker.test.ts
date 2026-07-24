import { describe, it, expect } from "vitest";
import { TokenTracker } from "../src/core/context/TokenTracker.js";
import { Message } from "../src/core/conversation.js";

describe("TokenTracker", () => {
  it("should estimate tokens for simple message", () => {
    const tracker = new TokenTracker("claude-3-5-sonnet-20241022");
    const message: Message = {
      role: "user",
      content: "Hello world",
      timestamp: Date.now(),
    };

    const tokens = tracker.estimateTokens(message);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  it("should include tool calls in token count", () => {
    const tracker = new TokenTracker("claude-3-5-sonnet-20241022");
    const message: Message = {
      role: "assistant",
      content: "I will read the file",
      toolCalls: [
        { id: "1", name: "read_file", args: { path: "/test.txt" } },
      ],
      timestamp: Date.now(),
    };

    const tokens = tracker.estimateTokens(message);
    // Content "I will read the file" + tool call args JSON
    expect(tokens).toBeGreaterThan(10);
  });

  it("should include tool results in token count", () => {
    const tracker = new TokenTracker("claude-3-5-sonnet-20241022");
    const message: Message = {
      role: "tool",
      content: "File contents here",
      toolResults: [
        { toolCallId: "1", name: "read_file", result: "This is the file content that is longer and has more words to ensure it passes the token threshold easily" },
      ],
      timestamp: Date.now(),
    };

    const tokens = tracker.estimateTokens(message);
    expect(tokens).toBeGreaterThan(10);
  });

  it("should provide breakdown by message type", () => {
    const tracker = new TokenTracker("claude-3-5-sonnet-20241022");
    const messages: Message[] = [
      { role: "system", content: "System prompt", timestamp: Date.now() },
      { role: "user", content: "User question", timestamp: Date.now() },
      {
        role: "assistant",
        content: "Response",
        toolCalls: [{ id: "1", name: "read", args: { path: "/a" } }],
        timestamp: Date.now(),
      },
      {
        role: "tool",
        content: "Result",
        toolResults: [{ toolCallId: "1", name: "read", result: "file content" }],
        timestamp: Date.now(),
      },
    ];

    const breakdown = tracker.estimateTokensForAll(messages);
    expect(breakdown.systemPrompt).toBeGreaterThan(0);
    expect(breakdown.messages).toBeGreaterThan(0);
    expect(breakdown.toolCalls).toBeGreaterThan(0);
    expect(breakdown.toolResults).toBeGreaterThan(0);
    expect(breakdown.total).toBe(
      breakdown.systemPrompt + breakdown.messages + breakdown.toolCalls + breakdown.toolResults
    );
  });

  it("should cache token counts for performance", () => {
    const tracker = new TokenTracker("claude-3-5-sonnet-20241022");
    const message: Message = {
      role: "user",
      content: "Repeat this test message",
      timestamp: Date.now(),
    };

    const tokens1 = tracker.estimateTokens(message);
    const tokens2 = tracker.estimateTokens(message);

    expect(tokens1).toBe(tokens2);
  });

  it("should handle empty content", () => {
    const tracker = new TokenTracker("claude-3-5-sonnet-20241022");
    const message: Message = {
      role: "user",
      content: "",
      timestamp: Date.now(),
    };

    const tokens = tracker.estimateTokens(message);
    expect(tokens).toBe(0);
  });

  it("should use fallback heuristic for CJK text", () => {
    const tracker = new TokenTracker("test-model");
    const message: Message = {
      role: "user",
      content: "こんにちは世界", // 7 Japanese characters
      timestamp: Date.now(),
    };

    const tokens = tracker.estimateTokens(message);
    expect(tokens).toBeGreaterThan(0);
    // CJK should use ratio 2, so 7 chars / 2 = 4 tokens (ceil)
    expect(tokens).toBeGreaterThanOrEqual(3);
  });
});
