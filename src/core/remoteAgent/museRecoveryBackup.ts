/**
 * Phase 4k — offline per-port Muse recovery backup and guarded empty-target restore.
 * Self-contained, bounded and content-verified. No credentials printed.
 *
 * SHA-256 manifest checks accidental/tampered-by-third-party bytes, NOT
 * malicious replacement of the entire bundle. Backups contain private AES/HMAC
 * keys: keep them private, offline, and protected against rollback.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MuseBatchJournal, museJournalFile } from "./museBatchJournal.js";
import { MuseResultOutbox } from "./museResultOutbox.js";
import { MuseExecutionCheckpoint } from "./museExecutionCheckpoint.js";
import { MuseRecoveryOrchestrator } from "./museRecoveryOrchestrator.js";
import { MuseRecoveryIntegrityEvents } from "./museRecoveryIntegrityEvents.js";

const NAME = "recovery-bundle.json";
const MAX_FILES = 520;
const MAX_BYTES = 32_000_000;
const sha256 = (bytes: Buffer) => crypto.createHash("sha256").update(bytes).digest("hex");
type Item = { name: string; bytes: number; sha256: string };
export type MuseRecoveryBundle = {
  version: 1;
  port: number;
  createdAt: number;
  files: Item[];
};
export type MuseRecoveryHealth = {
  port: number; active: number; archived: number; encryptedResults: number;
  encryptedIntents: number; integrityBlocked: number;
};
const goodPort = (port: number) => Number.isSafeInteger(port) && port > 0 && port <= 65535;
const safeItemName = (name: string, port: number) =>
  [
    "muse-batches-" + port + ".json",
    "muse-results-" + port + ".json",
    "muse-results-" + port + ".json.key",
    "muse-execution-" + port + ".json",
    "muse-execution-" + port + ".json.key",
    "muse-tombstones-" + port + ".key",
    "muse-integrity-" + port + ".jsonl",
  ].includes(name) ||
  new RegExp("^muse-tombstones-" + port + "/[a-f0-9]{32}\\.json$").test(name);

function fileBytes(root: string, name: string): Buffer {
  const file = path.join(root, ...name.split("/"));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) {
    throw new Error("Invalid recovery file");
  }
  if (name.includes("/")) {
    const folder = fs.lstatSync(path.dirname(file));
    if (!folder.isDirectory() || folder.isSymbolicLink()) throw new Error("Unsafe recovery archive folder");
  }
  return fs.readFileSync(file);
}
function rootOk(root: string): void {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe recovery root");
}
function collect(root: string, port: number): { health: MuseRecoveryHealth; names: string[] } {
  if (!goodPort(port)) throw new Error("Invalid recovery port");
  rootOk(root);
  const j = museJournalFile(port, root);
  if (!fs.existsSync(j)) throw new Error("No durable Muse journal; backup/restore validation refused");
  const journal = new MuseBatchJournal(port, root);
  // Alert history is part of the trusted per-port recovery evidence.
  new MuseRecoveryIntegrityEvents(port, root).read();
  const results = new MuseResultOutbox(port, root);
  const intents = new MuseExecutionCheckpoint(port, root);
  const integrityBlocked = new MuseRecoveryOrchestrator(journal, intents, results)
    .report().counts.integrity_blocked;
  if (integrityBlocked) throw new Error("Recovery contains inconsistent checkpoints; backup blocked");
  // Authentication/decryption validates the ENTIRE outbox, not only the index.
  for (const item of results.summaries()) {
    if (!results.get(item.batchId)) throw new Error("Unreadable encrypted Muse result");
  }
  const payload = JSON.parse(fs.readFileSync(j, "utf8")) as {
    archives?: Array<{ name: string }>;
  };
  const names = ["muse-batches-" + port + ".json"];
  const existing = [
    "muse-results-" + port + ".json",
    "muse-results-" + port + ".json.key",
    "muse-execution-" + port + ".json",
    "muse-execution-" + port + ".json.key",
    "muse-tombstones-" + port + ".key",
    "muse-integrity-" + port + ".jsonl",
  ];
  for (const name of existing) if (fs.existsSync(path.join(root, name))) names.push(name);
  for (const item of payload.archives || []) names.push("muse-tombstones-" + port + "/" + item.name);
  if (names.length > MAX_FILES || new Set(names).size !== names.length ||
      names.some(name => !safeItemName(name, port))) {
    throw new Error("Invalid recovery archive list");
  }
  for (const name of names) fileBytes(root, name);
  return {
    health: {
      port, active: journal.list().length, archived: journal.archivedCount(),
      encryptedResults: results.count(), encryptedIntents: intents.summaries().length,
      integrityBlocked,
    },
    names: names.sort(),
  };
}
const isInside = (target: string, root: string) => {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const requireAbsoluteExternal = (target: string, root: string) => {
  if (!path.isAbsolute(target) || isInside(target, root) || isInside(root, target)) {
    throw new Error("Backup destination must be absolute and outside live recovery storage");
  }
  const parent = path.dirname(path.resolve(target));
  rootOk(parent);
  if (fs.existsSync(target)) throw new Error("Backup destination already exists");
};
function writeExclusive(root: string, name: string, data: Buffer): void {
  const dest = path.join(root, ...name.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(dest, "wx", 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function readManifest(dir: string, port: number): MuseRecoveryBundle {
  rootOk(dir);
  const bytes = fileBytes(dir, NAME);
  if (bytes.length > 64_000) throw new Error("Oversized recovery manifest");
  const m = JSON.parse(bytes.toString("utf8")) as MuseRecoveryBundle;
  if (!m || m.version !== 1 || m.port !== port || !Number.isSafeInteger(m.createdAt) ||
      m.createdAt <= 0 || !Array.isArray(m.files) || m.files.length < 1 || m.files.length > MAX_FILES) {
    throw new Error("Invalid recovery bundle manifest");
  }
  const names = new Set<string>();
  for (const f of m.files) {
    if (!f || typeof f.name !== "string" || !safeItemName(f.name, port) ||
        names.has(f.name) || !Number.isSafeInteger(f.bytes) || f.bytes < 1 ||
        f.bytes > MAX_BYTES || typeof f.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/.test(f.sha256)) throw new Error("Invalid recovery manifest entry");
    names.add(f.name);
    const data = fileBytes(dir, f.name);
    if (data.length !== f.bytes || sha256(data) !== f.sha256) {
      throw new Error("Recovery backup content digest mismatch");
    }
  }
  return m;
}
export function verifyMuseRecoveryBackup(bundleDir: string, port: number): MuseRecoveryHealth {
  const m = readManifest(bundleDir, port);
  const state = collect(bundleDir, port);
  if (state.names.join("\0") !== [...m.files.map(f => f.name)].sort().join("\0")) {
    throw new Error("Recovery backup missing or extra required files");
  }
  return state.health;
}
export function inspectMuseRecoveryStorage(port: number, root = path.join(os.homedir(), ".superagent-r")): MuseRecoveryHealth {
  return collect(root, port).health;
}
export function makeMuseRecoveryBackup(port: number, destination: string,
  root = path.join(os.homedir(), ".superagent-r")): MuseRecoveryHealth {
  requireAbsoluteExternal(destination, root);
  const snapshot = collect(root, port);
  const files = snapshot.names.map(name => {
    const bytes = fileBytes(root, name);
    return { name, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const parent = path.dirname(path.resolve(destination));
  const stage = fs.mkdtempSync(path.join(parent, ".muse-recovery-stage-"));
  try {
    try { fs.chmodSync(stage, 0o700); } catch {}
    for (const entry of files) {
      const bytes = fileBytes(root, entry.name);
      if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
        throw new Error("Recovery snapshot changed during backup");
      }
      writeExclusive(stage, entry.name, bytes);
    }
    const manifest: MuseRecoveryBundle = { version: 1, port, createdAt: Date.now(), files };
    writeExclusive(stage, NAME, Buffer.from(JSON.stringify(manifest)));
    verifyMuseRecoveryBackup(stage, port);
    if (fs.existsSync(destination)) throw new Error("Backup destination became occupied");
    fs.renameSync(stage, destination);
    return snapshot.health;
  } catch (error) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch {}
    throw error;
  }
}
export function restoreMarker(port: number, root = path.join(os.homedir(), ".superagent-r")) {
  if (!goodPort(port)) throw new Error("Invalid recovery port");
  return path.join(root, "muse-restore-" + port + ".incomplete");
}
/** Restoration only into a fresh, EMPTY per-port recovery namespace.
 * Caller must hold the per-port offline owner review lock. Journal goes LAST.
 */
