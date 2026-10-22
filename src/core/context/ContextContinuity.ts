import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Message } from "../conversation.js";
import { contentToString } from "../conversation.js";
import { isCompactionSummaryText } from "./CompactionStrategy.js";
import { formatToolEvidence } from "./ToolEvidence.js";

export interface ContextCheckpoint {
  version: 1;
  createdAt: number;
  goal: string;
  decisions: string[];
  completed: string[];
  pending: string[];
  blockers: string[];
  files: string[];
  tools: string[];
  verification: string[];
  sessionSummary: string;
}

export interface CompactionQuality {
  passed: boolean;
  score: number;
  warnings: string[];
  missing: string[];
}

export interface CompactionSnapshot {
  id: string;
  createdAt: number;
  beforeTokens: number;
  messages: Message[];
  checkpoint: ContextCheckpoint;
  compactedDigest?: string;
}

export interface CompactionMetrics {
  count: number;
  tokensSaved: number;
  totalDurationMs: number;
  failures: number;
  latest?: { strategy: string; durationMs: number; tokensBefore: number; tokensAfter: number; quality: number; fallback: boolean };
}

const USER_PREFIX_CHARS = 180;
const KEEP_SNAPSHOTS = 3;
const MAX_STORE_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
const MAX_SUMMARY_CHARS = 2400;
const limitText = (s: string, max = 350) => s.slice(0, max).trim();

export function activeUserRequest(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const text = contentToString(m.content).trim();
    if (m.role === "user" && text && !isCompactionSummaryText(text) && !text.startsWith("[RMemory Agent Memory Context]")) return text;
  }
  return "";
}

/** Capture explicit evidence only: summary never invents successful builds or completed tasks. */
export function buildContextCheckpoint(messages: Message[]): ContextCheckpoint {
  const goal = limitText(activeUserRequest(messages), 1200);
  const decisions: string[] = [], completed: string[] = [], pending: string[] = [];
  const blockers: string[] = [], verification: string[] = [];
  const files = new Set<string>(), tools = new Set<string>();
  let sessionSummary = "";
  for (const m of messages) {
    const text = contentToString(m.content);
    if (isCompactionSummaryText(text)) sessionSummary = limitText(text, MAX_SUMMARY_CHARS);
    for (const file of text.slice(0, 4096).match(/(?:[\w.-]{1,96}[\/]){1,12}[\w.-]{1,96}/g) || []) {
      if (files.size < 24 && !file.includes("node_modules") && !file.includes(".git")) files.add(file);
    }
    for (const tc of m.toolCalls || []) tools.add(tc.name);
    for (const tr of m.toolResults || []) {
      if (tr.isError && blockers.length < 8) blockers.push(limitText(tr.name + ": " + tr.result));
    }
    for (const line of text.slice(0, 32_000).split("\n").slice(0, 100)) {
      const l = line.trim();
      if (!l || l.length > 1400) continue;
      if (/^(?:[-*] )?(?:decision|keputusan|diputuskan)\s*:/i.test(l) && decisions.length < 12) decisions.push(limitText(l));
      if (/^[-*]\s*\[[xX]\]/.test(l) && completed.length < 16) completed.push(limitText(l));
      if (/^[-*]\s*\[\s\]/.test(l) && pending.length < 16) pending.push(limitText(l));
      if (/\b(?:blocked|blocker|gagal|failed|error)\b/i.test(l) && blockers.length < 8) blockers.push(limitText(l));
      if (/\b(?:passed|tests? passed|build succeeded|build berhasil|lulus)\b/i.test(l) &&
          m.role !== "user" && verification.length < 8) verification.push(limitText(l));
    }
  }
  return { version: 1, createdAt: Date.now(), goal, decisions, completed, pending, blockers,
    files: [...files], tools: [...tools].slice(0, 30), verification, sessionSummary };
}

/**
 * Explicit decisions/checklists/blockers must survive, not just the last user turn.
 * Normalization allows harmless formatting changes while avoiding fabricated status.
 */
function carriesFact(text: string, fact: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const needle = normalize(fact);
  return needle.length === 0 || normalize(text).includes(needle);
}

