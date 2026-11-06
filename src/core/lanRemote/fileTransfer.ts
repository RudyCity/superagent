import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { packFolder, inspectFolderPackage, unpackFolderPackage, validateFolderRelativePath } from "./folderPackage.js";
/** Bounded in-memory target file transfer. Outbound must be selected locally. */
export const LAN_FILE_MAX_BYTES = 4 * 1024 * 1024;
export const LAN_FILE_CHUNK_BYTES = 4096;
export type FileDirection = "upload" | "download";
export function safeLanFilename(name: unknown): string {
  if (typeof name !== "string" || !name || name.length > 96 ||
    name === "." || name === ".." || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(name) ||
    name.startsWith(".") || name.endsWith(".") || name.endsWith(" ") ||
    !/^[A-Za-z0-9_][A-Za-z0-9_ .()-]{0,95}$/.test(name)) throw Error("Unsafe LAN filename.");
  return name;
}
export function decodeLanChunk(data: unknown): Buffer {
  if (typeof data !== "string" || !data || data.length > 5464 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw Error("Invalid file chunk encoding.");
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > LAN_FILE_CHUNK_BYTES || bytes.toString("base64") !== data)
    throw Error("Invalid file chunk length or padding.");
  return bytes;
}
export const sha256File = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
interface Transfer {
  id: string; direction: FileDirection; name: string; size: number; sha256: string;
  chunks: Buffer[]; received: number; sequence: number; updated: number; outbound?: Buffer;
}
export class LanTargetFiles {
  constructor(private readonly outputDirectory = path.join(os.homedir(), "Downloads", "SuperAgent LAN")) {}
  private active: Transfer | null = null;
  private shared: { name: string; bytes: Buffer } | null = null;
  clear() { this.active = null; this.shared = null; }
  abort(id: unknown) { if (this.active && this.active.id === id) this.active = null; }
  async shareSelectedFile(filePath: string): Promise<{ name: string; size: number }> {
    const resolved = path.resolve(filePath);
    const info = await fs.lstat(resolved);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LAN_FILE_MAX_BYTES || info.size < 1)
      throw Error("Share only a regular file between 1 byte and 4 MiB.");
    const name = safeLanFilename(path.basename(resolved));
    const bytes = await fs.readFile(resolved);
    if (bytes.length !== info.size) throw Error("File changed while being selected.");
    this.shared = { name, bytes };
    return { name, size: bytes.length };
  }
  async shareSelectedFolder(folderPath: string): Promise<{ name: string; size: number; files: number }> {
    const folder = path.resolve(folderPath);
    const basename = path.basename(folder);
    validateFolderRelativePath(basename); // hidden/secret roots must never be exported
    const name = safeLanFilename(basename + ".safolder");
    const bytes = await packFolder(folder);
    if (bytes.length < 1 || bytes.length > LAN_FILE_MAX_BYTES) throw Error("Folder package too large.");
    const manifest = inspectFolderPackage(bytes);
    this.shared = { name, bytes };
    return { name, size: bytes.length, files: manifest.files.length };
  }
  getShared() {
    if (!this.shared) return null;
    return { name: this.shared.name, size: this.shared.bytes.length, sha256: sha256File(this.shared.bytes) };
  }
  offer(direction: FileDirection, meta?: { name: string; size: number; sha256: string }) {
    if (this.active && Date.now() - this.active.updated <= 600_000) throw Error("Another transfer is active.");
    this.active = null;
    const outbound = direction === "download" ? this.shared?.bytes : undefined;
    if (direction === "download" && !this.shared) throw Error("Target owner must select a file to share.");
    const chosen = direction === "download" ? {
      name: this.shared!.name, size: outbound!.length, sha256: sha256File(outbound!)
    } : meta;
    if (!chosen || !Number.isInteger(chosen.size) || chosen.size < 1 ||
      chosen.size > LAN_FILE_MAX_BYTES || !/^[a-f0-9]{64}$/.test(chosen.sha256))
      throw Error("Invalid file metadata.");
    const name = safeLanFilename(chosen.name);
    const id = crypto.randomUUID();
    this.active = { id, direction, name, size: chosen.size, sha256: chosen.sha256, chunks: [],
      received: 0, sequence: 0, updated: Date.now(), outbound };
    return { transferId: id, direction, name, size: chosen.size, sha256: chosen.sha256, chunkBytes: LAN_FILE_CHUNK_BYTES };
  }
  private transfer(id: unknown): Transfer {
    const t = this.active;
    if (!t || typeof id !== "string" || t.id !== id) throw Error("Unknown transfer.");
    if (Date.now() - t.updated > 600_000) { this.active = null; throw Error("Transfer expired."); }
    return t;
  }
  put(id: unknown, seq: unknown, data: unknown) {
    const t = this.transfer(id);
    if (t.direction !== "upload" || !Number.isInteger(seq) || seq !== t.sequence) throw Error("Out-of-order chunk.");
    const part = decodeLanChunk(data);
    if (t.received + part.length > t.size) throw Error("Upload exceeds declared length.");
    t.chunks.push(part);
    t.received += part.length; t.sequence++; t.updated = Date.now();
    return { ok: true, seq: t.sequence, received: t.received };
  }
  get(id: unknown, seq: unknown) {
    const t = this.transfer(id);
    if (t.direction !== "download" || !t.outbound || !Number.isInteger(seq) || seq !== t.sequence)
      throw Error("Out-of-order chunk.");
    const offset = seq * LAN_FILE_CHUNK_BYTES;
    if (offset >= t.size) throw Error("No further bytes.");
    const part = t.outbound.subarray(offset, Math.min(offset + LAN_FILE_CHUNK_BYTES, t.size));
    t.sequence++; t.updated = Date.now();
    return { ok: true, seq, data: part.toString("base64"), received: offset + part.length };
  }
  async finish(id: unknown) {
    const t = this.transfer(id);
    if (t.direction === "download") {
      if (t.sequence * LAN_FILE_CHUNK_BYTES < t.size) throw Error("Download incomplete.");
      this.active = null; return { ok: true, name: t.name, bytes: t.size };
    }
    if (t.received !== t.size) throw Error("Incomplete upload.");
    const bytes = Buffer.concat(t.chunks);
    if (sha256File(bytes) !== t.sha256) throw Error("SHA-256 mismatch.");
    const dir = this.outputDirectory;
    await fs.mkdir(dir, { recursive: true });
    if (this.active !== t) throw Error("Transfer revoked before save.");
    if (t.name.endsWith(".safolder")) {
      // A real folder requires a fully validated manifest and every per-file
      // digest to match BEFORE any final file becomes visible.
      const validated = inspectFolderPackage(bytes);
      const unpacked = await unpackFolderPackage(bytes, dir);
      if (this.active !== t) {
        await fs.rm(unpacked.directory, { recursive: true, force: true }).catch(() => {});
        throw Error("Transfer revoked during folder import.");
      }
      this.active = null;
      return { ok: true, name: t.name, bytes: t.size, savedTo: unpacked.directory, files: validated.files.length };
    }
    const destination = path.join(dir, crypto.randomUUID().slice(0, 8) + "-" + t.name);
    await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    if (this.active !== t) { await fs.unlink(destination).catch(() => {}); throw Error("Transfer revoked during save."); }
    this.active = null;
    return { ok: true, name: t.name, bytes: t.size, savedTo: destination };
  }
}
