import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBoundedLogTail } from "../src/core/mcp/mcpLogTail.js";

describe("bounded MCP log tail reader", () => {
  it("reads the final lines of a large file within a fixed memory budget", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-mcp-tail-"));
    const file = path.join(dir, "large.log");
    try {
      fs.writeFileSync(file, "prefix-data\n".repeat(120_000) + "final-1\nfinal-2");
      const result = readBoundedLogTail(file, 2);
      expect(result.text).toBe("final-1\nfinal-2");
      expect(result.readBytes).toBeLessThanOrEqual(64 * 1024);
      expect(result.totalBytes).toBeGreaterThan(1024 * 1024);
      expect(result.clippedByBytes).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("reports a clipped tail when a single log line exceeds the budget", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-mcp-tail-"));
    const file = path.join(dir, "single.log");
    try {
      fs.writeFileSync(file, "x".repeat(200_000));
      const result = readBoundedLogTail(file, 50);
      expect(result.clippedByBytes).toBe(true);
      expect(result.readBytes).toBe(64 * 1024);
      expect(result.text.length).toBeLessThanOrEqual(64 * 1024);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
