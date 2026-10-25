/**
 * Phase 4m: append-only, per-port recovery health transition history.
 * Contains no tool input/output, prompts, keys, file paths or raw errors.
 *
 * A hash chain detects accidental edits/truncation inside the retained file.
 * Not HMAC-authenticated or rollback-proof against privileged filesystem users.
 * File is intentionally never automatically truncated/rotated.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type MuseIntegrityEventState = "degraded" | "failed" | "healthy";
export type MuseIntegrityEventReason = "STORAGE_CHECK_FAILED" | "VALIDATED" | "ALERT_LEDGER_INVALID";
export type MuseIntegrityEvent = {
  v: 1;
  port: number;
  seq: number;
  observedAt: number;
  state: MuseIntegrityEventState;
  reason: MuseIntegrityEventReason;
  prev: string;
  digest: string;
};
const EMPTY = "0".repeat(64);
const MAX_EVENTS = 2048;
const MAX_SIZE = 500_000;
const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const museIntegrityEventsFile = (port: number, root = path.join(os.homedir(), ".superagent-r")) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid event port");
  return path.join(root, "muse-integrity-" + port + ".jsonl");
};
export class MuseRecoveryIntegrityEvents {
  private readonly file: string;
  constructor(readonly port: number, root?: string) {
    this.file = museIntegrityEventsFile(port, root);
  }
  read(): MuseIntegrityEvent[] {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SIZE ||
        stat.size < 1) throw new Error("Invalid recovery integrity event file");
    const bytes = fs.readFileSync(this.file, "utf8");
    if (!bytes.endsWith("\n")) throw new Error("Incomplete recovery integrity event record");
    const lines = bytes.trimEnd().split("\n");
    if (lines.length > MAX_EVENTS) throw new Error("Recovery event history capacity reached");
    let prev = EMPTY;
    const result: MuseIntegrityEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const e = JSON.parse(lines[i]) as MuseIntegrityEvent;
      if (!e || e.v !== 1 || e.port !== this.port || e.seq !== i + 1 ||
          !Number.isSafeInteger(e.observedAt) || e.observedAt <= 0 ||
          !["degraded", "failed", "healthy"].includes(e.state) ||
          !["STORAGE_CHECK_FAILED", "VALIDATED", "ALERT_LEDGER_INVALID"].includes(e.reason) ||
          e.prev !== prev || typeof e.digest !== "string" ||
          !/^[0-9a-f]{64}$/.test(e.digest)) {
        throw new Error("Invalid recovery integrity event chain");
      }
      const { digest: _digest, ...fields } = e;
      if (hash(JSON.stringify(fields)) !== e.digest) {
        throw new Error("Recovery integrity event digest mismatch");
      }
      result.push(e);
      prev = e.digest;
    }
    return result;
  }
  static maxEvents = MAX_EVENTS;
  append(observedAt: number, state: MuseIntegrityEventState,
    reason: MuseIntegrityEventReason): MuseIntegrityEvent {
    const history = this.read();
    if (history.length >= MAX_EVENTS) {
      throw new Error("Recovery integrity event history is full; manual archival required");
    }
    const record = {
      v: 1 as const, port: this.port, seq: history.length + 1, observedAt,
      state, reason, prev: history.at(-1)?.digest || EMPTY,
    };
    const event: MuseIntegrityEvent = { ...record, digest: hash(JSON.stringify(record)) };
    const parent = path.dirname(this.file);
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const chunk = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(chunk) + (fs.existsSync(this.file) ? fs.lstatSync(this.file).size : 0) > MAX_SIZE) {
      throw new Error("Recovery integrity event storage full");
    }
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeFileSync(fd, chunk); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return event;
  }
}
