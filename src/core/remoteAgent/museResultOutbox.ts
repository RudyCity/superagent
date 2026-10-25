/**
 * Phase 4f: encrypted, owner-scoped, bounded and durable result outbox.
 * Result payloads are potentially sensitive. Only AES-256-GCM ciphertext
 * is persisted, with a separate private per-port key. Never logs outputs.
 * A valid outbox does not permit automatic replay or tool re-execution.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskResultEnvelope } from "./protocol.js";

const MAX_ITEMS = 64;
const MAX_PAYLOAD_BYTES = 96_000;
const MAX_STORE_BYTES = 9_000_000;
const validId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= 256 && !s.includes("\0");
const sha = (raw: string): string => crypto.createHash("sha256").update(raw).digest("hex");
const digestOk = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
type OutboxEntry = {
  batchId: string; taskId: string; sha256: string; nonce: string; tag: string;
  ciphertext: string; createdAt: number;
};
type OutboxSnapshot = { version: 1; port: number; entries: OutboxEntry[] };
export function outboxFile(port: number, root = path.join(os.homedir(), ".superagent-r")) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid outbox port");
  return path.join(root, "muse-results-" + port + ".json");
}

export class MuseResultOutbox {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly entries = new Map<string, OutboxEntry>();
  constructor(readonly port: number, rootDir?: string) {
    this.file = outboxFile(port, rootDir);
    this.keyFile = this.file + ".key";
    if (!fs.existsSync(this.file)) {
      // Do not silently lose an existing key's ciphertext because its index
      // is missing. A leftover key requires deliberate operator review.
      if (fs.existsSync(this.keyFile)) throw new Error("Orphaned outbox key without index");
      return;
    }
    const stat = fs.lstatSync(this.file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES ||
        !fs.existsSync(this.keyFile)) throw new Error("Invalid encrypted outbox storage");
    const key = this.readKey();
    const data = JSON.parse(fs.readFileSync(this.file, "utf8")) as OutboxSnapshot;
    if (!data || data.version !== 1 || data.port !== port ||
        !Array.isArray(data.entries) || data.entries.length > MAX_ITEMS) {
      throw new Error("Invalid result outbox schema");
    }
    for (const entry of data.entries) {
      if (!entry || !validId(entry.batchId) || !validId(entry.taskId) ||
          !digestOk(entry.sha256) || !Number.isSafeInteger(entry.createdAt) || entry.createdAt <= 0 ||
          !/^[a-f0-9]{24}$/.test(entry.nonce) || !/^[a-f0-9]{32}$/.test(entry.tag) ||
          typeof entry.ciphertext !== "string" || entry.ciphertext.length > MAX_PAYLOAD_BYTES * 2 ||
          this.entries.has(entry.batchId)) throw new Error("Malformed result outbox entry");
      this.decrypt(entry, key); // validate authentication tag and schema before ownership
      this.entries.set(entry.batchId, entry);
    }
  }
  private readKey(): Buffer {
    const stat = fs.lstatSync(this.keyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) throw new Error("Invalid outbox key file");
    const key = fs.readFileSync(this.keyFile);
    if (key.length !== 32) throw new Error("Invalid outbox encryption key");
    return key;
  }
  private keyForWrite(): Buffer {
    if (fs.existsSync(this.keyFile)) return this.readKey();
    fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
    const key = crypto.randomBytes(32);
    try { fs.writeFileSync(this.keyFile, key, { flag: "wx", mode: 0o600 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return this.readKey();
      throw e;
    }
    return key;
  }
  private decrypt(entry: OutboxEntry, key: Buffer): TaskResultEnvelope {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(entry.nonce, "hex"));
    decipher.setAAD(Buffer.from(entry.batchId + "\0" + entry.taskId + "\0" + entry.sha256));
    decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
    const bytes = Buffer.concat([decipher.update(Buffer.from(entry.ciphertext, "base64")), decipher.final()]);
    if (bytes.length > MAX_PAYLOAD_BYTES || sha(bytes.toString("utf8")) !== entry.sha256) {
      throw new Error("Corrupt result outbox payload");
    }
    const parsed = JSON.parse(bytes.toString("utf8")) as TaskResultEnvelope;
    if (!parsed || parsed.kind !== "task_result" || parsed.v !== 1 ||
        parsed.id !== entry.batchId || parsed.task_id !== entry.taskId ||
        !Array.isArray(parsed.results)) throw new Error("Invalid result outbox envelope");
    return { ...parsed, result_sha256: entry.sha256 };
  }
  private save() {
    const content = JSON.stringify({ version: 1, port: this.port, entries: [...this.entries.values()] } satisfies OutboxSnapshot);
    if (Buffer.byteLength(content) > MAX_STORE_BYTES) throw new Error("Encrypted outbox storage limit reached");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = this.file + "." + process.pid + ".tmp";
    try {
      const fd = fs.openSync(temp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch {}
    } finally { try { fs.rmSync(temp, { force: true }); } catch {} }
  }
  /** Idempotent same-payload put; conflicting IDs are rejected. */
  put(envelope: TaskResultEnvelope): { sha256: string; result: TaskResultEnvelope } {
    if (!validId(envelope.id) || !validId(envelope.task_id) || !Array.isArray(envelope.results)) {
      throw new Error("Invalid task result outbox envelope");
    }
    const raw = JSON.stringify({ v: 1, kind: "task_result", id: envelope.id,
      task_id: envelope.task_id, results: envelope.results });
    if (Buffer.byteLength(raw) > MAX_PAYLOAD_BYTES) throw new Error("Result too large for durable outbox; withholding transport send");
    const digest = sha(raw);
    const existing = this.entries.get(envelope.id);
    if (existing) {
      if (existing.sha256 !== digest || existing.taskId !== envelope.task_id) throw new Error("Conflicting result outbox ID");
      return { sha256: digest, result: this.get(envelope.id)! };
    }
    if (this.entries.size >= MAX_ITEMS) throw new Error("Encrypted outbox is full; operator maintenance required");
    const key = this.keyForWrite();
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(envelope.id + "\0" + envelope.task_id + "\0" + digest));
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(raw)), cipher.final()]).toString("base64");
    const entry: OutboxEntry = { batchId: envelope.id, taskId: envelope.task_id, sha256: digest,
      nonce: nonce.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext,
      createdAt: Date.now() };
    this.entries.set(entry.batchId, entry);
    try { this.save(); } catch (error) { this.entries.delete(entry.batchId); throw error; }
    return { sha256: digest, result: { ...envelope, result_sha256: digest } };
  }
  get(batchId: string): TaskResultEnvelope | null {
    if (!validId(batchId)) return null;
    const entry = this.entries.get(batchId);
    return entry ? this.decrypt(entry, this.readKey()) : null;
  }
  /**
   * Drop ciphertext ONLY after the journal durably stored an ACK-bound
   * payload-release tombstone. The caller supplies the persisted ACK digest.
   * An absent entry is an idempotent no-op after partial cleanup.
   */
  releaseAcknowledgedPayload(batchId: string, ackSha256: string): boolean {
    if (!validId(batchId) || !digestOk(ackSha256)) throw new Error("Invalid cleanup identity");
    const entry = this.entries.get(batchId);
    if (!entry) return false;
    if (entry.sha256 !== ackSha256) throw new Error("Cleanup result digest mismatch");
    this.entries.delete(batchId);
    try { this.save(); }
    catch (err) { this.entries.set(batchId, entry); throw err; }
    return true;
  }
  digest(batchId: string): string | null { return this.entries.get(batchId)?.sha256 || null; }
  /** Metadata only; never exposes ciphertext, outputs or decryption keys. */
  summaries(): Array<{ batchId: string; taskId: string; sha256: string }> {
    return [...this.entries.values()].map(({ batchId, taskId, sha256 }) => ({ batchId, taskId, sha256 }));
  }
  count(): number { return this.entries.size; }
}
