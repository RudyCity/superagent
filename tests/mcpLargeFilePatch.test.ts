import { describe, expect, it } from "vitest";
import {
  applyLinePatchOperations,
  detectLineEnding,
  isPatchableTargetFile,
} from "../src/core/mcp/mcpLargeFilePatch.js";

describe("MCP large file line-patch helper", () => {
  it("preserves CRLF line endings and applies multiple edits across line shifts", () => {
    const original = [
      "line 1",
      "const target = 'old';",
      "line 3",
      "const second = 1;",
      "line 5",
    ].join("\r\n");

    const updated = applyLinePatchOperations(original, [
      {
        kind: "replace_block",
        startLine: 2,
        endLine: 2,
        expectedSnippet: "const target = 'old';",
        replacement: "const target = 'new';\nconst inserted = true;",
      },
      {
        kind: "insert_after",
        line: 4,
        expectedLineSnippet: "const second = 1;",
        content: "// after second",
      },
    ]);

    expect(detectLineEnding(updated)).toBe("\r\n");
    expect(updated).toBe([
      "line 1",
      "const target = 'new';",
      "const inserted = true;",
      "line 3",
      "const second = 1;",
      "// after second",
      "line 5",
    ].join("\r\n"));
  });

  it("rejects mismatched snippets or out-of-bounds line ranges", () => {
    expect(() =>
      applyLinePatchOperations("alpha\nbeta\n", [
        {
          kind: "replace_block",
          startLine: 1,
          endLine: 1,
          expectedSnippet: "does-not-match",
          replacement: "gamma",
        },
      ]),
    ).toThrow("Expected snippet mismatch");

    expect(() =>
      applyLinePatchOperations("alpha\nbeta\n", [
        {
          kind: "replace_block",
          startLine: 2,
          endLine: 99,
          replacement: "gamma",
        },
      ]),
    ).toThrow("Invalid replace_block range");
  });

  it("validates supported target extensions", () => {
    expect(isPatchableTargetFile("src/serverRoutes.ts")).toBe(true);
    expect(isPatchableTargetFile("package.json")).toBe(true);
    expect(isPatchableTargetFile("archive.zip")).toBe(false);
  });
});
