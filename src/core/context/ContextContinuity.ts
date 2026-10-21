import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Message } from "../conversation.js";
import { contentToString } from "../conversation.js";
import { isCompactionSummaryText } from "./CompactionStrategy.js";

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
    for (const file of text.match(/(?:[\w.-]+[\\/])+[\w.-]+/g) || []) {
      if (files.size < 24 && !file.includes("node_modules") && !file.includes(".git")) files.add(file);
    }
    for (const tc of m.toolCalls || []) tools.add(tc.name);
    for (const tr of m.toolResults || []) {
      if (tr.isError && blockers.length < 8) blockers.push(limitText(tr.name + ": " + tr.result));
    }
    for (const line of text.split("\n").slice(0, 100)) {
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

/** Validate continuity of the live objective before replacing the source transcript. */
export function validateCompaction(source: Message[], target: Message[]): CompactionQuality {
  const missing: string[] = [], warnings: string[] = [];
  if (!target.length) missing.push("empty-result");
  const current = activeUserRequest(source);
  const after = target.map((m) => contentToString(m.content)).join("\n");
  if (current && !after.includes(current.slice(0, Math.min(current.length, USER_PREFIX_CHARS)))) {
    missing.push("active-user-goal");
  }
  const summaryBefore = source.filter((m) => isCompactionSummaryText(contentToString(m.content)));
  if (summaryBefore.length && !after.includes("System Conversation Summary") &&
    !after.includes("Emergency Summary") && !target.some((m) => contentToString(m.content).includes(summaryBefore.at(-1)!.content as string))) {
    warnings.push("prior-summary-not-visible");
  }
  const orphanedTools = target.filter((m, i) => m.role === "tool" &&
    !target.slice(0, i).some((prev) => prev.role === "assistant" && prev.toolCalls?.some(
      (call) => m.toolResults?.some((result) => result.toolCallId === call.id)
    )));
  if (orphanedTools.length) warnings.push("orphaned-tool-results:" + orphanedTools.length);
  const score = Math.max(0, 100 - missing.length * 65 - warnings.length * 12);
  return { passed: missing.length === 0, score, missing, warnings };
}

/** Status for CLI and monitoring without requiring a second LLM request. */
export class ContextContinuityStore {
  private snapshots: CompactionSnapshot[] = [];
  private metrics: CompactionMetrics = { count: 0, tokensSaved: 0, totalDurationMs: 0, failures: 0 };
  private readonly diskPath?: string;
  constructor(historyFilePath?: string) {
    if (historyFilePath && path.isAbsolute(historyFilePath)) {
      this.diskPath = historyFilePath + ".compaction.gz";
      this.load();
    }
  }
  private load(): void {
    if (!this.diskPath) return;
    try {
      const data = JSON.parse(gunzipSync(fs.readFileSync(this.diskPath)).toString("utf8"));
      if (data.version !== 1 || !Array.isArray(data.snapshots)) return;
      this.snapshots = data.snapshots.slice(-KEEP_SNAPSHOTS);
      if (data.metrics?.count >= 0) this.metrics = data.metrics;
    } catch { /* missing or corrupted snapshots do not block the agent */ }
  }
  private save(): void {
    if (!this.diskPath) return;
    try {
      const data = gzipSync(Buffer.from(JSON.stringify({ version: 1, snapshots: this.snapshots, metrics: this.metrics })));
      if (data.byteLength > MAX_STORE_BYTES) return;
      fs.mkdirSync(path.dirname(this.diskPath), { recursive: true });
      const temp = this.diskPath + "." + process.pid + ".tmp";
      fs.writeFileSync(temp, data, { mode: 0o600 });
      fs.renameSync(temp, this.diskPath);
    } catch { /* keep in-memory rollback when disk is inaccessible */ }
  }
  capture(messages: Message[], beforeTokens: number): CompactionSnapshot {
    const checkpoint = buildContextCheckpoint(messages);
    const snapshot: CompactionSnapshot = {
      id: "compact-" + Date.now() + "-" + createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex").slice(0, 10),
      createdAt: Date.now(), beforeTokens,
      messages: structuredClone(messages),
      checkpoint,
    };
    // Do not persist pathological snapshots; preserve one recoverable copy in memory.
    if (Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_SNAPSHOT_BYTES) {
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
  restore(snapshotId?: string): Message[] | undefined {
    const found = snapshotId ? this.snapshots.find((s) => s.id === snapshotId) : this.snapshots.at(-1);
    return found ? structuredClone(found.messages) : undefined;
  }
  latestCheckpoint(): ContextCheckpoint | undefined { return this.snapshots.at(-1)?.checkpoint; }
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
export function compactToolResult(output: string, name: string, isError: boolean, maxChars = 900): string {
  if (output.length <= maxChars) return output;
  const lines = output.split(/\r?\n/);
  const evidence = lines.filter((line) =>
    /(?:error|failed|exception|passed|succeeded|changed|modified|written|created|updated|warning|exit code|commit|https?:\/\/)/i.test(line)
  );
  const head = lines.slice(0, 5), tail = lines.slice(-3);
  const selected = [...new Set([...head, ...evidence.slice(-14), ...tail])].join("\n");
  const trimmed = selected.slice(0, maxChars);
  return trimmed + "\n[truncated — compacted " + name + (isError ? " error" : " result") +
    ": " + output.length + " original chars; inspect session/tool logs for full output]";
}

/** Names the three retention tiers without inventing persistent memories. */
export function hierarchyForCheckpoint(checkpoint: ContextCheckpoint) {
  return {
    working: { goal: checkpoint.goal, pending: checkpoint.pending, blockers: checkpoint.blockers },
    session: { decisions: checkpoint.decisions, completed: checkpoint.completed, files: checkpoint.files, verification: checkpoint.verification },
    project: { candidateDecisions: checkpoint.decisions, persistence: "Review before promoting to project/RMemory" },
  };
}
