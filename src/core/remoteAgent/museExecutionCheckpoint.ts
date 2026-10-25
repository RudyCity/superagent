/**
 * Phase 4g — encrypted execution-intent checkpoints.
 *
 * A stored batch can be explicitly resumed ONCE only if NO tool has begun.
 * Tool starts are durably recorded before invoking a tool. Any began call,
 * whether completed, failed, or interrupted, permanently blocks resume.
 * This does not serialize an agent's thought process or imply exactly once.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskBatchEnvelope } from "./protocol.js";

type CheckpointBatch = {
  envelope: TaskBatchEnvelope;
  targetWorkspace: string;
  reserved: boolean;
  started: string[];
  finished: string[];
  createdAt: number;
};
type Payload = { version: 1; ownerPort: number; batches: CheckpointBatch[] };
type CipherDoc = { version: 1; ownerPort: number; iv: string; tag: string; data: string };
const MAX_BATCHES = 64, MAX_BYTES = 512_000;
const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 256 && !v.includes("\0");

export function executionCheckpointFile(port: number, root = path.join(os.homedir(), ".superagent-r")): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid execution checkpoint port");
  return path.join(root, "muse-execution-" + port + ".json");
}

export class MuseExecutionCheckpoint {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly batches = new Map<string, CheckpointBatch>();
  constructor(readonly port: number, rootDir?: string) {
    this.file = executionCheckpointFile(port, rootDir);
    this.keyFile = this.file + ".key";
    if (!fs.existsSync(this.file)) {
      if (fs.existsSync(this.keyFile)) throw new Error("Orphaned execution checkpoint key; inspect manually");
      return;
    }
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES * 2 ||
        !fs.existsSync(this.keyFile)) throw new Error("Invalid execution checkpoint file");
    const doc = JSON.parse(fs.readFileSync(this.file, "utf8")) as CipherDoc;
    if (!doc || doc.version !== 1 || doc.ownerPort !== port ||
        !/^[a-f0-9]{24}$/.test(doc.iv) || !/^[a-f0-9]{32}$/.test(doc.tag) ||
        typeof doc.data !== "string" || doc.data.length > MAX_BYTES * 2) throw new Error("Invalid execution checkpoint wrapper");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.readKey(), Buffer.from(doc.iv, "hex"));
    decipher.setAAD(Buffer.from("muse-execution\0" + port));
    decipher.setAuthTag(Buffer.from(doc.tag, "hex"));
    const clear = Buffer.concat([decipher.update(Buffer.from(doc.data, "base64")), decipher.final()]);
    if (clear.length > MAX_BYTES) throw new Error("Oversized execution checkpoint");
    const data = JSON.parse(clear.toString("utf8")) as Payload;
    if (data.version !== 1 || data.ownerPort !== port ||
        !Array.isArray(data.batches) || data.batches.length > MAX_BATCHES) throw new Error("Invalid execution checkpoint schema");
    for (const item of data.batches) {
      const envelope = item?.envelope;
      if (!envelope || envelope.kind !== "task_batch" || envelope.v !== 1 ||
          !validId(envelope.id) || !validId(envelope.task_id) ||
          !Array.isArray(envelope.calls) || envelope.calls.length > 1000 ||
          !envelope.calls.every(call => validId(call.id) && typeof call.tool === "string") ||
          !validId(item.targetWorkspace) || typeof item.reserved !== "boolean" ||
          !Array.isArray(item.started) || !Array.isArray(item.finished) ||
          !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0 ||
          this.batches.has(envelope.id)) throw new Error("Invalid execution checkpoint batch");
      const callIds = new Set(envelope.calls.map(call => call.id));
      if (callIds.size !== envelope.calls.length ||
          item.started.some(id => !callIds.has(id)) ||
          item.finished.some(id => !item.started.includes(id)) ||
          new Set(item.started).size !== item.started.length ||
          new Set(item.finished).size !== item.finished.length) throw new Error("Invalid execution checkpoint progress");
      this.batches.set(envelope.id, item);
    }
  }
  private readKey(): Buffer {
    const s = fs.lstatSync(this.keyFile);
    if (!s.isFile() || s.isSymbolicLink() || s.size !== 32) throw new Error("Invalid execution checkpoint key");
    return fs.readFileSync(this.keyFile);
  }
  private keyForWrite(): Buffer {
    if (fs.existsSync(this.keyFile)) return this.readKey();
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    const key = crypto.randomBytes(32);
    try {
      const fd = fs.openSync(this.keyFile, "wx", 0o600);
      try { fs.writeFileSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return this.readKey();
      throw err;
    }
    return key;
  }
  private save(): void {
    const clear = Buffer.from(JSON.stringify({
      version: 1, ownerPort: this.port, batches: [...this.batches.values()],
    } satisfies Payload));
    if (clear.length > MAX_BYTES) throw new Error("Execution checkpoint limit reached");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.keyForWrite(), iv);
    cipher.setAAD(Buffer.from("muse-execution\0" + this.port));
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]).toString("base64");
    const doc: CipherDoc = { version: 1, ownerPort: this.port, iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"), data: ciphertext };
    const temp = this.file + "." + process.pid + ".tmp";
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(doc)); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch {}
    } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
  }
  /** Store exact encrypted intent BEFORE executing any call, after journal claim. */
  store(envelope: TaskBatchEnvelope, targetWorkspace: string): void {
    if (!validId(envelope.id) || !validId(envelope.task_id) ||
        !validId(targetWorkspace) || !Array.isArray(envelope.calls) ||
        envelope.calls.length > 1000 || !envelope.calls.every(c => validId(c.id)) ||
        new Set(envelope.calls.map(c => c.id)).size !== envelope.calls.length) {
      throw new Error("Invalid execution intent");
    }
    if (this.batches.has(envelope.id)) throw new Error("Execution intent already recorded");
    if (this.batches.size >= MAX_BATCHES) throw new Error("Execution checkpoint full");
    this.batches.set(envelope.id, { envelope: JSON.parse(JSON.stringify(envelope)),
      targetWorkspace, reserved: false, started: [], finished: [], createdAt: Date.now() });
    try { this.save(); } catch (err) { this.batches.delete(envelope.id); throw err; }
  }
  /** Called immediately BEFORE invoking any tool, including read-only tools. */
  markStarted(batchId: string, callId: string): void {
    const entry = this.batches.get(batchId);
    if (!entry || !entry.envelope.calls.some(c => c.id === callId) || entry.started.includes(callId)) {
      throw new Error("Execution call start refused");
    }
    entry.started.push(callId);
    try { this.save(); } catch (err) { entry.started.pop(); throw err; }
  }
  markFinished(batchId: string, callId: string): void {
    const entry = this.batches.get(batchId);
    if (!entry || !entry.started.includes(callId) || entry.finished.includes(callId)) {
      throw new Error("Execution call completion refused");
    }
    entry.finished.push(callId);
    try { this.save(); } catch (err) { entry.finished.pop(); throw err; }
  }
  /**
   * One-shot explicit reservation. Any known start or previous reservation
   * fails closed; not a general automatic replay of an interrupted agent.
   */
  reserveUntouched(batchId: string, currentWorkspaces: string[]): TaskBatchEnvelope | null {
    const entry = this.batches.get(batchId);
    if (!entry || entry.reserved || entry.started.length > 0 ||
        !currentWorkspaces.some(w => path.resolve(w).toLowerCase() === path.resolve(entry.targetWorkspace).toLowerCase())) {
      return null;
    }
    entry.reserved = true;
    try { this.save(); } catch (err) { entry.reserved = false; throw err; }
    // Pin the exact originally resolved workspace, not an ambiguous project
    // name that could resolve differently when watch order changes.
    const resumed = JSON.parse(JSON.stringify(entry.envelope)) as TaskBatchEnvelope;
    resumed.workspace = entry.targetWorkspace;
    return resumed;
  }
  info(batchId: string) {
    const entry = this.batches.get(batchId);
    return entry ? { batchId, taskId: entry.envelope.task_id, total: entry.envelope.calls.length,
      started: entry.started.length, finished: entry.finished.length, reserved: entry.reserved,
      canResumeUntouched: !entry.reserved && entry.started.length === 0 } : null;
  }
  summaries() { return [...this.batches.keys()].map(id => this.info(id)!); }
}
