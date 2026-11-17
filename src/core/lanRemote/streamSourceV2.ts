import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import path from "node:path";
import { safeLanFilename } from "./fileTransfer.js";
import { LAN_V2_CHUNK_BYTES, LAN_V2_MAX_BYTES } from "./streamTransferV2.js";

type Selection = {
  filePath: string; name: string; size: number; sha256: string;
  dev: number; ino: number; mtimeMs: number; ctimeMs: number; revision: number;
};
type Active = Selection & { id: string; seq: number; lastUsed: number; generation: number };

/** Owner-selected local source, never an arbitrary network-controlled path. */
export class LanDiskSourceV2 {
  private selected: Selection | null = null;
  private active: Active | null = null;
  private revision = 0;
  private generation = 0;
  private receipt: { ok: true; transferId: string; name: string; bytes: number } | null = null;
  private receiptAt = 0;

  getShared() {
    const s = this.selected;
    if (!s) return null;
    return { name: s.name, size: s.size, sha256: s.sha256, revision: s.revision };
  }
  private async verify(s: Selection) {
    const info = await fs.lstat(s.filePath);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== s.size ||
        info.dev !== s.dev || info.ino !== s.ino ||
        info.mtimeMs !== s.mtimeMs || info.ctimeMs !== s.ctimeMs)
      throw Error("Owner-selected V2 source changed. Re-select the file.");
  }
  async select(filePath: string) {
    if (typeof filePath !== "string" || !filePath.trim())
      throw Error("The local owner must select a regular file path.");
    const currentRevision = ++this.revision;
    this.active = null;
    this.selected = null;
    this.generation++;
    this.receipt = null;
    const selectedPath = path.resolve(filePath);
    const name = safeLanFilename(path.basename(selectedPath));
    if (name.endsWith(".safolder")) throw Error("V2 folder archives require the separately validated folder format.");
    const info = await fs.lstat(selectedPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 4 * 1024 * 1024 ||
        info.size > LAN_V2_MAX_BYTES)
      throw Error("Select a regular large file above 4 MiB and at most 256 MiB.");
    const handle = await fs.open(selectedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let sha256: string;
    try {
      const identity = await handle.stat();
      if (!identity.isFile() || identity.dev !== info.dev || identity.ino !== info.ino ||
          identity.size !== info.size || identity.mtimeMs !== info.mtimeMs ||
          identity.ctimeMs !== info.ctimeMs) throw Error("Selected source changed before hashing.");
      const sha = crypto.createHash("sha256");
      for await (const chunk of createReadStream("", { fd: handle.fd, autoClose: false, start: 0 })) {
        if (currentRevision !== this.revision) throw Error("Owner changed the selected source.");
        sha.update(chunk);
      }
      sha256 = sha.digest("hex");
    } finally { await handle.close(); }
    if (currentRevision !== this.revision) throw Error("Owner changed selected source.");
    const selection: Selection = { filePath: selectedPath, name, size: info.size,
      sha256, dev: info.dev, ino: info.ino,
      mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, revision: currentRevision };
    await this.verify(selection);
    this.selected = selection;
    return { name, size: info.size, sha256 };
  }
  /** Called only after a per-file physical approval for this exact source. */
  async offer(approvedRevision: number) {
    const s = this.selected;
    if (!s || s.revision !== approvedRevision)
      throw Error("Source changed while owner approval was pending.");
    if (this.active && Date.now() - this.active.lastUsed <= 600_000)
      throw Error("Another V2 source transfer is active.");
    await this.verify(s);
    this.active = { ...s, id: crypto.randomUUID(), seq: 0,
      lastUsed: Date.now(), generation: this.generation };
    this.receipt = null;
    return { ok: true, version: 2, direction: "download" as const,
      transferId: this.active.id, name: s.name, size: s.size,
      sha256: s.sha256, chunkBytes: LAN_V2_CHUNK_BYTES, seq: 0,
      received: 0, resumed: false };
  }
  private getActive(id: unknown) {
    const t = this.active;
    if (typeof id !== "string" || !t || id !== t.id || t.generation !== this.generation)
      throw Error("Unknown or revoked V2 outbound transfer.");
    if (Date.now() - t.lastUsed > 600_000) {
      this.active = null;
      throw Error("V2 source transfer expired.");
    }
    return t;
  }
  status(id: unknown) {
    if (this.receipt && id === this.receipt.transferId && Date.now() - this.receiptAt < 600_000)
      return { ...this.receipt, completed: true };
    const t = this.getActive(id);
    return { ok: true, version: 2, transferId: t.id, direction: "download" as const,
      name: t.name, size: t.size, sha256: t.sha256,
      seq: t.seq, received: Math.min(t.size, t.seq * LAN_V2_CHUNK_BYTES),
      completed: false };
  }
  async get(id: unknown, seq: unknown) {
    const t = this.getActive(id);
    if (!Number.isSafeInteger(seq) || (seq !== t.seq && seq !== t.seq - 1))
      throw Error("Out-of-order V2 source chunk.");
    const offset = (seq as number) * LAN_V2_CHUNK_BYTES;
    if (offset < 0 || offset >= t.size) throw Error("No further V2 source bytes.");
    await this.verify(t);
    const handle = await fs.open(t.filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    let buffer: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.dev !== t.dev || info.ino !== t.ino ||
          info.size !== t.size || info.mtimeMs !== t.mtimeMs || info.ctimeMs !== t.ctimeMs)
        throw Error("Owner-selected source changed.");
      const len = Math.min(LAN_V2_CHUNK_BYTES, t.size - offset);
      buffer = Buffer.allocUnsafe(len);
      let bytes = 0;
      while (bytes < len) {
        const result = await handle.read(buffer, bytes, len - bytes, offset + bytes);
        if (result.bytesRead < 1) throw Error("Unexpected V2 source EOF.");
        bytes += result.bytesRead;
      }
    } finally { await handle.close(); }
    if (this.active !== t || this.generation !== t.generation)
      throw Error("V2 source revoked during read.");
    if (seq === t.seq) t.seq++;
    t.lastUsed = Date.now();
    return { ok: true, seq, received: offset + buffer.length, data: buffer.toString("base64") };
  }
  async finish(id: unknown) {
    if (this.receipt && id === this.receipt.transferId && Date.now() - this.receiptAt < 600_000)
      return this.receipt;
    const t = this.getActive(id);
    if (t.seq * LAN_V2_CHUNK_BYTES < t.size) throw Error("V2 source incomplete.");
    await this.verify(t);
    const epoch = this.generation;
    const sha = crypto.createHash("sha256");
    for await (const chunk of createReadStream(t.filePath)) sha.update(chunk);
    if (sha.digest("hex") !== t.sha256 || epoch !== this.generation || this.active !== t)
      throw Error("V2 source SHA-256 changed while sharing.");
    this.active = null;
    this.receipt = { ok: true, transferId: t.id, name: t.name, bytes: t.size };
    this.receiptAt = Date.now();
    return this.receipt;
  }
  abort(id: unknown) {
    if (this.active && id === this.active.id) {
      this.generation++;
      this.active = null;
    }
    return { ok: true };
  }
  clear() {
    this.generation++;
    this.revision++;
    this.active = null;
    this.selected = null;
    this.receipt = null;
  }
}
