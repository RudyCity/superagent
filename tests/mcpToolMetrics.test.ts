import { describe, expect, it } from "vitest";
import { McpToolMetrics } from "../src/core/mcp/mcpToolMetrics.js";

describe("MCP tool observability", () => {
  it("tracks calls, failures, duration without inputs or outputs", () => {
    const metrics = new McpToolMetrics(2);
    metrics.record("git_status", 12, false);
    metrics.record("git_status", 17, true);
    expect(metrics.snapshot("git")).toEqual([expect.objectContaining({
      tool: "git_status", calls: 2, failures: 1, totalDurationMs: 29, lastDurationMs: 17,
    })]);
    expect(JSON.stringify(metrics.snapshot())).not.toContain("Bearer");
    metrics.record("browser_click", 8, false);
    metrics.record("terminal_exec", 9, false);
    expect(metrics.snapshot().map((item) => item.tool)).toEqual(["browser_click", "terminal_exec"]);
    metrics.reset();
    expect(metrics.snapshot()).toEqual([]);
  });
});
