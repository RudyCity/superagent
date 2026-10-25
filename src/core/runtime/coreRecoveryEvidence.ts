/**
 * Offline forensic recovery snapshot. Keeps all original state untouched.
 *
 * Secrets in checkpoint/discovery are copied ONLY into a private local folder;
 * do not publish, attach or emit those files in CLI output.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { getGlobalConfigDir, getRootConfigDir } from "../config/paths.js";
import { auditCoreColdStart, type CoreColdAuditResult } from "./coreColdStartAudit.js";

const require = createRequire(import.meta.url);
const { Database } = require("bun:sqlite") as {
  Database: new (file: string, options?: { readonly?: boolean }) => {
    exec(query: string): void; query(query: string): { get(): unknown }; close(): void;
  };
};
const SHA = (value: Buffer) => crypto.createHash("sha256").update(value).digest("hex");
function shaFile(file: string): string {
  const h = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const part = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n = 0;
    while ((n = fs.readSync(fd, part, 0, part.length, null)) > 0) {
      h.update(part.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return h.digest("hex");
}
const MAX_METADATA_FILE = 6 * 1024 * 1024;
const MAX_RECEIPTS = 20_000;

export interface RecoveryEvidenceEntry {
  name: string; bytes: number; sha256: string;
}
export interface CoreRecoveryEvidenceResult {
  version: 1;
  port: number;
  folder: string;
  assessment: CoreColdAuditResult["assessment"];
  files: RecoveryEvidenceEntry[];
  database: { present: boolean; sha256?: string; bytes?: number; integrity: "ok" | "absent" };
  originalsModified: false;
  restartAuthorized: false;
  toolReplayAuthorized: false;
  storedCredentialsAreSensitive: true;
}
function safeDirectory(folder: string, mayCreate = false) {
  if (mayCreate) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Unsafe evidence directory");
  }
}
function safeMetadataFile(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA_FILE || stat.size < 1) {
    throw new Error("Unsafe evidence source file");
  }
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const data = fs.readFileSync(handle);
    if (data.length !== stat.size || data.length > MAX_METADATA_FILE ||
        fs.fstatSync(handle).size !== stat.size) throw new Error("Evidence source changed while reading");
    return data;
  } finally { fs.closeSync(handle); }
}
function metadataSources(port: number): Array<{ name: string; path: string }> {
  const home = getRootConfigDir();
  const out = [
    { name: "core-checkpoint.json", path: path.join(home, "core-checkpoint-" + port + ".json") },
    { name: "core-supervisor.json", path: path.join(home, "core-supervisor-" + port + ".json") },
    { name: "core-guardian.json", path: path.join(home, "core-guardian-" + port + ".json") },
  ];
  const receiptsRoot = path.join(home, "core-session-receipts");
  if (fs.existsSync(receiptsRoot)) {
    safeDirectory(receiptsRoot);
    let count = 0;
    for (const bucket of fs.readdirSync(receiptsRoot, { withFileTypes: true })) {
      if (!bucket.isDirectory() || !/^[a-f0-9]{2}$/.test(bucket.name)) {
        throw new Error("Unexpected receipt bucket");
      }
      const bucketPath = path.join(receiptsRoot, bucket.name);
      safeDirectory(bucketPath);
      for (const item of fs.readdirSync(bucketPath, { withFileTypes: true })) {
        if (!item.isFile() || !/^[a-f0-9]{64}\.json$/.test(item.name) || ++count > MAX_RECEIPTS) {
          throw new Error("Unexpected or excessive receipt files");
        }
        out.push({
          name: "receipts/" + bucket.name + "/" + item.name,
          path: path.join(bucketPath, item.name),
        });
      }
    }
  }
  return out;
}
function copyPrivateFile(folder: string, name: string, data: Buffer): RecoveryEvidenceEntry {
  const dest = path.join(folder, ...name.split("/"));
  safeDirectory(path.dirname(dest), true);
  fs.writeFileSync(dest, data, { flag: "wx", mode: 0o600 });
  const reloaded = safeMetadataFile(dest);
  if (SHA(reloaded) !== SHA(data)) throw new Error("Recovery evidence verification failed");
  return { name, bytes: data.length, sha256: SHA(data) };
}
function dbSnapshot(databasePath: string, outputFolder: string): CoreRecoveryEvidenceResult["database"] {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(databasePath); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { present: false, integrity: "absent" };
    throw e;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Unsafe SQLite database");
  const target = path.join(outputFolder, "history.db");
  const db = new Database(databasePath, { readonly: true });
  try {
    // VACUUM INTO is a consistent SQLite snapshot even when the source is in
    // WAL mode. It NEVER changes the user's source db.
    db.exec("VACUUM INTO '" + target.replace(/'/g, "''") + "'");
  } finally { db.close(); }
  const snapshot = new Database(target, { readonly: true });
  try {
    const verdict = snapshot.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (verdict?.integrity_check !== "ok") throw new Error("SQLite snapshot integrity failed");
  } finally { snapshot.close(); }
  const statAfter = fs.lstatSync(target);
  if (!statAfter.isFile() || statAfter.isSymbolicLink()) throw new Error("Unsafe SQLite snapshot");
  try { fs.chmodSync(target, 0o600); } catch {}
  return { present: true, integrity: "ok", sha256: shaFile(target), bytes: statAfter.size };
}
export async function createCoreRecoveryEvidence(port: number): Promise<CoreRecoveryEvidenceResult> {
  const before = await auditCoreColdStart(port);
  if (before.snapshot.ownerOnline || before.snapshot.foreignListenerDetected) {
    throw new Error("Live or unknown Core listener: offline forensic snapshot refused");
  }
  if (before.snapshot.ambiguousTurns === null || before.snapshot.persistedReceipts === null) {
    throw new Error("Unverifiable SQLite/receipts; snapshot refused");
  }
  const home = getRootConfigDir();
  safeDirectory(home);
  const evidenceRoot = path.join(home, "recovery-evidence");
  safeDirectory(evidenceRoot, true);
  const folder = fs.mkdtempSync(path.join(evidenceRoot,
    "core-" + port + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex") + "-"));
  safeDirectory(folder);
  try {
    const entries: RecoveryEvidenceEntry[] = [];
    const sources = metadataSources(port);
    for (const src of sources) {
      if (!fs.existsSync(src.path)) continue;
      entries.push(copyPrivateFile(folder, src.name, safeMetadataFile(src.path)));
    }
    const database = dbSnapshot(path.join(getGlobalConfigDir(), "history.db"), folder);
    // Detect accidental source changes or an owner becoming online during copy.
    const after = await auditCoreColdStart(port);
    if (after.snapshot.ownerOnline || after.snapshot.foreignListenerDetected ||
        JSON.stringify(after.snapshot) !== JSON.stringify(before.snapshot)) {
      throw new Error("Recovery evidence source state changed during snapshot");
    }
    for (const src of sources) {
      const archived = entries.find(entry => entry.name === src.name);
      if (archived) {
        if (!fs.existsSync(src.path) || SHA(safeMetadataFile(src.path)) !== archived.sha256) {
          throw new Error("Recovery evidence source changed during snapshot");
        }
      } else if (fs.existsSync(src.path)) {
        throw new Error("New evidence source appeared during snapshot");
      }
    }
    const manifest: CoreRecoveryEvidenceResult = {
      version: 1, port, folder, assessment: before.assessment, files: entries,
      database, originalsModified: false, restartAuthorized: false,
      toolReplayAuthorized: false, storedCredentialsAreSensitive: true,
    };
    fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify(manifest, null, 2),
      { flag: "wx", mode: 0o600 });
    return manifest;
  } catch (error) {
    // Partial evidence must not be mistaken for a complete verified backup.
    fs.rmSync(folder, { recursive: true, force: true });
    throw error;
  }
}
