/**
 * Opt-in benchmark for a locally stored conversation session (no network calls).
 * Usage: bun scripts/bench-compaction-session.ts --session "C:\\path\\to\\session.json" [--json]
 * Reports metrics only; message content is not printed.
 */
import { performance } from "node:perf_hooks";
import path from "node:path";
import fs from "node:fs";
import { Conversation } from "../src/core/conversation.js";
import { PruningStrategy } from "../src/core/context/strategies/PruningStrategy.js";
import { benchmarkCompaction, preserveContextFacts } from "../src/core/context/ContextContinuity.js";

const index = process.argv.indexOf("--session");
if (index < 0 || !process.argv[index + 1]) {
  console.error("Usage: bun scripts/bench-compaction-session.ts --session <session-file.json> [--json]");
  process.exit(2);
}
const filePath = path.resolve(process.argv[index + 1]);
if (!filePath.endsWith(".json") || !fs.existsSync(filePath)) {
  console.error("Local session file not found; supply an existing session history JSON key.");
  process.exit(2);
}
const conversation = new Conversation();
await conversation.loadFromFile(filePath);
const messages = conversation.getMessages();
if (messages.length < 2) {
  console.error("Session has insufficient messages for compaction benchmark.");
  process.exit(2);
}
const saved = JSON.stringify(messages);
const start = performance.now();
const result = await new PruningStrategy().execute(messages, {
  preserveRecent: 12,
  tokenBudget: Math.max(1000, Math.floor(saved.length / 12)),
});
const retained = preserveContextFacts(messages, result.messages);
const metrics = benchmarkCompaction(messages, retained);
const report = {
  origin: "local-session", messagesBefore: messages.length, messagesAfter: retained.length,
  bytesBefore: metrics.bytesBefore, bytesAfter: metrics.bytesAfter,
  reductionPct: metrics.reductionPct, durationMs: Math.round(performance.now() - start),
  continuityScore: metrics.quality.score, passed: metrics.quality.passed,
  issues: metrics.quality.missing.concat(metrics.quality.warnings),
};
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else console.table([report]);
if (JSON.stringify(messages) !== saved) throw new Error("Benchmark mutated original session");
if (!metrics.quality.passed) process.exitCode = 1;
