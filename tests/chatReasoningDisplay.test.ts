import { describe, it, expect } from "vitest";
import React from "react";
import { extractThinkingAndContent, wrapThinkingToLines } from "../src/components/chat-thinking.js";
import { wrapChatLineToLines, computeWrappedLines } from "../src/components/chat-area.js";
import type { ChatLine } from "../src/core/slash-commands.js";

describe("chat-thinking", () => {
  describe("extractThinkingAndContent", () => {
    it("should return unchanged content and reasoning when reasoning is already provided", () => {
      const result = extractThinkingAndContent("Hello world", "I am thinking");
      expect(result.cleanContent).toBe("Hello world");
      expect(result.reasoning).toBe("I am thinking");
    });

    it("should extract <think> tags from content if reasoning is not provided", () => {
      const content = "<think>Step 1: Check files\nStep 2: Edit code</think>Here is the answer";
      const result = extractThinkingAndContent(content);
      expect(result.cleanContent).toBe("Here is the answer");
      expect(result.reasoning).toBe("Step 1: Check files\nStep 2: Edit code");
    });

    it("should support alternate tags like <thought> and case-insensitivity", () => {
      const content = "<THOUGHT>Internal monologue</THOUGHT>Final output";
      const result = extractThinkingAndContent(content);
      expect(result.cleanContent).toBe("Final output");
      expect(result.reasoning).toBe("Internal monologue");
    });
  });

  describe("wrapThinkingToLines", () => {
    it("should return empty array for empty reasoning", () => {
      const result = wrapThinkingToLines({
        reasoning: "   ",
        isExpanded: false,
        lineIndex: 0,
        chatWidth: 80,
        hideTimeline: false,
      });
      expect(result).toEqual([]);
    });

    it("should render collapsed single-line preview when isExpanded is false", () => {
      const result = wrapThinkingToLines({
        reasoning: "First thought\nSecond thought",
        isExpanded: false,
        lineIndex: 1,
        chatWidth: 80,
        hideTimeline: false,
      });

      expect(result.length).toBe(1);
      expect(result[0].lineIndex).toBe(1);
      expect(result[0].type).toBe("thinking");
      expect(result[0].isCollapsible).toBe(true);
      expect(result[0].isThinking).toBe(true);
    });

    it("should render expanded box with borders when isExpanded is true", () => {
      const result = wrapThinkingToLines({
        reasoning: "Analyzing architecture\nChecking components",
        isExpanded: true,
        lineIndex: 2,
        chatWidth: 80,
        hideTimeline: false,
      });

      // Expect toggle header, top box border, body lines, bottom box border, spacer
      expect(result.length).toBeGreaterThan(4);
      expect(result[0].isCollapsible).toBe(true);
      expect(result[0].isThinking).toBe(true);
      expect(result.some((r) => r.isThinking)).toBe(true);
    });

    it("should render streaming indicator when isStreaming is true", () => {
      const result = wrapThinkingToLines({
        reasoning: "Thinking on the fly",
        isExpanded: true,
        lineIndex: -1,
        chatWidth: 80,
        hideTimeline: false,
        isStreaming: true,
      });

      expect(result.length).toBeGreaterThan(3);
      expect(result[0].isCollapsible).toBe(false); // not collapsible while actively streaming
      expect(result[0].isThinking).toBe(true);
    });
  });
});

describe("chat-area reasoning integration", () => {
  it("should render thinking block in wrapChatLineToLines when reasoning is present", () => {
    const line: ChatLine = {
      type: "assistant",
      content: "Final answer",
      reasoning: "Detailed reasoning steps",
      timestamp: Date.now(),
    };

    const collapsedLines = wrapChatLineToLines({
      line,
      isFirst: false,
      lineIndex: 3,
      tokensUp: 10,
      tokensDown: 20,
      modelName: "test-model",
      maxResponseLines: 12,
      chatWidth: 80,
      isLastAssistant: true,
      isCollapsed: false,
      expandedChildren: new Set(),
      hideTimeline: false,
      isThinkingExpanded: false,
    });

    // Should include assistant header, collapsed thinking preview, and markdown content lines
    const thinkingNodes = collapsedLines.filter((l) => l.isThinking);
    expect(thinkingNodes.length).toBe(1);
    expect(thinkingNodes[0].isCollapsible).toBe(true);
    expect(thinkingNodes[0].lineIndex).toBe(3);

    const expandedLines = wrapChatLineToLines({
      line,
      isFirst: false,
      lineIndex: 3,
      tokensUp: 10,
      tokensDown: 20,
      modelName: "test-model",
      maxResponseLines: 12,
      chatWidth: 80,
      isLastAssistant: true,
      isCollapsed: false,
      expandedChildren: new Set(),
      hideTimeline: false,
      isThinkingExpanded: true,
    });

    const expandedThinkingNodes = expandedLines.filter((l) => l.isThinking);
    expect(expandedThinkingNodes.length).toBeGreaterThan(1);
  });

  it("should render thinking above streaming text in computeWrappedLines when both are present", () => {
    const wrapped = computeWrappedLines({
      lines: [],
      chatWidth: 80,
      maxAssistantResponseLines: 12,
      expandedLines: new Set(),
      expandedChildren: new Map(),
      expandedThinking: new Set(),
      tokensUp: 0,
      tokensDown: 0,
      modelName: "deepseek-r1",
      isProcessing: true,
      streamDisplay: "Streaming answer...",
      reasoningDisplay: "Live thinking process",
      isExecutingTool: false,
      activeToolOutput: "",
      timeLeft: null,
      formatCompactNumber: (n) => String(n),
    });

    // Both streaming header and thinking preview should be present
    expect(wrapped.length).toBeGreaterThan(2);
    const thinkingNodes = wrapped.filter((l) => l.isThinking);
    expect(thinkingNodes.length).toBe(1);
  });

  it("should render active thinking stream when streamDisplay is empty", () => {
    const wrapped = computeWrappedLines({
      lines: [],
      chatWidth: 80,
      maxAssistantResponseLines: 12,
      expandedLines: new Set(),
      expandedChildren: new Map(),
      expandedThinking: new Set(),
      tokensUp: 0,
      tokensDown: 0,
      modelName: "deepseek-r1",
      isProcessing: true,
      streamDisplay: "",
      reasoningDisplay: "Step 1: thinking\nStep 2: reasoning",
      isExecutingTool: false,
      activeToolOutput: "",
      timeLeft: null,
      formatCompactNumber: (n) => String(n),
    });

    const thinkingNodes = wrapped.filter((l) => l.isThinking);
    expect(thinkingNodes.length).toBeGreaterThan(1);
  });
});
