/**
 * Read-only owner evidence for cold Core boot. NO removal, writes, adoption,
 * auto tool replay or process signals. Counts unresolved turns using a
 * separate SQLite read-only handle so diagnostics cannot mutate runtime DB.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { getGlobalConfigDir, getRootConfigDir } from "../config/paths.js";
import { coreCheckpointPath, readCoreCheckpoint } from "./coreSupervisorCheckpoint.js";
import { coreGuardianFile, readCoreGuardianLease } from "./coreGuardian.js";
import { requestCoreSupervisor } from "./coreSupervisor.js";
import { assessCoreColdStart, type CoreColdAssessment, type CoreColdSnapshot } from "./coreColdStartPolicy.js";
const require = createRequire(import.meta.url);
function readUnresolvedTurns(): number | null {
  const dbPath = path.join(getGlobalConfigDir(), "history.db");
  try { if (!fs.existsSync(dbPath)) return 0; }
  catch { return null; }
  try {
    const stat = fs.lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    // The OS local owner may inspect DB only. No table creation, migrations or
    // pragmas which modify shared data.
    let db: any;
    try { const { Database } = require("bun:sqlite"); db = new Database(dbPath, { readonly: true }); }
    catch {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(dbPath, { readOnly: true });
    }
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get();
      if (!table) return 0;
      const row = db.prepare("SELECT COUNT(*) AS count FROM chat_turns WHERE state NOT IN ('completed','failed','cancelled')").get() as { count: number };
      return Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : null;
    } finally { db.close(); }
  } catch { return null; }
}
type ReceiptAudit = {
  count: number | null;
  withAcceptedTurn: number | null;
  reconciled: boolean;
};
function auditSessionReceipts(): ReceiptAudit {
  const dir = path.join(getRootConfigDir(), "core-session-receipts");
  try {
    if (!fs.existsSync(dir)) return { count: 0, withAcceptedTurn: 0, reconciled: true };
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return { count: null, withAcceptedTurn: null, reconciled: false };
    let count = 0;
    let withAcceptedTurn = 0;
    for (const bucket of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!bucket.isDirectory() || !/^[a-f0-9]{2}$/.test(bucket.name))
        return { count: null, withAcceptedTurn: null, reconciled: false };
      const bucketPath = path.join(dir, bucket.name);
      const bucketStat = fs.lstatSync(bucketPath);
      if (!bucketStat.isDirectory() || bucketStat.isSymbolicLink())
        return { count: null, withAcceptedTurn: null, reconciled: false };
      for (const entry of fs.readdirSync(bucketPath, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name) || ++count > 20_000)
          return { count: null, withAcceptedTurn: null, reconciled: false };
        const file = path.join(bucketPath, entry.name);
        const fileStat = fs.lstatSync(file);
        if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size < 2 || fileStat.size > 8192)
          return { count: null, withAcceptedTurn: null, reconciled: false };
        const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
          version?: number; sessionId?: string; lastAcceptedTurnId?: string;
        };
        if (value.version !== 1 || typeof value.sessionId !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId))
          return { count: null, withAcceptedTurn: null, reconciled: false };
        const digest = crypto.createHash("sha256").update(value.sessionId).digest("hex");
        if (bucket.name !== digest.slice(0, 2) || entry.name !== digest + ".json")
          return { count: null, withAcceptedTurn: null, reconciled: false };
        if (value.lastAcceptedTurnId !== undefined) {
          if (!/^[A-Za-z0-9_-]{8,128}$/.test(value.lastAcceptedTurnId))
            return { count: null, withAcceptedTurn: null, reconciled: false };
          withAcceptedTurn++;
        }
      }
    }
    // A receipt with no accepted turn is passive session-routing metadata. A
    // receipt that references a turn still requires deeper history/effect review.
    return { count, withAcceptedTurn, reconciled: withAcceptedTurn === 0 };
  } catch {
    return { count: null, withAcceptedTurn: null, reconciled: false };
  }
}
async function openLocalTcp(port: number): Promise<boolean> {
  return await new Promise(resolve => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true; socket.destroy(); resolve(connected);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(800, () => finish(false));
  });
}
export interface CoreColdAuditResult {
  version: 1;
  port: number;
  snapshot: CoreColdSnapshot;
  assessment: CoreColdAssessment;
  note: "READ_ONLY_NO_REPLAY_NO_FILE_CLEANUP";
}
export async function auditCoreColdStart(port: number): Promise<CoreColdAuditResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid cold boot audit port");
  let ownerOnline = false;
  try {
    const owner = await requestCoreSupervisor("status", port, 1200);
    ownerOnline = owner.publicPort === port && owner.supervisorPid > 0 && owner.active.pid > 0;
  } catch {}
  const foreignListenerDetected = !ownerOnline && await openLocalTcp(port);
  const home = getRootConfigDir();
  const checkpointPath = coreCheckpointPath(port);
  let checkpoint: CoreColdSnapshot["checkpoint"] = "absent";
  try {
    const stat = fs.lstatSync(checkpointPath);
    if (!stat.isFile() || stat.isSymbolicLink()) checkpoint = "unreadable";
    else {
      try { readCoreCheckpoint(port); checkpoint = "valid"; }
      catch { checkpoint = "corrupt"; }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") checkpoint = "unreadable";
  }
  let guardianLeasePresent = false;
  try { guardianLeasePresent = readCoreGuardianLease(port) !== null; }
  catch { guardianLeasePresent = true; }
  const discoveryPath = path.join(home, "core-supervisor-" + port + ".json");
  let discoveryPresent = false;
  try { discoveryPresent = fs.existsSync(discoveryPath); }
  catch { discoveryPresent = true; }
  const ambiguousTurns = readUnresolvedTurns();
  const receiptAudit = auditSessionReceipts();
  const persistedReceipts = receiptAudit.count;
  // Session receipts are routing/resume metadata. They are not external effect
  // receipts. Passive receipts (no accepted turn reference) can be reconciled
  // read-only; any receipt tied to a turn remains fail-closed for deeper review.
  const workers: CoreColdSnapshot["workers"] = checkpoint === "absent" &&
    !discoveryPresent && !guardianLeasePresent ? "none" : "unknown";
  const externalEffectsReconciled = checkpoint === "absent" &&
    !discoveryPresent && !guardianLeasePresent &&
    ambiguousTurns === 0 && receiptAudit.reconciled;
  const snapshot: CoreColdSnapshot = {
    ownerOnline, foreignListenerDetected, discoveryPresent, guardianLeasePresent,
    checkpoint, workers, ambiguousTurns, persistedReceipts,
    receiptsWithAcceptedTurn: receiptAudit.withAcceptedTurn,
    sessionReceiptsReconciled: receiptAudit.reconciled,
    externalEffectsReconciled,
  };
  return { version: 1, port, snapshot, assessment: assessCoreColdStart(snapshot),
    note: "READ_ONLY_NO_REPLAY_NO_FILE_CLEANUP" };
}
