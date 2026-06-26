import { describe, expect, it } from "vitest";
import { computeWrappedLines, wrapChatLineToLines } from "../src/components/chat-area.js";
import type { ChatLine } from "../src/core/slash-commands.js";

describe("single-agent line-by-line scrolling", () => {
  const formatCompactNumber = (val: number) => String(val);

  it("should wrap user message into header, content lines, and separator", () => {
    const line: ChatLine = {
      type: "user",
      content: "Hello World",
    };

    const wrapped = wrapChatLineToLines({
      line,
      isFirst: true,
      lineIndex: 0,
      tokensUp: 0,
      tokensDown: 0,
      modelName: "test-model",
      maxResponseLines: 12,
      chatWidth: 80,
      isLastAssistant: false,
      isCollapsed: false,
      expandedChildren: new Set(),
    });

    // 1 header + 1 content line (wrapped to 75 chars) + 1 separator = 3 lines
    expect(wrapped.length).toBe(3);
    expect(wrapped[0].isHeader).toBe(true);
    expect(wrapped[1].lineIndex).toBe(0);
    expect(wrapped[2].isSeparator).toBe(true);
  });

  it("should compute wrapped lines for entire conversation and live status", () => {
    const lines: ChatLine[] = [
      { type: "user", content: "hi" },
      { type: "assistant", content: "hello there" },
    ];

    const wrapped = computeWrappedLines({
      lines,
      chatWidth: 80,
      maxAssistantResponseLines: 12,
      expandedLines: new Set(),
      expandedChildren: new Map(),
      tokensUp: 10,
      tokensDown: 20,
      modelName: "test-model",
      isProcessing: true,
      streamDisplay: "typing...",
      isExecutingTool: false,
      activeToolOutput: "",
      timeLeft: null,
      formatCompactNumber,
    });

    // hi (3 lines) + hello there (3 lines) + streaming header + typing content (1 line) = 8 lines
    expect(wrapped.length).toBe(8);
  });

  it("should mark all lines as truncated for a truncated assistant response, including header and separator", () => {
    const lines: ChatLine[] = [
      { type: "assistant", content: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\nline 11\nline 12\nline 13\nline 14\nline 15" },
      { type: "assistant", content: "second assistant response" }
    ];

    const wrapped = computeWrappedLines({
      lines,
      chatWidth: 80,
      maxAssistantResponseLines: 5,
      expandedLines: new Set(),
      expandedChildren: new Map(),
      tokensUp: 10,
      tokensDown: 20,
      modelName: "test-model",
      isProcessing: false,
      streamDisplay: "",
      isExecutingTool: false,
      activeToolOutput: "",
      timeLeft: null,
      formatCompactNumber,
    });

    const truncatedLines = wrapped.filter(w => w.lineIndex === 0 && w.type === "assistant");
    expect(truncatedLines.length).toBeGreaterThan(0);
    for (const w of truncatedLines) {
      expect(w.isTruncated).toBe(true);
    }
  });
});