export function restoreMuseRecoveryBackup(port: number, source: string,
  root = path.join(os.homedir(), ".superagent-r")): MuseRecoveryHealth {
  if (isInside(source, root) || isInside(root, source)) {
    throw new Error("Restore backup must be outside the live recovery root");
  }
  const verified = verifyMuseRecoveryBackup(source, port);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  rootOk(root);
  const m = readManifest(source, port);
  const marker = restoreMarker(port, root);
  if (fs.existsSync(marker)) throw new Error("Incomplete prior recovery requires manual inspection");
  const candidates = [
    "muse-batches-" + port + ".json",
    "muse-results-" + port + ".json",
    "muse-results-" + port + ".json.key",
    "muse-execution-" + port + ".json",
    "muse-execution-" + port + ".json.key",
    "muse-tombstones-" + port + ".key",
    "muse-integrity-" + port + ".jsonl",
  ];
  if (candidates.some(name => fs.existsSync(path.join(root, name))) ||
      fs.existsSync(path.join(root, "muse-tombstones-" + port))) {
    throw new Error("Recovery destination already contains per-port history; refusing overwrite/rollback");
  }
  // Fail closed if process dies mid-copy. Journal loader checks this marker.
  writeExclusive(root, path.basename(marker), Buffer.from(JSON.stringify({
    port, createdAt: Date.now(), kind: "incomplete_restore",
  })));
  try {
    const sorted = [...m.files].sort((a, b) =>
      (a.name === "muse-batches-" + port + ".json" ? 1 : 0) -
      (b.name === "muse-batches-" + port + ".json" ? 1 : 0));
    for (const item of sorted) {
      const bytes = fileBytes(source, item.name);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) {
        throw new Error("Backup changed during restoration");
      }
      writeExclusive(root, item.name, bytes);
    }
    // Check all output bytes while protection is still active.
    for (const item of m.files) {
      const bytes = fileBytes(root, item.name);
      if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) {
        throw new Error("Restored recovery file digest mismatch");
      }
    }
    fs.rmSync(marker);
    try { return inspectMuseRecoveryStorage(port, root); }
    catch (error) {
      writeExclusive(root, path.basename(marker), Buffer.from("post-restore-validation-failed"));
      throw error;
    }
  } catch (error) {
    // Deliberately leave the marker and partial files to block startup.
    throw error;
  }
}
