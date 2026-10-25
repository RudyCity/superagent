/**
 * Phase 4d — conservative, owner-only Muse batch journal.
 *
 * Only for explicitly managed channel hosts. Does NOT persist tool arguments,
 * outputs, prompts, credentials or full agent state. A prior batch ID is
 * NEVER automatically executed again, even if the prior result was incomplete.
 * Reconciliation is explicitly manual; this is a safety checkpoint, not a
 * serialised LLM or exactly-once external side-effect transaction.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MuseBatchStage = "started" | "result_pending" | "delivered" | "uncertain";
export type MuseReconciliationOutcome = "effect_verified" | "no_effect_verified";
export interface MuseBatchReview {
  outcome: MuseReconciliationOutcome;
  /** Digest of independently verified evidence; never an attestation by this runtime. */
  evidenceSha256: string;
  reviewedAt: number;
}
export interface MuseTaskSignal {
  taskId: string;
  phase: "accepted" | "done_seen";
  observedAt: number;
}
export interface MuseTaskRecoveryState {
  taskId: string;
  phase: "done_seen" | "accepted" | "batch_only";
  batches: number;
  delivered: number;
  reviewed: number;
  requiringReview: number;
  lastObservedAt: number;
  /** Does NOT mean the agent/LLM can be resumed from this snapshot. */
  status: "needs_review" | "reviewed_no_replay" | "delivery_recorded" | "metadata_only";
}
export interface MuseBatchRecord {
  batchId: string;
  taskId: string;
  stage: MuseBatchStage;
  callsCount: number;
  recordedAt: number;
  updatedAt: number;
  review?: MuseBatchReview;
}
interface MuseJournalData {
  version: 1;
  ownerPort: number;
  batches: MuseBatchRecord[];
  taskSignals?: MuseTaskSignal[];
}
export interface MuseJournalSummary {
  started: number;
  resultPending: number;
  delivered: number;
  uncertain: number;
  reviewed: number;
  requiresReconciliation: number;
}
const MAX_RECORDS = 1000;
const evidenceOk = (value: string) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const MAX_FILE_BYTES = 750_000;
const idOk = (value: string) => typeof value === "string" && value.length > 0 &&
  value.length <= 256 && !value.includes("\0");

