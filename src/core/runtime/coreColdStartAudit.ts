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

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readUnresolvedTurns(): number | null {
  const dbPath = path.join(getGlobalConfigDir(), "history.db");
  try { if (!fs.existsSync(dbPath)) return 0; }
  catch { return null; }
  try {
    const stat = fs.lstatSync(dbPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    let db: any;
    try { const { Database } = require("bun:sqlite"); db = new Database(dbPath, { readonly: true }); }
    catch {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(dbPath, { readOnly: true });
    }
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'").get();
      if (!table) return 0;
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM chat_turns WHERE state NOT IN ('completed','failed','cancelled')",
      ).get() as { count: number };
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
            !/^[A-Za-z0-9_-]{1,128}$/.test(value.sessionId)) {
          return { count: null, withAcceptedTurn: null, reconciled: false };
        }
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
    // A receipt with no accepted turn is passive resume/routing metadata.
    return { count, withAcceptedTurn, reconciled: withAcceptedTurn === 0 };
  } catch {
    return { count: null, withAcceptedTurn: null, reconciled: false };
  }
}

async function openLocalTcp(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
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

async function discoveryIsStale(file: string, port: number): Promise<boolean> {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 4096) return false;
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as {
      supervisorPid?: number; publicPort?: number; controlPort?: number; controlToken?: string;
    };
    if (value.publicPort !== port || !Number.isSafeInteger(value.supervisorPid) ||
        value.supervisorPid! <= 0 || !Number.isInteger(value.controlPort) ||
        value.controlPort! < 1 || value.controlPort! > 65535 ||
        typeof value.controlToken !== "string" || !/^[a-f0-9]{64}$/.test(value.controlToken)) {
      return false;
    }
    return !pidAlive(value.supervisorPid!) && !await openLocalTcp(value.controlPort!);
  } catch { return false; }
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
  let checkpointValue: ReturnType<typeof readCoreCheckpoint> | null = null;
  try {
    const stat = fs.lstatSync(checkpointPath);
    if (!stat.isFile() || stat.isSymbolicLink()) checkpoint = "unreadable";
    else {
      try {
        checkpointValue = readCoreCheckpoint(port);
        checkpoint = "valid";
      } catch {
        checkpoint = "corrupt";
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") checkpoint = "unreadable";
  }

  const guardianPath = coreGuardianFile(port);
  let guardianLeasePresent = false;
  let guardianLeaseStale = false;
  try {
    const guardian = readCoreGuardianLease(port);
    guardianLeasePresent = guardian !== null;
    guardianLeaseStale = Boolean(guardian && !pidAlive(guardian.pid));
  } catch {
    guardianLeasePresent = true;
    guardianLeaseStale = false;
  }

  const discoveryPath = path.join(home, "core-supervisor-" + port + ".json");
  let discoveryPresent = false;
  let discoveryStale = false;
  try {
    discoveryPresent = fs.existsSync(discoveryPath);
    if (discoveryPresent) discoveryStale = await discoveryIsStale(discoveryPath, port);
  } catch {
    discoveryPresent = true;
    discoveryStale = false;
  }

  let workers: CoreColdSnapshot["workers"] = "none";
  if (checkpointValue) {
    const alive = checkpointValue.workers.filter(worker => pidAlive(worker.pid)).length;
    workers = alive === 0 ? "all_dead" :
      alive === checkpointValue.workers.length ? "verified_alive" : "unknown";
  } else if (checkpoint !== "absent" || discoveryPresent || guardianLeasePresent) {
    workers = "unknown";
  }

  const ambiguousTurns = readUnresolvedTurns();
  const receiptAudit = auditSessionReceipts();
  const persistedReceipts = receiptAudit.count;
  const externalEffectsReconciled =
    ambiguousTurns === 0 && receiptAudit.reconciled;

  const snapshot: CoreColdSnapshot = {
    ownerOnline, foreignListenerDetected,
    discoveryPresent, guardianLeasePresent, discoveryStale, guardianLeaseStale,
    checkpoint, workers, ambiguousTurns, persistedReceipts,
    receiptsWithAcceptedTurn: receiptAudit.withAcceptedTurn,
    sessionReceiptsReconciled: receiptAudit.reconciled,
    externalEffectsReconciled,
  };
  return {
    version: 1, port, snapshot, assessment: assessCoreColdStart(snapshot),
    note: "READ_ONLY_NO_REPLAY_NO_FILE_CLEANUP",
  };
}
