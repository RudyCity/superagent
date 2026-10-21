/**
 * Deterministic and network-free context compaction benchmark.
 * Usage: bun scripts/bench-compaction.ts [--json]
 */
import { performance } from "node:perf_hooks";
import { PruningStrategy } from "../src/core/context/strategies/PruningStrategy.js";
import { benchmarkCompaction } from "../src/core/context/ContextContinuity.js";
import type { Message } from "../src/core/conversation.js";

type Row = { turns: number; beforeBytes: number; afterBytes: number; reductionPct: number; latencyMs: number; quality: number; goalPreserved: boolean };
const rows: Row[] = [];
for (const turns of [50, 200, 600]) {
  const messages: Message[] = [{
    role: "user", content: "Implement multi-tenant digital subscriptions with secure billing.", timestamp: 1,
  }];
  for (let i = 0; i < turns; i++) {
    const id = "tool-" + i;
    messages.push({
      role: "assistant", content: "Reviewing subscription behavior " + i,
      timestamp: i * 3 + 2, toolCalls: [{ id, name: "read_file", args: { path: "src/billing.ts" } }],
    });
    messages.push({
      role: "tool", content: "", timestamp: i * 3 + 3,
      toolResults: [{ toolCallId: id, name: "read_file",
        result: "line " + i + ": " + "billing state ".repeat(110) }],
    });
    messages.push({
      role: "assistant", content: "- [x] Step " + i + " inspected", timestamp: i * 3 + 4,
    });
  }
  messages.push({ role: "user", content: "Finish webhook idempotency and verify all subscription tests", timestamp: turns * 3 + 5 });
  const original = structuredClone(messages);
  const started = performance.now();
  const compacted = await new PruningStrategy().execute(messages, {
    tokenBudget: Math.max(1000, Math.floor(JSON.stringify(messages).length / 12)),
    preserveRecent: 14,
  });
  const elapsed = Math.round(performance.now() - started);
  const report = benchmarkCompaction(messages, compacted.messages);
  if (JSON.stringify(original) !== JSON.stringify(messages)) throw new Error("Compaction mutated source history");
  rows.push({
    turns, beforeBytes: report.bytesBefore, afterBytes: report.bytesAfter,
    reductionPct: report.reductionPct, latencyMs: elapsed,
    quality: report.quality.score, goalPreserved: report.quality.passed,
  });
}
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ benchmark: "context-compaction", rows }, null, 2));
} else {
  console.log("Context compaction benchmark (synthetic, local):");
  console.table(rows);
}
if (rows.some((r) => !r.goalPreserved)) process.exitCode = 1;
