/** Bounded, redaction-safe MCP execution metrics; never stores arguments or response bodies. */
export type McpToolStats = {
  tool: string;
  calls: number;
  failures: number;
  totalDurationMs: number;
  lastDurationMs: number;
  totalResponseBytes: number;
  lastResponseBytes: number;
  maxResponseBytes: number;
  p50DurationMs: number;
  p95DurationMs: number;
  lastCalledAt: string;
};

export class McpToolMetrics {
  private readonly entries = new Map<string, Omit<McpToolStats, "p50DurationMs" | "p95DurationMs">>();
  private readonly durationSamples = new Map<string, number[]>();

  constructor(private readonly maxEntries = 256, private readonly maxSamples = 64) {}

  record(tool: string, elapsedMs: number, failed: boolean, responseBytes = 0): void {
    const old = this.entries.get(tool);
    if (old) this.entries.delete(tool);
    const duration = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
    const bytes = Number.isFinite(responseBytes) ? Math.max(0, Math.round(responseBytes)) : 0;
    this.entries.set(tool, {
      tool,
      calls: (old?.calls || 0) + 1,
      failures: (old?.failures || 0) + (failed ? 1 : 0),
      totalDurationMs: (old?.totalDurationMs || 0) + duration,
      lastDurationMs: duration,
      totalResponseBytes: (old?.totalResponseBytes || 0) + bytes,
      lastResponseBytes: bytes,
      maxResponseBytes: Math.max(old?.maxResponseBytes || 0, bytes),
      lastCalledAt: new Date().toISOString(),
    });
    const samples = this.durationSamples.get(tool) || [];
    samples.push(duration);
    if (samples.length > Math.max(1, this.maxSamples)) samples.shift();
    this.durationSamples.set(tool, samples);
    while (this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
      this.durationSamples.delete(first);
    }
  }

  snapshot(server?: string): McpToolStats[] {
    const prefix = server?.toLowerCase();
    return [...this.entries.values()]
      .filter((entry) => !prefix || entry.tool.startsWith(prefix + "_"))
      .map((entry) => {
        const sorted = [...(this.durationSamples.get(entry.tool) || [])].sort((a, b) => a - b);
        const percentile = (fraction: number) => sorted.length
          ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : 0;
        return { ...entry, p50DurationMs: percentile(0.5), p95DurationMs: percentile(0.95) };
      })
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  }

  reset(): void {
    this.entries.clear();
    this.durationSamples.clear();
  }
}

export const mcpToolMetrics = new McpToolMetrics();