export function museJournalFile(ownerPort: number, rootDir = path.join(os.homedir(), ".superagent-r")): string {
  if (!Number.isInteger(ownerPort) || ownerPort < 1 || ownerPort > 65535) throw new Error("Invalid owner port");
  return path.join(rootDir, "muse-batches-" + ownerPort + ".json");
}
function validateRecord(raw: MuseBatchRecord): boolean {
  return Boolean(raw && idOk(raw.batchId) && idOk(raw.taskId) &&
    ["started", "result_pending", "delivered", "uncertain"].includes(raw.stage) &&
    Number.isSafeInteger(raw.callsCount) && raw.callsCount >= 0 && raw.callsCount <= 1000 &&
    Number.isSafeInteger(raw.recordedAt) && raw.recordedAt > 0 &&
    Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= raw.recordedAt &&
    (!raw.review || (raw.stage !== "delivered" &&
      ["effect_verified", "no_effect_verified"].includes(raw.review.outcome) &&
      evidenceOk(raw.review.evidenceSha256) &&
      Number.isSafeInteger(raw.review.reviewedAt) &&
      raw.review.reviewedAt >= raw.recordedAt &&
      raw.review.reviewedAt <= raw.updatedAt)));
}
export class MuseBatchJournal {
  private readonly file: string;
  private batches = new Map<string, MuseBatchRecord>();
  private taskSignals = new Map<string, MuseTaskSignal>();
  constructor(readonly ownerPort: number, rootDir?: string) {
    this.file = museJournalFile(ownerPort, rootDir);
    if (!fs.existsSync(this.file)) return;
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      throw new Error("Invalid Muse batch checkpoint file");
    }
    const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as MuseJournalData;
    if (!parsed || parsed.version !== 1 || parsed.ownerPort !== ownerPort ||
        !Array.isArray(parsed.batches) || parsed.batches.length > MAX_RECORDS) {
      throw new Error("Invalid Muse batch checkpoint schema");
    }
    if (parsed.taskSignals !== undefined &&
        (!Array.isArray(parsed.taskSignals) || parsed.taskSignals.length > MAX_RECORDS)) {
      throw new Error("Invalid task recovery metadata");
    }
    for (const signal of parsed.taskSignals || []) {
      if (!signal || !idOk(signal.taskId) ||
          !["accepted", "done_seen"].includes(signal.phase) ||
          !Number.isSafeInteger(signal.observedAt) || signal.observedAt <= 0 ||
          this.taskSignals.has(signal.taskId)) {
        throw new Error("Invalid or duplicate task recovery signal");
      }
      this.taskSignals.set(signal.taskId, signal);
    }
    for (const record of parsed.batches) {
      if (!validateRecord(record) || this.batches.has(record.batchId)) {
        throw new Error("Invalid or duplicated Muse batch checkpoint record");
      }
      this.batches.set(record.batchId, record);
    }
  }
  private save(): void {
    const document: MuseJournalData = {
      version: 1, ownerPort: this.ownerPort, batches: [...this.batches.values()],
      taskSignals: [...this.taskSignals.values()],
    };
    const serialized = JSON.stringify(document);
    if (Buffer.byteLength(serialized) > MAX_FILE_BYTES) throw new Error("Muse checkpoint storage limit reached");
    const parent = path.dirname(this.file);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = this.file + "." + process.pid + ".tmp";
    try {
      fs.writeFileSync(temporary, serialized, { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch {}
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch {}
    }
  }
  /** Returns false for every previously observed ID: do not repeat tools. */
  claim(batchId: string, taskId: string, callsCount: number): boolean {
    if (!idOk(batchId) || !idOk(taskId) ||
        !Number.isSafeInteger(callsCount) || callsCount < 0 || callsCount > 1000) {
      throw new Error("Invalid batch checkpoint identity");
    }
    if (this.batches.has(batchId)) return false;
    if (this.batches.size >= MAX_RECORDS) throw new Error("Muse checkpoint record cap reached; reconcile/archive manually");
    const now = Date.now();
    this.batches.set(batchId, {
      batchId, taskId, stage: "started", callsCount, recordedAt: now, updatedAt: now,
    });
    try { this.save(); }
    catch (error) { this.batches.delete(batchId); throw error; }
    return true;
  }
  transition(batchId: string, stage: "result_pending" | "delivered" | "uncertain"): void {
    const existing = this.batches.get(batchId);
    if (!existing) throw new Error("Batch not checkpointed");
    if (existing.stage === "delivered" || existing.review) {
      throw new Error("Delivered or reviewed batch is immutable");
    }
    if (stage === "delivered" && existing.stage !== "result_pending") {
      throw new Error("Cannot confirm delivery before recording result");
    }
    const old = { ...existing };
    existing.stage = stage;
    existing.updatedAt = Math.max(Date.now(), old.recordedAt);
    try { this.save(); }
    catch (error) { this.batches.set(batchId, old); throw error; }
  }
  /**
   * External evidence review changes the recovery classification only. It is
   * never permission to replay a prior batch ID or declare remote delivery.
   * Keep the original execution stage intact, including result_pending.
   */
  reconcile(batchId: string, outcome: MuseReconciliationOutcome, evidenceSha256: string): MuseBatchRecord {
    if (!idOk(batchId) ||
        !["effect_verified", "no_effect_verified"].includes(outcome) ||
        !evidenceOk(evidenceSha256)) {
      throw new Error("Invalid reconciliation evidence");
    }
    const existing = this.batches.get(batchId);
    if (!existing) throw new Error("Unknown batch: cannot reconcile");
    if (existing.stage === "delivered") throw new Error("Delivered batch needs no manual reconciliation");
    if (existing.review) {
      if (existing.review.outcome === outcome && existing.review.evidenceSha256 === evidenceSha256) {
        return { ...existing, review: { ...existing.review } };
      }
      throw new Error("Conflicting reconciliation decision; review is immutable");
    }
    const previous = { ...existing };
    existing.review = { outcome, evidenceSha256, reviewedAt: Date.now() };
    existing.updatedAt = Math.max(existing.review.reviewedAt, existing.recordedAt);
    try { this.save(); }
    catch (error) { this.batches.set(batchId, previous); throw error; }
    return { ...existing, review: { ...existing.review } };
  }

  /** Record observed task lifecycle metadata; never store prompt/transcript. */
  observeTask(taskId: string, phase: "accepted" | "done_seen"): void {
    if (!idOk(taskId) || !["accepted", "done_seen"].includes(phase)) {
      throw new Error("Invalid task identity");
    }
    const previous = this.taskSignals.get(taskId);
    if (previous?.phase === "done_seen" || previous?.phase === phase) return;
    if (!previous && this.taskSignals.size >= MAX_RECORDS) {
      throw new Error("Task recovery metadata limit reached");
    }
    this.taskSignals.set(taskId, { taskId, phase, observedAt: Date.now() });
    try { this.save(); }
    catch (error) {
      if (previous) this.taskSignals.set(taskId, previous);
      else this.taskSignals.delete(taskId);
      throw error;
    }
  }

  /**
   * Conservative task-oriented projection of recorded facts. "done_seen"
   * only means the watcher received a remote signal, not durable LLM state.
   */
  taskRecovery(): MuseTaskRecoveryState[] {
    const groups = new Map<string, MuseTaskRecoveryState>();
    for (const signal of this.taskSignals.values()) {
      groups.set(signal.taskId, {
        taskId: signal.taskId, phase: signal.phase, batches: 0,
        delivered: 0, reviewed: 0, requiringReview: 0,
        lastObservedAt: signal.observedAt, status: "metadata_only",
      });
    }
    for (const batch of this.batches.values()) {
      let task = groups.get(batch.taskId);
      if (!task) {
        task = { taskId: batch.taskId, phase: "batch_only", batches: 0,
          delivered: 0, reviewed: 0, requiringReview: 0,
          lastObservedAt: 0, status: "metadata_only" };
        groups.set(batch.taskId, task);
      }
      task.batches++;
      if (batch.stage === "delivered") task.delivered++;
      else if (batch.review) task.reviewed++;
      else task.requiringReview++;
      task.lastObservedAt = Math.max(task.lastObservedAt, batch.updatedAt);
    }
    return [...groups.values()].map(task => ({
      ...task,
      status: task.requiringReview > 0 ? "needs_review" :
        task.reviewed > 0 ? "reviewed_no_replay" :
        task.delivered > 0 ? "delivery_recorded" : "metadata_only",
    }));
  }

  list(): MuseBatchRecord[] {
    return [...this.batches.values()].map(record => ({
      ...record, ...(record.review ? { review: { ...record.review } } : {}),
    }));
  }
  get(batchId: string): MuseBatchRecord | undefined {
    const record = this.batches.get(batchId);
    return record ? { ...record, ...(record.review ? { review: { ...record.review } } : {}) } : undefined;
  }
  summary(): MuseJournalSummary {
    const stages = [...this.batches.values()].map(record => record.stage);
    const started = stages.filter(stage => stage === "started").length;
    const resultPending = stages.filter(stage => stage === "result_pending").length;
    const delivered = stages.filter(stage => stage === "delivered").length;
    const uncertain = stages.filter(stage => stage === "uncertain").length;
    const reviewed = [...this.batches.values()].filter(record => !!record.review).length;
    return { started, resultPending, delivered, uncertain, reviewed,
      requiresReconciliation: started + resultPending + uncertain - reviewed };
  }
}
