/** Bounded, redaction-safe MCP execution metrics; never stores arguments or response bodies. */
export type McpToolStats = {
  tool: string;
  calls: number;
  failures: number;
  totalDurationMs: number;
  lastDurationMs: number;
  lastCalledAt: string;
};

export class McpToolMetrics {
  private readonly entries = new Map<string, McpToolStats>();
  constructor(private readonly maxEntries = 256) {}

  record(tool: string, elapsedMs: number, failed: boolean): void {
    const old = this.entries.get(tool);
    if (old) this.entries.delete(tool);
    const next: McpToolStats = {
      tool,
      calls: (old?.calls || 0) + 1,
      failures: (old?.failures || 0) + (failed ? 1 : 0),
      totalDurationMs: (old?.totalDurationMs || 0) + Math.max(0, Math.round(elapsedMs)),
      lastDurationMs: Math.max(0, Math.round(elapsedMs)),
      lastCalledAt: new Date().toISOString(),
    };
    this.entries.set(tool, next);
    while (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
  }

  snapshot(server?: string): McpToolStats[] {
    const prefix = server?.toLowerCase();
    return [...this.entries.values()]
      .filter((entry) => !prefix || entry.tool.startsWith(prefix + "_"))
      .map((entry) => ({ ...entry }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  }

  reset(): void { this.entries.clear(); }
}

export const mcpToolMetrics = new McpToolMetrics();
