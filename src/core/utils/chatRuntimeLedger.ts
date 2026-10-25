import crypto from "node:crypto";
import { getHistoryDb } from "../storage/historyDb.js";

export type ChatTurnState = "accepted" | "queued" | "recoverable" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface ChatTurn {
  turnId: string;
  sessionId: string;
  workspace: string;
  clientMode: string;
  digest: string;
  state: ChatTurnState;
  message: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}
const QUEUE_LIMIT = 32;
let schemaDb: any = null;

function db(): any {
  const current = getHistoryDb();
  if (schemaDb !== current) {
    current.exec(`
      CREATE TABLE IF NOT EXISTS chat_turns (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        client_mode TEXT NOT NULL,
        digest TEXT NOT NULL,
        message_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('accepted','queued','recoverable','running','completed','failed','cancelled','interrupted')),
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_chat_turns_status ON chat_turns(state, updated_at);
      CREATE TABLE IF NOT EXISTS chat_event_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_journal_session ON chat_event_journal(session_id, id);
    `);
    schemaDb = current;
  }
  return current;
}
function parse(row: any): ChatTurn {
  return {
    turnId: row.turn_id, sessionId: row.session_id,
    workspace: row.workspace, clientMode: row.client_mode,
    digest: row.digest, state: row.state,
    message: JSON.parse(row.message_json), error: row.error || undefined,
    createdAt: row.created_at, updatedAt: row.updated_at,
    startedAt: row.started_at || undefined, finishedAt: row.finished_at || undefined,
  };
}
function sameWorkspace(a: string, b: string) {
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() ===
    b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
export function getChatTurn(turnId: string): ChatTurn | null {
  const row = db().prepare("SELECT * FROM chat_turns WHERE turn_id = ?").get(turnId);
  return row ? parse(row) : null;
}
export function listChatTurns(sessionId: string, limit = 100): ChatTurn[] {
  return (db().prepare("SELECT * FROM chat_turns WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(sessionId, Math.min(250, Math.max(1, limit))) as any[]).map(parse);
}
export function acceptChatTurn(input: {
  turnId: string; sessionId: string; workspace: string;
  clientMode: string; message: unknown; queueHint?: boolean;
}): { turn: ChatTurn; duplicate: boolean } {
  const database = db();
  const digest = crypto.createHash("sha256").update(JSON.stringify(input.message)).digest("hex");
  const serialized = JSON.stringify(input.message);
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) {
    throw new Error("Chat payload exceeds durable turn size limit");
  }
  const now = Date.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    const existing = database.prepare("SELECT * FROM chat_turns WHERE turn_id = ?").get(input.turnId);
    if (existing) {
      if (existing.session_id !== input.sessionId || existing.client_mode !== input.clientMode ||
          !sameWorkspace(existing.workspace, input.workspace) || existing.digest !== digest) {
        throw new Error("clientMessageId conflicts with an existing chat turn");
      }
      database.exec("COMMIT");
      return { turn: parse(existing), duplicate: true };
    }
    const active = database.prepare(
      "SELECT COUNT(*) AS count FROM chat_turns WHERE session_id = ? AND state IN ('accepted','queued','running')"
    ).get(input.sessionId) as { count: number };
    if (active.count >= QUEUE_LIMIT) throw new Error("Chat queue is full (32 pending turns)");
    const state = active.count || input.queueHint ? "queued" : "accepted";
    database.prepare(`INSERT INTO chat_turns
      (turn_id,session_id,workspace,client_mode,digest,message_json,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(input.turnId, input.sessionId, input.workspace, input.clientMode,
        digest, serialized, state, now, now);
    database.exec("COMMIT");
    return { turn: { turnId: input.turnId, sessionId: input.sessionId,
      workspace: input.workspace, clientMode: input.clientMode, message: input.message, digest,
      state, createdAt: now, updatedAt: now }, duplicate: false };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
export function changeChatTurnState(turnId: string, state: ChatTurnState, error?: string): boolean {
  const now = Date.now();
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(state);
  const result = db().prepare(`UPDATE chat_turns SET state = ?, error = ?, updated_at = ?,
    started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
    finished_at = CASE WHEN ? THEN ? ELSE finished_at END
    WHERE turn_id = ? AND state IN ('accepted','queued','running')`)
    .run(state, error?.slice(0, 500) || null, now, state, now, terminal ? 1 : 0, now, turnId);
  return Number(result.changes || 0) > 0;
}
export function cancelChatSessionTurns(sessionId: string): number {
  const now = Date.now();
  return Number(db().prepare(`UPDATE chat_turns SET state='cancelled',updated_at=?,finished_at=?
    WHERE session_id=? AND state IN ('accepted','queued','recoverable','running')`)
    .run(now, now, sessionId).changes || 0);
}
export function recoverInterruptedChatTurns(): number {
  const now = Date.now();
  // Never replay a running or accepted tool-containing turn automatically after a crash:
  // it might already have side effects. Queued, not-yet-started turns remain recoverable.
  const database = db();
  const uncertain = Number(database.prepare(`UPDATE chat_turns SET state='interrupted',
    error='Core restarted before a terminal result; inspect history before retrying',
    updated_at=?,finished_at=? WHERE state IN ('running','accepted')`)
    .run(now, now).changes || 0);
  // These turns were never marked running. Retain payloads durably but require
  // explicit resume so stale chat input does not unexpectedly execute tools.
  database.prepare(`UPDATE chat_turns SET state='recoverable',updated_at=?
    WHERE state='queued'`).run(now);
  return uncertain;
}
export function resumeRecoverableChatTurns(sessionId: string): number {
  const now = Date.now();
  return Number(db().prepare(`UPDATE chat_turns SET state='queued',updated_at=?
    WHERE session_id=? AND state='recoverable'`).run(now, sessionId).changes || 0);
}
export function deleteChatSessionTurnData(sessionId: string): void {
  const database = db();
  database.prepare("DELETE FROM chat_turns WHERE session_id=?").run(sessionId);
  database.prepare("DELETE FROM chat_event_journal WHERE session_id=?").run(sessionId);
}
export function appendChatEvent(sessionId: string, eventJson: string): number | null {
  if (!sessionId || Buffer.byteLength(eventJson) > 16 * 1024) return null;
  const database = db();
  const created = Date.now();
  const row = database.prepare(
    "INSERT INTO chat_event_journal (session_id,event_json,created_at) VALUES (?,?,?) RETURNING id"
  ).get(sessionId, eventJson, created) as { id: number };
  const id = row.id;
  // Bounded per session. Drop old events and limit aggregate retention.
  if (id % 32 === 0) {
    database.prepare(`DELETE FROM chat_event_journal WHERE session_id = ? AND id NOT IN
      (SELECT id FROM chat_event_journal WHERE session_id = ? ORDER BY id DESC LIMIT 256)`)
      .run(sessionId, sessionId);
    database.prepare("DELETE FROM chat_event_journal WHERE created_at < ?")
      .run(created - 24 * 60 * 60 * 1000);
  }
  return id;
}
export function replayChatEvents(sessionId: string, lastId: string, limit = 256): { events: string[]; gap: boolean } {
  const cursor = Number(lastId);
  if (!Number.isSafeInteger(cursor) || cursor < 0) return { events: [], gap: true };
  const database = db();
  const oldest = database.prepare("SELECT MIN(id) AS minId FROM chat_event_journal WHERE session_id = ?")
    .get(sessionId) as { minId: number | null };
  const rows = database.prepare(
    "SELECT id,event_json FROM chat_event_journal WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?"
  ).all(sessionId, cursor, Math.max(1, Math.min(256, limit))) as Array<{id:number;event_json:string}>;
  return {
    events: rows.map(row => `id: ${row.id}\ndata: ${row.event_json}\n\n`),
    gap: oldest.minId !== null && cursor > 0 && cursor < oldest.minId - 1,
  };
}
/** Bounded retention for terminal turn metadata and the short SSE journal. */
export function pruneChatRuntimeLedger(now = Date.now()): void {
  const database = db();
  database.prepare("DELETE FROM chat_event_journal WHERE created_at < ?")
    .run(now - 24 * 60 * 60 * 1000);
  database.prepare("DELETE FROM chat_turns WHERE finished_at IS NOT NULL AND finished_at < ?")
    .run(now - 30 * 24 * 60 * 60 * 1000);
}
export function getChatTurnMetrics(sessionId: string) {
  return db().prepare(`SELECT state,COUNT(*) AS count FROM chat_turns
    WHERE session_id=? GROUP BY state`).all(sessionId) as Array<{state: ChatTurnState;count: number}>;
}