export function validateCompaction(source: Message[], target: Message[]): CompactionQuality {
  const missing: string[] = [], warnings: string[] = [];
  if (!target.length) missing.push("empty-result");
  const current = activeUserRequest(source);
  const after = target.map((m) => contentToString(m.content)).join("\n");
  if (current && !after.includes(current.slice(0, Math.min(current.length, USER_PREFIX_CHARS)))) {
    missing.push("active-user-goal");
  }
  const checkpoint = buildContextCheckpoint(source);
  const required = [
    ["decisions", checkpoint.decisions],
    ["pending-tasks", checkpoint.pending],
    ["blockers", checkpoint.blockers],
  ] as const;
  for (const [category, facts] of required) {
    if (facts.some((fact) => !carriesFact(after, fact))) missing.push(category);
  }
  if (checkpoint.verification.some((fact) => !carriesFact(after, fact))) warnings.push("verification-evidence");
  const summaryBefore = source.filter((m) => isCompactionSummaryText(contentToString(m.content)));
  if (summaryBefore.length && !after.includes("System Conversation Summary") &&
      !after.includes("Emergency Summary")) warnings.push("prior-summary-not-visible");
  const seenCalls = new Set<string>();
  let orphans = 0;
  for (const message of target) {
    for (const call of message.toolCalls || []) seenCalls.add(call.id);
    if (message.role === "tool" && message.toolResults?.some((result) => !seenCalls.has(result.toolCallId))) orphans++;
  }
  if (orphans) missing.push("orphaned-tool-results");
  const score = Math.max(0, 100 - missing.length * 35 - warnings.length * 10);
  return { passed: missing.length === 0, score, missing, warnings };
}

/** Preserve critical known facts before pruning results are allowed into the live transcript.
 * These are extracted from already observed messages, not generated as new "successes".
 */
export function preserveContextFacts(source: Message[], target: Message[]): Message[] {
  const checkpoint = buildContextCheckpoint(source);
  const all = target.map((m) => contentToString(m.content)).join("\n");
  const facts = [
    ...checkpoint.decisions,
    ...checkpoint.pending,
    ...checkpoint.blockers,
  ].filter((fact) => !carriesFact(all, fact)).slice(0, 32);
  if (facts.length === 0) return target;
  const annotation = "\n### Preserved facts from older context (verify against source logs)\n" +
    facts.map((fact) => "- " + fact).join("\n");
  const existingSummaryIndex = target.findIndex((m) => isCompactionSummaryText(contentToString(m.content)));
  const cloned = [...target];
  if (existingSummaryIndex >= 0) {
    const old = cloned[existingSummaryIndex];
    cloned[existingSummaryIndex] = { ...old, content: contentToString(old.content) + annotation };
  } else {
    cloned.unshift({ role: "user", content: "[System Conversation Summary]:\n" + annotation, timestamp: Date.now() });
  }
  return cloned;
}

