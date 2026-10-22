/**
 * Resumable binary artifact transfer, scoped to an existing Brain session.
 * Persistent transfer metadata and chunks survive MCP reconnects and Bun restarts.
 * No file appears in artifacts/ until content hash and byte length are verified.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { inspectBrainSession } from "./brainWorkspace.js";
import { brainStorageUsage, validateDestination, assertNoSymlink } from "./brainStorageManager.js";
import { getRootConfigDir } from "../config/paths.js";
import { withBrainSessionLock } from "./brainSessionLock.js";

const CHUNK_LIMIT = 256 * 1024;
const TOTAL_LIMIT = 20 * 1024 * 1024;
const STORAGE_LIMIT = 50 * 1024 * 1024;
const TRANSFER_TTL = 24 * 60 * 60 * 1000;
const EXTENSIONS = new Set([".png",".jpg",".jpeg",".webp",".gif",".pdf",".zip",".mp4",".webm",".wav",".mp3",".csv",".json",".txt"]);
interface Transfer {
  version: 1;
  id: string;
  filename: string;
  totalBytes: number;
  receivedBytes: number;
  sha256: string;
  createdAt: number;
  updatedAt: number;
}
function fromBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !value || value.length > 350000 || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid bounded base64 chunk.");
  }
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > CHUNK_LIMIT || bytes.toString("base64") !== value) {
    throw new Error("Invalid canonical transfer chunk (256 KiB maximum).");
  }
  return bytes;
}
function current(owner: string, sessionId: string, configRoot = getRootConfigDir()) {
  const dir = inspectBrainSession(owner, sessionId, configRoot).path;
  const transferDir = path.join(dir, ".transfers");
  assertNoSymlink(dir, transferDir);
  return { dir, transferDir };
}
function paths(owner: string, sessionId: string, transferId: string, configRoot?: string) {
  if (!/^btx_[a-f0-9]{32}$/.test(transferId)) throw new Error("Invalid transfer ID.");
  const session = current(owner, sessionId, configRoot);
  const metaPath = path.join(session.transferDir, transferId + ".json");
  const tempPath = path.join(session.transferDir, transferId + ".part");
  assertNoSymlink(session.dir, metaPath);
  assertNoSymlink(session.dir, tempPath);
  return { ...session, metaPath, tempPath };
}
function load(owner: string, sessionId: string, transferId: string, configRoot?: string) {
  const p = paths(owner, sessionId, transferId, configRoot);
  const data = JSON.parse(fs.readFileSync(p.metaPath, "utf8")) as Transfer;
  if (data.version !== 1 || data.id !== transferId || !Number.isSafeInteger(data.receivedBytes) ||
    data.receivedBytes < 0 || data.receivedBytes > data.totalBytes ||
    data.totalBytes < 1 || data.totalBytes > TOTAL_LIMIT || Date.now() - data.updatedAt > TRANSFER_TTL) {
    throw new Error("Transfer metadata invalid or expired.");
  }
  const stat = fs.lstatSync(p.tempPath);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe transfer staging file.");
  if (stat.size < data.receivedBytes) throw new Error("Transfer staging is shorter than committed metadata.");
  // Crash after the chunk fsync but before metadata commit: replay from committed offset.
  if (stat.size > data.receivedBytes) fs.truncateSync(p.tempPath, data.receivedBytes);
  return { ...p, data };
}
function writeMeta(metaPath: string, data: Transfer) {
  const tmp = metaPath + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data), { flag: "wx", mode: 0o600 });
  try { fs.renameSync(tmp, metaPath); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
/** Reclaim expired partial uploads while holding the session-wide writer lock. */
function pruneExpiredTransfers(dir: string, transferDir: string) {
  if (!fs.existsSync(transferDir)) return { removed: 0, reclaimedBytes: 0 };
  let removed = 0, reclaimedBytes = 0;
  for (const file of fs.readdirSync(transferDir)) {
    if (!/^btx_[a-f0-9]{32}\.json$/.test(file)) continue;
    const metaPath = path.join(transferDir, file);
    assertNoSymlink(dir, metaPath);
    const stat = fs.lstatSync(metaPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048) throw new Error("Unsafe transfer metadata.");
    const data = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Transfer;
    if (data.id + ".json" !== file || !Number.isFinite(data.updatedAt)) throw new Error("Corrupt transfer metadata.");
    if (Date.now() - data.updatedAt <= TRANSFER_TTL) continue;
    const part = path.join(transferDir, data.id + ".part");
    assertNoSymlink(dir, part);
    if (fs.existsSync(part)) {
      const partStat = fs.lstatSync(part);
      if (!partStat.isFile() || partStat.nlink !== 1) throw new Error("Unsafe expired upload.");
      reclaimedBytes += partStat.size;
      fs.unlinkSync(part);
    }
    fs.unlinkSync(metaPath);
    removed++;
  }
  // A crash between creating the staging file and its manifest can leave
  // an orphan .part. Only remove it after the full retention window.
  for (const file of fs.readdirSync(transferDir)) {
    if (!/^btx_[a-f0-9]{32}\.part$/.test(file)) continue;
    const full = path.join(transferDir, file);
    const meta = path.join(transferDir, file.replace(/\.part$/, ".json"));
    assertNoSymlink(dir, full);
    if (fs.existsSync(meta)) continue;
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe orphan transfer.");
    if (Date.now() - stat.mtimeMs > TRANSFER_TTL) {
      reclaimedBytes += stat.size;
      fs.unlinkSync(full);
      removed++;
    }
  }
  for (const file of fs.readdirSync(transferDir)) {
    if (!/^btx_[a-f0-9]{32}\.json\.[a-f0-9]{16}\.tmp$/.test(file)) continue;
    const full = path.join(transferDir, file);
    assertNoSymlink(dir, full);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Unsafe metadata temporary file.");
    if (Date.now() - stat.mtimeMs > 5000) fs.unlinkSync(full);
  }
  return { removed, reclaimedBytes };
}
export function cleanupBrainTransfers(owner: string, sessionId: string, configRoot?: string) {
  const { dir, transferDir } = current(owner, sessionId, configRoot);
  return withBrainSessionLock(dir, () => pruneExpiredTransfers(dir, transferDir));
}
export function beginBrainTransfer(owner: string, sessionId: string, filename: string, totalBytes: number, sha256: string, configRoot?: string) {
  const { dir, transferDir } = current(owner, sessionId, configRoot);
  if (typeof filename !== "string" || filename.includes("/") || filename.includes("\\") ||
    !EXTENSIONS.has(path.extname(filename).toLowerCase()) ||
    validateDestination("artifacts/" + filename) !== path.join("artifacts", filename)) {
    throw new Error("Unsupported artifact filename.");
  }
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > TOTAL_LIMIT ||
    !/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid transfer size or SHA256.");
  return withBrainSessionLock(dir, () => {
  fs.mkdirSync(transferDir, { recursive: true, mode: 0o700 });
  pruneExpiredTransfers(dir, transferDir);
  const target = path.join(dir, "artifacts", filename);
  assertNoSymlink(dir, target);
  if (fs.existsSync(target)) throw new Error("Artifact already exists.");
  const existing = fs.readdirSync(transferDir).filter(v => /^btx_[a-f0-9]{32}\.json$/.test(v));
  if (existing.length >= 10) throw new Error("Maximum 10 pending transfers per Brain session.");
  let reserved = 0;
  for (const name of existing) {
    const full = path.join(transferDir, name);
    assertNoSymlink(dir, full);
    const meta = JSON.parse(fs.readFileSync(full, "utf8")) as Transfer;
    if (meta.version !== 1 || !Number.isSafeInteger(meta.totalBytes) || meta.totalBytes < 0 ||
      meta.totalBytes > TOTAL_LIMIT) throw new Error("Corrupt transfer metadata; refusing upload.");
    if (meta.filename.toLowerCase() === filename.toLowerCase()) throw new Error("Artifact filename is reserved by a pending transfer.");
    reserved += meta.totalBytes;
  }
  if (brainStorageUsage(dir).totalBytes + reserved + totalBytes > STORAGE_LIMIT) {
    throw new Error("Brain session quota exceeded by pending transfers.");
  }
  const id = "btx_" + crypto.randomBytes(16).toString("hex");
  const p = paths(owner, sessionId, id, configRoot);
  const now = Date.now();
  const data: Transfer = { version: 1, id, filename, totalBytes, receivedBytes: 0, sha256, createdAt: now, updatedAt: now };
  fs.writeFileSync(p.tempPath, "", { flag: "wx", mode: 0o600 });
  try { fs.writeFileSync(p.metaPath, JSON.stringify(data), { flag: "wx", mode: 0o600 }); }
  catch (error) { fs.unlinkSync(p.tempPath); throw error; }
  return { transferId: id, offset: 0, chunkLimit: CHUNK_LIMIT, expiresInSeconds: TRANSFER_TTL / 1000 };
  });
}
export function inspectBrainTransfer(owner: string, sessionId: string, transferId: string, configRoot?: string) {
  const { dir } = current(owner, sessionId, configRoot);
  return withBrainSessionLock(dir, () => {
    const { data } = load(owner, sessionId, transferId, configRoot);
    return { transferId, filename: data.filename, offset: data.receivedBytes, totalBytes: data.totalBytes, sha256: data.sha256 };
  });
}
export function appendBrainTransfer(owner: string, sessionId: string, transferId: string, offset: number, base64: unknown, configRoot?: string) {
  const { dir } = current(owner, sessionId, configRoot);
  return withBrainSessionLock(dir, () => {
  const existing = load(owner, sessionId, transferId, configRoot);
  if (!Number.isSafeInteger(offset) || offset !== existing.data.receivedBytes) throw new Error("Transfer offset mismatch; inspect before retrying.");
  const bytes = fromBase64(base64);
  if (offset + bytes.length > existing.data.totalBytes) throw new Error("Chunk exceeds expected transfer size.");
  const fd = fs.openSync(existing.tempPath, "r+");
  try {
    const currentStat = fs.fstatSync(fd);
    if (!currentStat.isFile() || currentStat.nlink !== 1 || currentStat.size !== offset) throw new Error("Transfer mutated during append.");
    fs.writeSync(fd, bytes, 0, bytes.length, offset);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  existing.data.receivedBytes += bytes.length;
  existing.data.updatedAt = Date.now();
  writeMeta(existing.metaPath, existing.data);
  return { transferId, offset: existing.data.receivedBytes, complete: existing.data.receivedBytes === existing.data.totalBytes };
  });
}
export function finishBrainTransfer(owner: string, sessionId: string, transferId: string, configRoot?: string) {
  const { dir } = current(owner, sessionId, configRoot);
  return withBrainSessionLock(dir, () => {
    const p = load(owner, sessionId, transferId, configRoot);
    if (p.data.receivedBytes !== p.data.totalBytes) throw new Error("Transfer incomplete.");
    const bytes = fs.readFileSync(p.tempPath);
    if (bytes.length !== p.data.totalBytes) throw new Error("Transfer changed before finalization.");
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    if (digest !== p.data.sha256) throw new Error("Artifact SHA256 mismatch; transfer not promoted.");
    const activeReserved = fs.readdirSync(path.join(dir, ".transfers"))
      .filter(name => /^btx_[a-f0-9]{32}\.json$/.test(name) && name !== transferId + ".json")
      .reduce((sum, name) => {
        const value = JSON.parse(fs.readFileSync(path.join(dir, ".transfers", name), "utf8")) as Transfer;
        return sum + value.totalBytes;
      }, 0);
    if (brainStorageUsage(dir).totalBytes + activeReserved + p.data.totalBytes > STORAGE_LIMIT) {
      throw new Error("Brain quota exceeded before finalization.");
    }
    const target = path.join(p.dir, "artifacts", p.data.filename);
    assertNoSymlink(p.dir, target);
    const fd = fs.openSync(target, "wx", 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    catch (error) { fs.closeSync(fd); try { fs.unlinkSync(target); } catch {} throw error; }
    fs.closeSync(fd);
    fs.unlinkSync(p.metaPath);
    fs.unlinkSync(p.tempPath);
    return { success: true, sessionId, filePath: "artifacts/" + p.data.filename, bytes: p.data.totalBytes, sha256: digest };
  });
}
export function abortBrainTransfer(owner: string, sessionId: string, transferId: string, configRoot?: string) {
  const { dir } = current(owner, sessionId, configRoot);
  return withBrainSessionLock(dir, () => {
    const p = paths(owner, sessionId, transferId, configRoot);
    load(owner, sessionId, transferId, configRoot);
    fs.unlinkSync(p.metaPath);
    fs.unlinkSync(p.tempPath);
    return { aborted: true, transferId };
  });
}
