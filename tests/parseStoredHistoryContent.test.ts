import { describe, expect, it, vi } from "vitest";
import { parseStoredHistoryContent } from "../src/core/utils/parseStoredHistoryContent.js";

describe("SQLite /api/history content decoding", () => {
  it("keeps RMemory-tagged markdown literal (root cause)", () => {
    const text = "[RMemory] Local memory notes about this project";
    expect(parseStoredHistoryContent(text)).toBe(text);
  });

  it("preserves plain markdown, prose and scope markers starting with brackets", () => {
    for (const content of [
      "[project:superagent] Keep this context",
      "[global] Shared context",
      "[RMemory]\n- Keep memories locally",
      "[Note] ordinary user response",
      "{RMemory} note",
      "  [RMemory] with leading spaces",
      "[Warning] more context",
      "[1] see numbered footnote",
      "Regular text",
      "",
    ]) {
      expect(parseStoredHistoryContent(content)).toBe(content);
    }
  });

  it("decodes valid JSON objects and arrays from historical rows", () => {
    expect(parseStoredHistoryContent('{"type":"text","text":"ok"}'))
      .toEqual({ type: "text", text: "ok" });
    expect(parseStoredHistoryContent('[{"type":"text","text":"ok"}]'))
      .toEqual([{ type: "text", text: "ok" }]);
    expect(parseStoredHistoryContent('  [1, 2, null, true] '))
      .toEqual([1, 2, null, true]);
    expect(parseStoredHistoryContent('["one", "two"]')).toEqual(["one", "two"]);
    expect(parseStoredHistoryContent("{}")).toEqual({});
    expect(parseStoredHistoryContent("[]")).toEqual([]);
  });

  it("preserves malformed JSON-looking records verbatim with no console spam", () => {
    const spy = vi.spyOn(console, "debug");
    try {
      for (const s of ['{"error":', '[{"broken"}', '[true,', "{", "["]) {
        expect(parseStoredHistoryContent(s)).toBe(s);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("does not parse primitives or alter non-string values", () => {
    expect(parseStoredHistoryContent("true")).toBe("true");
    expect(parseStoredHistoryContent("42")).toBe("42");
    expect(parseStoredHistoryContent(null)).toBeNull();
    const existing = [{ role: "assistant" }];
    expect(parseStoredHistoryContent(existing)).toBe(existing);
  });
});