/** Status for CLI and monitoring without requiring a second LLM request. */
export function transcriptDigest(messages: Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

export class ContextContinuityStore {
  private snapshots: CompactionSnapshot[] = [];
  private metrics: CompactionMetrics = { count: 0, tokensSaved: 0, totalDurationMs: 0, failures: 0 };
  private readonly diskPath?: string;
  private committedCheckpoint?: ContextCheckpoint;
  constructor(historyFilePath?: string) {
    if (historyFilePath && path.isAbsolute(historyFilePath)) {
      this.diskPath = historyFilePath + ".compaction.gz";
      this.load();
    }
  }
  private load(): void {
    if (!this.diskPath) return;
    try {
      if (fs.statSync(this.diskPath).size > MAX_STORE_BYTES) return;
      const data = JSON.parse(gunzipSync(fs.readFileSync(this.diskPath), { maxOutputLength: MAX_SNAPSHOT_BYTES * KEEP_SNAPSHOTS + 1024 * 1024 }).toString("utf8"));
      if (data.version !== 1 || !Array.isArray(data.snapshots)) return;
      this.snapshots = data.snapshots.slice(-KEEP_SNAPSHOTS);
      if (data.metrics?.count >= 0) this.metrics = data.metrics;
      if (data.checkpoint?.version === 1) this.committedCheckpoint = data.checkpoint;
    } catch { /* missing or corrupted snapshots do not block the agent */ }
  }
  private save(): void {
    if (!this.diskPath) return;
    try {
      const data = gzipSync(Buffer.from(JSON.stringify({ version: 1, snapshots: this.snapshots, metrics: this.metrics, checkpoint: this.committedCheckpoint })));
      if (data.byteLength > MAX_STORE_BYTES) return;
      fs.mkdirSync(path.dirname(this.diskPath), { recursive: true, mode: 0o700 });
      const temp = this.diskPath + "." + process.pid + ".tmp";
      fs.writeFileSync(temp, data, { mode: 0o600 });
      fs.renameSync(temp, this.diskPath);
    } catch { /* keep in-memory rollback when disk is inaccessible */ }
  }
  capture(messages: Message[], beforeTokens: number): CompactionSnapshot {
    const checkpoint = buildContextCheckpoint(messages);
    const bytes = Buffer.byteLength(JSON.stringify(messages));
    const id = "compact-" + Date.now() + "-" + createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex").slice(0, 10);
    const snapshot: CompactionSnapshot = {
      id, createdAt: Date.now(), beforeTokens,
      messages: bytes <= MAX_SNAPSHOT_BYTES ? structuredClone(messages) : [],
      checkpoint,
    };
    if (bytes <= MAX_SNAPSHOT_BYTES) {
      this.snapshots.push(snapshot);
      this.snapshots = this.snapshots.slice(-KEEP_SNAPSHOTS);
      this.save();
    }
    return snapshot;
  }
  preview(messages: Message[]): { checkpoint: ContextCheckpoint; tokensApprox: number; qualityRisk: string[] } {
    const checkpoint = buildContextCheckpoint(messages);
    return { checkpoint, tokensApprox: Math.ceil(JSON.stringify(messages).length / 4),
      qualityRisk: checkpoint.goal ? [] : ["No active user request found"] };
  }
  listSnapshots(): Array<{ id: string; createdAt: number; messages: number; goal: string }> {
    return this.snapshots.map((s) => ({ id: s.id, createdAt: s.createdAt, messages: s.messages.length, goal: limitText(s.checkpoint.goal, 80) }));
  }
  markCommitted(snapshotId: string, compacted: Message[]): void {
    const found = this.snapshots.find((s) => s.id === snapshotId);
    if (found) { found.compactedDigest = transcriptDigest(compacted); this.save(); }
  }
  canUndo(snapshotId: string | undefined, current: Message[]): boolean {
    const found = snapshotId ? this.snapshots.find((s) => s.id === snapshotId) : this.snapshots.at(-1);
    return !!found && !!found.compactedDigest && found.compactedDigest === transcriptDigest(current);
  }
  discard(snapshotId: string): void {
    this.snapshots = this.snapshots.filter((s) => s.id !== snapshotId);
    this.save();
  }
  restore(snapshotId?: string): Message[] | undefined {
    const found = snapshotId ? this.snapshots.find((s) => s.id === snapshotId) : this.snapshots.at(-1);
    return found ? structuredClone(found.messages) : undefined;
  }
  latestCheckpoint(): ContextCheckpoint | undefined { return this.committedCheckpoint ?? this.snapshots.at(-1)?.checkpoint; }
  getCommittedCheckpoint(): ContextCheckpoint | undefined {
    return this.committedCheckpoint ? structuredClone(this.committedCheckpoint) : undefined;
  }
  commitCheckpoint(checkpoint: ContextCheckpoint): void {
    this.committedCheckpoint = structuredClone(checkpoint);
    this.save();
  }
  getMetrics(): CompactionMetrics { return structuredClone(this.metrics); }
  record(strategy: string, durationMs: number, before: number, after: number, quality: number, fallback: boolean): void {
    this.metrics.count++;
    this.metrics.tokensSaved += Math.max(0, before - after);
    this.metrics.totalDurationMs += Math.max(0, durationMs);
    this.metrics.latest = { strategy, durationMs, tokensBefore: before, tokensAfter: after, quality, fallback };
    this.save();
  }
  failure(): void { this.metrics.failures++; this.save(); }
}

/** Small reference model for running comparable deterministic benchmark workloads. */
export function benchmarkCompaction(source: Message[], transformed: Message[]): { bytesBefore: number; bytesAfter: number; reductionPct: number; quality: CompactionQuality; checkpointFields: number } {
  const bytesBefore = Buffer.byteLength(JSON.stringify(source));
  const bytesAfter = Buffer.byteLength(JSON.stringify(transformed));
  return {
    bytesBefore, bytesAfter,
    reductionPct: bytesBefore ? Number(((1 - bytesAfter / bytesBefore) * 100).toFixed(2)) : 0,
    quality: validateCompaction(source, transformed),
    checkpointFields: Object.keys(buildContextCheckpoint(source)).length,
  };
}

/** Tool-result retention based on changed state and actionable evidence, not fixed prefixes. */
export function compactToolResult(output: string, name: string, isError: boolean, maxChars = 900, archiveId?: string): string {
  return formatToolEvidence(output, name, isError, maxChars, archiveId);
}

/** Names the three retention tiers without inventing persistent memories. */
export function hierarchyForCheckpoint(checkpoint: ContextCheckpoint) {
  return {
    working: { goal: checkpoint.goal, pending: checkpoint.pending, blockers: checkpoint.blockers },
    session: { decisions: checkpoint.decisions, completed: checkpoint.completed, files: checkpoint.files, verification: checkpoint.verification },
    project: { candidateDecisions: checkpoint.decisions, persistence: "Review before promoting to project/RMemory" },
  };
}

/** Current session evidence only. Candidate project decisions remain unapproved. */
export function formatCheckpointMemory(checkpoint: ContextCheckpoint, maxChars = 1600): string {
  const section = (label: string, items: string[], max = 6) =>
    items.length ? label + ": " + items.slice(0, max).join(" | ") : "";
  return [
    "[Compaction checkpoint: current session, evidence only; do not treat as approved project memory]",
    checkpoint.goal ? "Active goal: " + checkpoint.goal : "",
    section("Pending", checkpoint.pending),
    section("Decisions", checkpoint.decisions),
    section("Blockers", checkpoint.blockers, 3),
    section("Verified evidence", checkpoint.verification, 3),
    section("Changed/reference files", checkpoint.files, 6),
    "Project memory candidates require explicit review.",
  ].filter(Boolean).join("\n").slice(0, maxChars);
}
