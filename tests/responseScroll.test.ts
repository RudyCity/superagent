import { describe, expect, it } from "vitest";
import { capDisplayLines, getTruncatedAssistantIndexes, renderScrollBar, wrapTextForDisplay } from "../src/utils/responseScroll.js";
import type { ChatLine } from "../src/core/slash-commands.js";

describe("response scroll helpers", () => {
  it("does not truncate short content", () => {
    expect(capDisplayLines("short\ntext", 5, 80)).toEqual({ text: "short\ntext", truncated: false });
  });

  it("truncates content exceeding visual line budget", () => {
    const result = capDisplayLines("one\ntwo\nthree", 2, 80);
    expect(result).toEqual({ text: "one\ntwo", truncated: true });
  });

  it("detects only truncated assistant messages", () => {
    const lines: ChatLine[] = [
      { type: "user", content: "hello", timestamp: 1 },
      { type: "assistant", content: "short", timestamp: 2 },
      { type: "assistant", content: "a\nb\nc", timestamp: 3 },
    ];

    expect(getTruncatedAssistantIndexes(lines, 2, 80)).toEqual([2]);
  });

  it("wraps long display lines", () => {
    expect(wrapTextForDisplay("abcdefghij", 4)).toEqual(["abcdefghij"]);
    expect(wrapTextForDisplay("abcdefghijk", 4)).toEqual(["abcdefghij", "k"]);
  });

  it("renders scrollbar progress", () => {
    expect(renderScrollBar(0, 10, 10)).toBe("[■■■■■■■■■■]");
    expect(renderScrollBar(0, 5, 20)).toBe("[■□□□□□□□□□]");
    expect(renderScrollBar(15, 5, 20)).toBe("[■■■■■■■■■■]");
  });
});
