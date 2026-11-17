import crypto from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { decodeLanChunk, LAN_FILE_CHUNK_BYTES, safeLanFilename } from "./fileTransfer.js";

/** V2 is opt-in and does not change the bounded V1 wire contract. */
export const LAN_V2_MAX_BYTES = 256 * 1024 * 1024;
export const LAN_V2_CHUNK_BYTES = LAN_FILE_CHUNK_BYTES;
const EXPIRY_MS = 24 * 60 * 60_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type Metadata = {
  v: 2; id: string; name: string; size: number; sha256: string; created: number;
};
type Active = Metadata & { received: number; sequence: number; lastUsed: number };
type Receipt = { ok: true; transferId: string; bytes: number; name: string; savedTo: string };

function validMetadata(name: unknown, size: unknown, digest: unknown): asserts name is string {
  safeLanFilename(name);
  if (typeof name !== "string" || name.endsWith(".safolder") ||
      !Number.isSafeInteger(size) || (size as number) < 1 ||
      (size as number) > LAN_V2_MAX_BYTES ||
      typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
    throw Error("Invalid V2 upload metadata or unsupported folder archive.");
}

async function sha256OfFile(file: string): Promise<string> {
  const digest = crypto.createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

/** Disk-backed, checkpointed target-side upload. Only authenticated LAN
 * sessions may call it. The caller MUST require physical approval on offer,
 * including on each attempt to resume a partial file after re-pairing.
 */
export class LanDiskTargetV2 {
  private active: Active | null = null;
  private receipt: Receipt | null = null;
  private receiptAt = 0;
  private readonly stage: string;
  constructor(private readonly outputDirectory = path.join(os.homedir(), "Downloads", "SuperAgent LAN")) {
    this.stage = path.join(this.outputDirectory, ".superagent-v2-partials");
  }
  private part(id: string) { return path.join(this.stage, id + ".part"); }
  private meta(id: string) { return path.join(this.stage, id + ".json"); }
  private async ensureStage() {
    await fs.mkdir(this.outputDirectory, { recursive: true });
    await fs.mkdir(this.stage, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(this.stage);
    if (!st.isDirectory() || st.isSymbolicLink()) throw Error("Unsafe transfer staging directory.");
    if (process.platform !== "win32") await fs.chmod(this.stage, 0o700);
  }
  private async load(id: string): Promise<Active | null> {
    if (!UUID.test(id)) return null;
    try {
      const [raw, partInfo] = await Promise.all([
        fs.readFile(this.meta(id), "utf8"), fs.lstat(this.part(id)),
      ]);
      const value: Metadata = JSON.parse(raw);
      if (value.v !== 2 || value.id !== id || typeof value.created !== "number" ||
          !Number.isSafeInteger(value.created) || Date.now() - value.created > EXPIRY_MS ||
          value.created > Date.now() + 60_000 || !partInfo.isFile() || partInfo.isSymbolicLink())
        return null;
      validMetadata(value.name, value.size, value.sha256);
      const length = partInfo.size;
      if (length > value.size || length < 0 ||
          (length % LAN_V2_CHUNK_BYTES !== 0 && length !== value.size)) return null;
      return { ...value, received: length, sequence: Math.ceil(length / LAN_V2_CHUNK_BYTES),
        lastUsed: Date.now() };
    } catch { return null; }
  }
  /** Freshly authorized offer; safe resume selection is by full file identity.
   * Never accept a network-supplied staging filename or arbitrary offset.
   */
  async offerUpload(name: unknown, size: unknown, sha256: unknown) {
    validMetadata(name, size, sha256);
    if (this.active) throw Error("Another V2 transfer is active.");
    await this.ensureStage();
    const entries = (await fs.readdir(this.stage)).filter(entry => UUID.test(entry.replace(/\.json$/, "")) && entry.endsWith(".json"));
    if (entries.length > 512) throw Error("Transfer staging quota exceeded.");
    let resumed: Active | null = null;
    for (const entry of entries) {
      const id = entry.slice(0, -5);
      const existing = await this.load(id);
      if (existing && existing.name === name && existing.size === size && existing.sha256 === sha256) {
        resumed = existing;
        break;
      }
    }
    if (resumed) this.active = resumed;
    else {
      const id = crypto.randomUUID();
      const next: Metadata = { v: 2, id, name, size: size as number,
        sha256: sha256 as string, created: Date.now() };
      await fs.writeFile(this.part(id), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
      try {
        await fs.writeFile(this.meta(id), JSON.stringify(next), { flag: "wx", mode: 0o600 });
      } catch (error) {
        await fs.unlink(this.part(id)).catch(() => {});
        throw error;
      }
      this.active = { ...next, received: 0, sequence: 0, lastUsed: Date.now() };
    }
    const t = this.active;
    this.receipt = null;
    return { ok: true, version: 2, transferId: t.id, direction: "upload" as const,
      name: t.name, size: t.size, sha256: t.sha256,
      chunkBytes: LAN_V2_CHUNK_BYTES, seq: t.sequence, received: t.received,
      resumed: t.received > 0 };
  }
  private transfer(id: unknown): Active {
    const t = this.active;
    if (typeof id !== "string" || !t || t.id !== id) throw Error("Unknown V2 transfer.");
    if (Date.now() - t.lastUsed > 600_000) {
      this.active = null;
      throw Error("V2 transfer expired; re-authorize to resume.");
    }
    return t;
  }
  status(id: unknown) {
    if (this.receipt && id === this.receipt.transferId &&
        Date.now() - this.receiptAt < 600_000)
      return { ...this.receipt, completed: true };
    const t = this.transfer(id);
    return { ok: true, version: 2, transferId: t.id, direction: "upload",
      name: t.name, size: t.size, sha256: t.sha256,
      received: t.received, seq: t.sequence, completed: false };
  }
  async put(id: unknown, seq: unknown, encoded: unknown) {
    const t = this.transfer(id);
    if (!Number.isSafeInteger(seq) || seq !== t.sequence) throw Error("Out-of-order V2 chunk.");
    const bytes = decodeLanChunk(encoded);
    if (t.received + bytes.length > t.size ||
        (bytes.length !== LAN_V2_CHUNK_BYTES && t.received + bytes.length !== t.size))
      throw Error("V2 chunk must be full unless final.");
    const info = await fs.lstat(this.part(t.id));
    if (!info.isFile() || info.isSymbolicLink() || info.size !== t.received)
      throw Error("Staged file changed unexpectedly.");
    const handle = await fs.open(this.part(t.id), fsConstants.O_RDWR | fsConstants.O_NOFOLLOW);
    try {
      let written = 0;
      while (written < bytes.length) {
        const result = await handle.write(bytes, written, bytes.length - written, t.received + written);
        if (result.bytesWritten <= 0) throw Error("Staging write failed.");
        written += result.bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
    t.received += bytes.length;
    t.sequence++;
    t.lastUsed = Date.now();
    return { ok: true, seq: t.sequence, received: t.received };
  }
  async finish(id: unknown): Promise<Receipt> {
    if (this.receipt && id === this.receipt.transferId && Date.now() - this.receiptAt < 600_000)
      return this.receipt;
    const t = this.transfer(id);
    if (t.received !== t.size) throw Error("Incomplete V2 transfer.");
    const info = await fs.lstat(this.part(t.id));
    if (!info.isFile() || info.isSymbolicLink() || info.size !== t.size ||
        await sha256OfFile(this.part(t.id)) !== t.sha256)
      throw Error("V2 SHA-256 mismatch or source changed.");
    const destination = path.join(this.outputDirectory, crypto.randomUUID().slice(0, 8) + "-" + t.name);
    // Hardlink is atomic, create-only and same-volume, and never exposes an
    // unverified file in the user-visible destination.
    await fs.link(this.part(t.id), destination);
    if (this.active !== t) {
      await fs.unlink(destination).catch(() => {});
      throw Error("Transfer revoked during final commit.");
    }
    this.active = null;
    await fs.unlink(this.part(t.id));
    await fs.unlink(this.meta(t.id));
    this.receipt = { ok: true, transferId: t.id, bytes: t.size,
      name: t.name, savedTo: destination };
    this.receiptAt = Date.now();
    return this.receipt;
  }
  /** Explicit abort removes partial bytes. Disconnect retains them only for a
   * new physically approved matching offer. Owner revoke invokes purge().
   */
  async abort(id: unknown) {
    if (typeof id !== "string" || !UUID.test(id)) throw Error("Invalid V2 transfer ID.");
    if (this.active?.id !== id) return { ok: true };
    this.active = null;
    await Promise.all([
      fs.unlink(this.part(id)).catch(() => {}),
      fs.unlink(this.meta(id)).catch(() => {}),
    ]);
    return { ok: true };
  }
  suspend() { this.active = null; this.receipt = null; }
  async purge() {
    this.suspend();
    try {
      const entries = await fs.readdir(this.stage);
      for (const entry of entries) {
        if (/^[a-f0-9-]{36}\.(?:part|json)$/i.test(entry) &&
            UUID.test(entry.slice(0, -5).replace(/\.part$/, "")))
          await fs.unlink(path.join(this.stage, entry)).catch(() => {});
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
