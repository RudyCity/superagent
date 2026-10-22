/**
 * Read-only benchmark of real local SuperAgent SQLite transcripts.
 *
 * bun scripts/bench-compaction-session.ts --latest [--limit 3] [--json]
 * bun scripts/bench-compaction-session.ts --session <session-id-or-json-key> [--json]
 *
 * Does not display, save, mutate or export any transcript content.
 */
import path from "node:path";
import { performance } from "node:perf_hooks";
import { listSessionsFromDb, loadSessionFromDb } from "../src/core/storage/historyDb.js";
import { PruningStrategy } from "../src/core/context/strategies/PruningStrategy.js";
import { benchmarkCompaction, preserveContextFacts } from "../src/core/context/ContextContinuity.js";
import type { Message, MessageContent, ToolCall, ToolResult } from "../src/core/conversation.js";

const args = process.argv.slice(2);
const selectedIndex = args.indexOf("--session");
const latest = args.includes("--latest");
const json = args.includes("--json");
const limitIndex = args.indexOf("--limit");
const count = Math.max(1, Math.min(6, Number(args[limitIndex + 1]) || 3));
if ((!latest && selectedIndex === -1) || (latest && selectedIndex !== -1)) {
  console.error("Usage: --latest [--limit 3] [--json] OR --session <session-id> [--json]");
  process.exit(2);
}

const selection = latest
  ? listSessionsFromDb(60)
    .filter((s) => s.messageCount >= 10 &&
      !!s.workingDirectory && path.resolve(s.workingDirectory).toLowerCase() === process.cwd().toLowerCase())
    .slice(0, count)
  : [{
      id: path.basename(args[selectedIndex + 1] || "", ".json"),
      messageCount: 1,
    }];

const rows: Array<{
  messagesBefore: number;
  messagesAfter: number;
  bytesBefore: number;
  bytesAfter: number;
  reductionPct: number;
  latencyMs: number;
  quality: number;
  passed: boolean;
  warnings: number;
}> = [];

for (const session of selection) {
  if (!/^[a-zA-Z0-9_.-]{1,160}$/.test(session.id)) continue;
  const loaded = loadSessionFromDb(session.id);
  if (!loaded.session || loaded.messages.length < 10) continue;
  const original: Message[] = loaded.messages.slice(-1800).map((m) => {
    const parse = <T>(v: string | undefined): T | undefined => {
      if (!v) return undefined;
      try { return JSON.parse(v) as T; } catch { return undefined; }
    };
    // Content is a string unless it is an explicit persisted image/text parts array.
    const parts = m.content.startsWith("[") ? parse<MessageContent>(m.content) : undefined;
    return {
      role: m.role as Message["role"], content: Array.isArray(parts) ? parts : m.content,
      timestamp: m.timestamp, toolCalls: parse<ToolCall[]>(m.toolCalls), toolResults: parse<ToolResult[]>(m.toolResults),
    };
  });
  const before = JSON.stringify(original);
  const t0 = performance.now();
  const result = await new PruningStrategy().execute(original, {
    preserveRecent: 14,
    tokenBudget: Math.max(1000, Math.floor(before.length / 12)),
  });
  const retained = preserveContextFacts(original, result.messages);
  const benchmark = benchmarkCompaction(original, retained);
  if (JSON.stringify(original) !== before) throw new Error("Benchmark mutated local transcript");
  rows.push({
    messagesBefore: original.length, messagesAfter: retained.length,
    bytesBefore: benchmark.bytesBefore, bytesAfter: benchmark.bytesAfter,
    reductionPct: benchmark.reductionPct,
    latencyMs: Math.round(performance.now() - t0),
    quality: benchmark.quality.score, passed: benchmark.quality.passed,
    warnings: benchmark.quality.warnings.length,
  });
}
if (json) console.log(JSON.stringify({ mode: "local-sqlite-read-only", rows }, null, 2));
else console.table(rows);
if (!rows.length) {
  console.error("No matching sessions with enough messages; no transcript was changed.");
  process.exitCode = 2;
} else if (rows.some((r) => !r.passed)) process.exitCode = 1;
