import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  normalizePathsForImage,
  sliceTextIntoPages,
  minifyTextForImage,
  wrapLongLines,
  renderTextToImageBase64,
} from "../src/utils/textToImage.js";

describe("normalizePathsForImage", () => {
  it("converts Windows backslashes to forward slashes", () => {
    expect(normalizePathsForImage("C:\\Users\\foo\\file.txt")).toBe("C:/Users/foo/file.txt");
  });

  it("converts relative paths with backslashes", () => {
    expect(normalizePathsForImage(".\\src\\utils\\textToImage.ts")).toBe("./src/utils/textToImage.ts");
  });

  it("leaves forward-slash paths unchanged", () => {
    expect(normalizePathsForImage("/home/user/file.txt")).toBe("/home/user/file.txt");
  });

  it("leaves normal text without paths unchanged", () => {
    expect(normalizePathsForImage("hello world")).toBe("hello world");
  });
});

describe("sliceTextIntoPages — adaptive char-count split", () => {
  it("returns empty array for empty input", () => {
    expect(sliceTextIntoPages("")).toEqual([]);
  });

  it("returns single page for short text", () => {
    const pages = sliceTextIntoPages("short text", 100);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toBe("short text");
  });

  it("splits at newline boundary near char limit", () => {
    const text = "line a\nline b\nline c\nline d\nline e\nline f\nline g\n";
    // Each line is ~7 chars, limit 20 → fits ~2 lines
    const pages = sliceTextIntoPages(text, 20);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    // Each page should be non-empty and not truncated mid-line
    for (const page of pages) {
      expect(page.length).toBeGreaterThan(0);
      if (page.includes("TRUNCATED")) continue;
      const lines = page.split("\n").filter(l => l.trim().length > 0);
      expect(lines.length).toBeGreaterThan(0);
    }
  });

  it("does not exceed maxPages limit", () => {
    const text = "line\n".repeat(500);
    const pages = sliceTextIntoPages(text, 10, 5);
    expect(pages.length).toBeLessThanOrEqual(5);
  });

  it("preserves total content across pages", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const pages = sliceTextIntoPages(text, 200, 100);
    const joined = pages.join("\n");
    for (let i = 0; i < 50; i++) {
      expect(joined).toContain(`line ${i}`);
    }
  });
});

describe("minifyTextForImage — aggressive compression", () => {
  it("removes trailing whitespace per line", () => {
    expect(minifyTextForImage("hello   \nworld  \n")).toBe("hello\nworld");
  });

  it("condenses 3+ newlines to 2", () => {
    expect(minifyTextForImage("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("removes single-line JS comments", () => {
    const result = minifyTextForImage("hello // comment\nworld");
    expect(result).not.toContain("// comment");
    expect(result).toContain("hello");
    expect(result).toContain("world");
  });

  it("trims leading/trailing whitespace", () => {
    expect(minifyTextForImage("  hello world  ")).toBe("hello world");
  });

  it("squashes JSON objects to one line", () => {
    const input = 'some text {\n  "key": "value",\n  "num": 42\n}';
    const result = minifyTextForImage(input);
    expect(result).toContain('{"key":"value","num":42}');
    expect(result).not.toContain("\n");
  });
});

describe("wrapLongLines — binary search word wrap", () => {
  it("does not wrap short lines", () => {
    expect(wrapLongLines("short line", 50)).toBe("short line");
  });

  it("wraps at word boundary near maxChars", () => {
    const text = "ThisIsAVeryLongLineThatShouldBeWrappedAtSomePointToAvoidOverflow";
    const wrapped = wrapLongLines(text, 30);
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(35);
    }
  });

  it("preserves original short lines with newlines", () => {
    const text = "first\nsecond\nthird";
    expect(wrapLongLines(text, 50)).toBe("first\nsecond\nthird");
  });

  it("handles mixed long and short lines", () => {
    const text = "short\nAVeryLongLineWithoutSpacesThatNeedsWrapping\nend";
    const wrapped = wrapLongLines(text, 25);
    const lines = wrapped.split("\n");
    expect(lines[0]).toBe("short");
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[lines.length - 1]).toBe("end");
  });

  it("wraps at punctuation separators when available", () => {
    const text = "path/to/some/deeply/nested/component/that/exceeds/limit";
    const wrapped = wrapLongLines(text, 30);
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(35);
    }
  });
});

describe("renderTextToImageBase64", () => {
  it("returns a non-empty base64 string", () => {
    const result = renderTextToImageBase64("hello world");
    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(100);
  });

  it("produces valid base64 encoding", () => {
    const result = renderTextToImageBase64("test content");
    expect(() => Buffer.from(result, "base64")).not.toThrow();
    const decoded = Buffer.from(result, "base64");
    // WebP header bytes: 52 49 46 46 = "RIFF"
    expect(decoded[0]).toBe(0x52);
    expect(decoded[1]).toBe(0x49);
    expect(decoded[2]).toBe(0x46);
    expect(decoded[3]).toBe(0x46);
  });

  it("handles multiline text", () => {
    const text = "line1\nline2\nline3\nline4\nline5";
    const result = renderTextToImageBase64(text);
    expect(result).toBeTruthy();
    expect(result.length).toBeGreaterThan(200);
  });

  it("handles very long text without throwing", () => {
    const longText = "x".repeat(5000) + "\n" + "y".repeat(5000);
    expect(() => renderTextToImageBase64(longText)).not.toThrow();
  });

  it("normalizes paths during render", () => {
    const text = "path C:\\Users\\me to file";
    const result = renderTextToImageBase64(text);
    expect(result).toBeTruthy();
  });
});
