/**
 * Phase 4j: append-only, authenticated Muse replay tombstone segments.
 * Every referenced segment is verified in full at journal load. Missing or
 * modified segments fail closed BEFORE any batch can be claimed.
 *
 * These are application-immutable files, not OS-level WORM storage. A user
 * with full local filesystem/key access can still delete or replace storage;
 * back up journal, archives and their private signing key together.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MuseBatchRecord } from "./museBatchJournal.js";

export interface MuseArchiveDescriptor {
  name: string;
  sha256: string;
  mac: string;
  count: number;
}
type Segment = { version: 1; port: number; entries: MuseBatchRecord[] };
const MAX_SEGMENTS = 256;
const MAX_ENTRIES_PER_SEGMENT = 64;
const MAX_SEGMENT_BYTES = 64_000;
const validDigest = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{64}$/.test(s);
const validName = (s: unknown): s is string => typeof s === "string" && /^[a-f0-9]{32}\.json$/.test(s);
const hash = (data: string) => crypto.createHash("sha256").update(data).digest("hex");
const mac = (key: Buffer, data: string) => crypto.createHmac("sha256", key).update(data).digest("hex");

export class MuseTombstoneArchive {
  readonly folder: string;
  readonly keyPath: string;
  constructor(readonly port: number, root: string) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid archive owner");
    this.folder = path.join(root, "muse-tombstones-" + port);
    this.keyPath = path.join(root, "muse-tombstones-" + port + ".key");
  }
  private keyRead(): Buffer {
    const stat = fs.lstatSync(this.keyPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 32) {
      throw new Error("Invalid Muse tombstone archive key");
    }
    const key = fs.readFileSync(this.keyPath);
    if (key.length !== 32) throw new Error("Invalid Muse tombstone archive key length");
    return key;
  }
  private keyWrite(): Buffer {
    if (fs.existsSync(this.keyPath)) return this.keyRead();
    fs.mkdirSync(path.dirname(this.keyPath), { recursive: true });
    const key = crypto.randomBytes(32);
    try {
      const fd = fs.openSync(this.keyPath, "wx", 0o600);
      try { fs.writeFileSync(fd, key); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return this.keyRead();
      throw error;
    }
    return key;
  }
  /** Does NOT read unreferenced/orphan files; journal still owns their IDs. */
  read(manifest: MuseArchiveDescriptor[]): MuseBatchRecord[] {
    if (!Array.isArray(manifest) || manifest.length > MAX_SEGMENTS) {
      throw new Error("Invalid Muse tombstone manifest");
    }
    const names = new Set<string>();
    const batches = new Set<string>();
    const records: MuseBatchRecord[] = [];
    if (manifest.length) this.keyRead(); // key absence/tamper => fail closed
    for (const item of manifest) {
      if (!item || !validName(item.name) || names.has(item.name) ||
          !validDigest(item.sha256) || !validDigest(item.mac) ||
          !Number.isSafeInteger(item.count) || item.count < 1 ||
          item.count > MAX_ENTRIES_PER_SEGMENT) throw new Error("Invalid Muse tombstone descriptor");
      names.add(item.name);
      const file = path.join(this.folder, item.name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SEGMENT_BYTES || stat.size < 1) {
        throw new Error("Missing or invalid Muse tombstone archive");
      }
      const content = fs.readFileSync(file, "utf8");
      if (hash(content) !== item.sha256 ||
          mac(this.keyRead(), content) !== item.mac) throw new Error("Muse tombstone archive integrity mismatch");
      const parsed = JSON.parse(content) as Segment;
      if (!parsed || parsed.version !== 1 || parsed.port !== this.port ||
          !Array.isArray(parsed.entries) || parsed.entries.length !== item.count) {
        throw new Error("Muse tombstone archive schema mismatch");
      }
      for (const record of parsed.entries) {
        if (!record || typeof record.batchId !== "string" || batches.has(record.batchId) ||
            !record.resultAck || record.payloadReleasedAt === undefined ||
            record.stage !== "delivered") throw new Error("Invalid or duplicate tombstone record");
        batches.add(record.batchId);
        records.push(record);
      }
    }
    return records;
  }
  /** New random file name; no prior archive is overwritten. */
  append(records: MuseBatchRecord[], existing: MuseArchiveDescriptor[]): MuseArchiveDescriptor {
    if (!Array.isArray(records) || records.length < 1 || records.length > MAX_ENTRIES_PER_SEGMENT ||
        existing.length >= MAX_SEGMENTS || records.some(record =>
          record.stage !== "delivered" || !record.resultAck || record.payloadReleasedAt === undefined)) {
      throw new Error("Only 1..64 final ACKed tombstones may be archived per segment");
    }
    const payload = JSON.stringify({ version: 1, port: this.port, entries: records } satisfies Segment);
    if (Buffer.byteLength(payload) > MAX_SEGMENT_BYTES) throw new Error("Tombstone archive segment too large");
    const key = this.keyWrite();
    const name = crypto.randomBytes(16).toString("hex") + ".json";
    const descriptor: MuseArchiveDescriptor = {
      name, sha256: hash(payload), mac: mac(key, payload), count: records.length,
    };
    fs.mkdirSync(this.folder, { recursive: true });
    // A crash before rename leaves an unreferenced .tmp file. The journal
    // still contains the selected records until its own atomic save succeeds.
    const tmp = path.join(this.folder, name + ".tmp");
    const final = path.join(this.folder, name);
    if (fs.existsSync(final)) throw new Error("Refusing tombstone segment overwrite");
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(tmp, final);
      try { fs.chmodSync(final, 0o600); } catch {}
    } finally {
      try { fs.rmSync(tmp, { force: true }); } catch {}
    }
    return descriptor;
  }
  static maxSegments = MAX_SEGMENTS;
  static maxPerSegment = MAX_ENTRIES_PER_SEGMENT;
}
