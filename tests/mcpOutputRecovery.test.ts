import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleExecCommand, handleGrepSearch } from "../src/core/mcp/tools/workspaceTools.js";

describe("MCP output recovery integration", () => {
  it("keeps a large command response bounded and retrieves the complete log by cursors", async () => {
    const run = await handleExecCommand({ command: "seq 1 25000", timeoutMs: 30_000 });
    expect(run.isError).not.toBe(true);
    const result = String(run.content?.[0]?.text ?? "");
    const match = result.match(/CommandId: (cmd_\d+_[a-z0-9]+)/);
    expect(match).not.toBeNull();
    expect(result).toContain("Output preview is bounded");
    expect(result.length).toBeLessThan(26000);
    const commandId = match![1];

    let cursor = 0;
    let restored = "";
    let attempts = 0;
    for (;;) {
      const read = await handleExecCommand({ commandId, offsetBytes: cursor, maxBytes: 10000 });
      expect(read.isError).not.toBe(true);
      const value = String(read.content?.[0]?.text ?? "");
      const next = value.match(/Next offsetBytes: (\d+)/);
      const hasMore = value.match(/Has more: (true|false)/);
      expect(next).not.toBeNull();
      expect(hasMore).not.toBeNull();
      restored += value.split("\n\n").slice(1).join("\n\n");
      cursor = Number(next![1]);
      attempts++;
      if (hasMore![1] === "false") break;
      if (attempts > 70) throw new Error("Command cursor did not finish.");
    }
    expect(attempts).toBeGreaterThan(3);
    expect(restored).toContain("\n1\n2\n3\n");
    expect(restored).toContain("\n24999\n25000\n");
    const pathname = result.match(/Log: (.*(?:cmd_\d+_[a-z0-9]{5})\.log)/)?.[1];
    if (pathname) fs.rmSync(pathname.trim(), { force: true });
  });

  it("passes grep pattern correctly and continues beyond a first page", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "superagent-grep-pages-"));
    try {
      fs.writeFileSync(path.join(tmp, "lines.ts"), Array.from({ length: 35 }, (_, i) =>
        (i % 3 === 0 ? "PAGED_GREP_MARK " : "noise ") + i).join("\n"));
      const first = await handleGrepSearch({ query: "PAGED_GREP_MARK", workspace: tmp, path: "lines.ts", limit: 5 });
      const text = String(first.content?.[0]?.text ?? "");
      expect(first.isError).not.toBe(true);
      expect(text.match(/PAGED_GREP_MARK/g)?.length).toBe(5);
      expect(text).toContain("Next offset=5");
      const second = await handleGrepSearch({ query: "PAGED_GREP_MARK", workspace: tmp, path: "lines.ts", limit: 5, offset: 5 });
      expect(String(second.content?.[0]?.text ?? "").match(/PAGED_GREP_MARK/g)?.length).toBe(5);
      const literal = await handleGrepSearch({ query: "PAGED_GREP_MARK", workspace: tmp, path: "lines.ts", limit: 100, isRegex: false });
      expect(String(literal.content?.[0]?.text ?? "").match(/PAGED_GREP_MARK/g)?.length).toBe(12);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
