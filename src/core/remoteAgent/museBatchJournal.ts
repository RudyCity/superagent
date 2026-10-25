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
export interface MuseBatchRecord {
  batchId: string;
  taskId: string;
  stage: MuseBatchStage;
  callsCount: number;
  recordedAt: number;
  updatedAt: number;
}
interface MuseJournalData {
  version: 1;
  ownerPort: number;
  batches: MuseBatchRecord[];
}
export interface MuseJournalSummary {
  started: number;
  resultPending: number;
  delivered: number;
  uncertain: number;
  requiresReconciliation: number;
}
const MAX_RECORDS = 1000;
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
    Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= raw.recordedAt);
}
export class MuseBatchJournal {
  private readonly file: string;
  private batches = new Map<string, MuseBatchRecord>();
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
    if (existing.stage === "delivered") throw new Error("Delivered batch is immutable");
    if (stage === "delivered" && existing.stage !== "result_pending") {
      throw new Error("Cannot confirm delivery before recording result");
    }
    const old = { ...existing };
    existing.stage = stage;
    existing.updatedAt = Math.max(Date.now(), old.recordedAt);
    try { this.save(); }
    catch (error) { this.batches.set(batchId, old); throw error; }
  }
  list(): MuseBatchRecord[] {
    return [...this.batches.values()].map(record => ({ ...record }));
  }
  get(batchId: string): MuseBatchRecord | undefined {
    const record = this.batches.get(batchId);
    return record ? { ...record } : undefined;
  }
  summary(): MuseJournalSummary {
    const stages = [...this.batches.values()].map(record => record.stage);
    const started = stages.filter(stage => stage === "started").length;
    const resultPending = stages.filter(stage => stage === "result_pending").length;
    const delivered = stages.filter(stage => stage === "delivered").length;
    const uncertain = stages.filter(stage => stage === "uncertain").length;
    return { started, resultPending, delivered, uncertain,
      requiresReconciliation: started + resultPending + uncertain };
  }
}
