// src/core/storage/fileLocksDb.ts
//
// FASE 5A (1.5.7): SQLite-backed access to the *current* set of
// file locks. The audit log (file_lock_events) was already in
// historyDb.ts; this file holds the live state.
//
// We mirror file-locks.json into the `file_locks_current` SQLite
// table for fast indexed lookup. The sharedMemory subsystem writes
// to BOTH stores — JSON remains the source of truth on disk for
// forensics / cross-process safety, SQLite is the fast read path.
//
// The dual-write is best-effort: a SQLite failure MUST NOT break
// locking. Every helper here is wrapped in try/catch and returns
// an empty / no-op result on error so callers always fall back to
// the JSON path.

import type { FileLockEntry } from "./sharedMemory.js";

let _db: any = null;
let _stmts: {
  upsert?: any;
  deleteByPath?: any;
  deleteBySession?: any;
  selectAll?: any;
  selectByPath?: any;
  selectBySession?: any;
  count?: any;
} = {};

async function getDb() {
  if (_db) return _db;
  try {
    // Dynamic-import the parent db to avoid pulling in the entire
    // history subsystem on lock operations.
    const { getHistoryDb } = await import("./historyDb.js");
    _db = getHistoryDb();
    if (!_db) {
      // eslint-disable-next-line no-console
      console.error("[fileLocksDb] getHistoryDb() returned null");
      return null;
    }
    _stmts.upsert = _db.prepare(`
      INSERT INTO file_locks_current
        (file_path, session_id, owner_pid, owner_ppid, acquired_at,
         expires_at, project_path, line_range, is_intent_soft_lock,
         remote_node_id, terminal_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        session_id = excluded.session_id,
        owner_pid = excluded.owner_pid,
        owner_ppid = excluded.owner_ppid,
        acquired_at = excluded.acquired_at,
        expires_at = excluded.expires_at,
        project_path = excluded.project_path,
        line_range = excluded.line_range,
        is_intent_soft_lock = excluded.is_intent_soft_lock,
        remote_node_id = excluded.remote_node_id,
        terminal_type = excluded.terminal_type
    `);
    _stmts.deleteByPath = _db.prepare(
      `DELETE FROM file_locks_current WHERE file_path = ?`
    );
    _stmts.deleteBySession = _db.prepare(
      `DELETE FROM file_locks_current WHERE session_id = ?`
    );
    _stmts.selectAll = _db.prepare(
      `SELECT * FROM file_locks_current`
    );
    _stmts.selectByPath = _db.prepare(
      `SELECT * FROM file_locks_current WHERE file_path = ?`
    );
    _stmts.selectBySession = _db.prepare(
      `SELECT * FROM file_locks_current WHERE session_id = ?`
    );
    _stmts.count = _db.prepare(
      `SELECT COUNT(*) as c FROM file_locks_current`
    );
    return _db;
  } catch (err) {
    return null;
  }
}

function rowToEntry(row: any): FileLockEntry {
  if (!row) return null as any;
  let lineRange: any = undefined;
  if (row.line_range) {
    try {
      lineRange = JSON.parse(row.line_range);
    } catch {
      lineRange = undefined;
    }
  }
  return {
    filePath: row.file_path,
    sessionId: row.session_id,
    terminalType: row.terminal_type || undefined,
    lockedAt: Number(row.acquired_at),
    ttlMs: Math.max(0, Number(row.expires_at) - Number(row.acquired_at)),
    projectPath: row.project_path || "",
    isIntentSoftLock: !!row.is_intent_soft_lock,
    pid: Number(row.owner_pid) || undefined,
    lineRange,
    remoteNodeId: row.remote_node_id || undefined,
  };
}

/** Replace the entire `file_locks_current` table with the given entries. */
export async function replaceAllLocks(entries: FileLockEntry[]): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    // We support both `bun:sqlite` and `node:sqlite`. Neither has
    // better-sqlite3's `db.transaction(fn)` helper, so we drive the
    // transaction with explicit BEGIN/COMMIT. Both libs serialise
    // statements synchronously, so the BEGIN / DELETE / 100x INSERT
    // / COMMIT sequence is atomic as long as no async awaits happen
    // between BEGIN and COMMIT.
    db.exec(`BEGIN`);
    try {
      db.exec(`DELETE FROM file_locks_current`);
      const ins = db.prepare(`
        INSERT INTO file_locks_current
          (file_path, session_id, owner_pid, owner_ppid, acquired_at,
           expires_at, project_path, line_range, is_intent_soft_lock,
           remote_node_id, terminal_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of entries) {
        ins.run(
          r.filePath,
          r.sessionId,
          r.pid || 0,
          null,
          r.lockedAt,
          r.lockedAt + (r.ttlMs || 0),
          r.projectPath || null,
          r.lineRange ? JSON.stringify(r.lineRange) : null,
          r.isIntentSoftLock ? 1 : 0,
          r.remoteNodeId || null,
          r.terminalType || null
        );
      }
      db.exec(`COMMIT`);
    } catch (innerErr) {
      try { db.exec(`ROLLBACK`); } catch {}
      throw innerErr;
    }
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[fileLocksDb] replaceAllLocks failed:", err);
    return false;
  }
}

/** Upsert a single lock. */
export async function upsertLock(entry: FileLockEntry): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db || !_stmts.upsert) return false;
    _stmts.upsert.run(
      entry.filePath,
      entry.sessionId,
      entry.pid || 0,
      null,
      entry.lockedAt,
      entry.lockedAt + (entry.ttlMs || 0),
      entry.projectPath || null,
      entry.lineRange ? JSON.stringify(entry.lineRange) : null,
      entry.isIntentSoftLock ? 1 : 0,
      entry.remoteNodeId || null,
      entry.terminalType || null
    );
    return true;
  } catch {
    return false;
  }
}

/** Delete a single lock by file_path. */
export async function deleteLockByPath(filePath: string): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db || !_stmts.deleteByPath) return false;
    _stmts.deleteByPath.run(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Delete all locks held by `sessionId`. */
export async function deleteLocksBySession(sessionId: string): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db || !_stmts.deleteBySession) return false;
    _stmts.deleteBySession.run(sessionId);
    return true;
  } catch {
    return false;
  }
}

/** Read all current locks. Returns [] on any error. */
export async function readAllLocks(): Promise<FileLockEntry[]> {
  try {
    const db = await getDb();
    if (!db || !_stmts.selectAll) return [];
    const rows = _stmts.selectAll.all();
    return rows.map(rowToEntry);
  } catch {
    return [];
  }
}

/** Count current locks. Returns -1 on error. */
export async function countLocks(): Promise<number> {
  try {
    const db = await getDb();
    if (!db || !_stmts.count) return -1;
    const row = _stmts.count.get();
    return Number(row?.c ?? 0);
  } catch {
    return -1;
  }
}

/** Check whether SQLite mirror is healthy. */
export async function isFileLocksDbHealthy(): Promise<boolean> {
  try {
    const db = await getDb();
    return !!db;
  } catch {
    return false;
  }
}
