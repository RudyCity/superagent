import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readMcpTextFilePage } from "../src/core/mcp/mcpTextFilePaging.js";

describe("bounded MCP text file paging", () => {
  it("returns lossless consecutive pages without reading an entire large file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-mcp-file-"));
    const file = path.join(dir, "large.txt");
    try {
      fs.writeFileSync(file, Array.from({ length: 100_000 }, (_, i) => "line-" + i).join("\n"));
      const first = await readMcpTextFilePage(file, { maxLines: 3 });
      expect(first.rows.map((r) => r.text)).toEqual(["line-0", "line-1", "line-2"]);
      expect(first.hasMore).toBe(true);
      expect(first.scannedBytes).toBeLessThan(first.totalBytes);
      const second = await readMcpTextFilePage(file, {
        startLine: first.nextStartLine, offsetBytes: first.nextOffsetBytes, maxLines: 3,
      });
      expect(second.rows.map((r) => r.text)).toEqual(["line-3", "line-4", "line-5"]);
      expect(second.nextOffsetBytes).toBeGreaterThan(first.nextOffsetBytes);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("provides byte continuation for very long lines without buffering the entire line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-mcp-file-"));
    const file = path.join(dir, "long.txt");
    try {
      fs.writeFileSync(file, "x".repeat(100_000) + "\nlast");
      const first = await readMcpTextFilePage(file, { maxBytes: 512 });
      expect(first.partialLine).toBe(true);
      expect(first.rows[0].text).toHaveLength(512);
      expect(first.nextOffsetBytes).toBe(512);
      const second = await readMcpTextFilePage(file, {
        startLine: first.nextStartLine, offsetBytes: first.nextOffsetBytes, maxBytes: 512,
      });
      expect(second.rows[0].line).toBe(1);
      expect(second.rows[0].text).toHaveLength(512);
      expect(second.nextOffsetBytes).toBe(1024);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("keeps UTF-8 code points intact across byte cursor pages", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-mcp-utf8-"));
    const file = path.join(dir, "unicode.txt");
    try {
      fs.writeFileSync(file, "🙂".repeat(1000));
      const first = await readMcpTextFilePage(file, { maxBytes: 257 });
      expect(first.rows[0].text).toBe("🙂".repeat(64));
      expect(first.nextOffsetBytes).toBe(256);
      const next = await readMcpTextFilePage(file, {
        startLine: first.nextStartLine, offsetBytes: first.nextOffsetBytes, maxBytes: 257,
      });
      expect(next.rows[0].text).toBe("🙂".repeat(64));
      expect(next.nextOffsetBytes).toBe(512);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("honors endLine, empty files, and invalid cursors", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-mcp-file-"));
    const file = path.join(dir, "sample.txt");
    try {
      fs.writeFileSync(file, "a\nb\nc\n");
      const result = await readMcpTextFilePage(file, { startLine: 2, endLine: 2 });
      expect(result.rows.map((r) => r.text)).toEqual(["b"]);
      expect(result.hasMore).toBe(false);
      await expect(readMcpTextFilePage(file, { offsetBytes: 100_000 })).rejects.toThrow("outside the file");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
