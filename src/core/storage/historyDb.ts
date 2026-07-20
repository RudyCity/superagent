import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { getGlobalConfigDir } from "../config/paths.js";

const require = createRequire(import.meta.url);

export interface SessionRecord {
  id: string;
  filePath: string;
  displayName: string;
  messageCount: number;
  lastModified: number;
  preview: string;
  workingDirectory?: string;
  planState?: string;
  activePreset?: string;
  extraData?: string;
}

export interface MessageRecord {
  id?: number;
  sessionId: string;
  role: string;
  content: string;
  toolCalls?: string;
  toolResults?: string;
  reasoning?: string;
  timestamp: number;
  sequenceOrder: number;
}

export interface CompactionRecord {
  id: string;
  sessionId?: string;
  timestamp: number;
  strategy: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  summaryTokens?: number;
  pinnedMessages?: string;
  reason: string;
}

let dbInstance: any = null;

export function getHistoryDbPath(): string {
  const configDir = getGlobalConfigDir();
  return path.join(configDir, "history.db");
}

function createSqliteDb(dbPath: string): any {
  const isBun = typeof process !== "undefined" && (process.versions as any)?.bun;
  if (isBun) {
    try {
      const { Database } = require("bun:sqlite");
      return new Database(dbPath);
    } catch {}
  }
  try {
    const { DatabaseSync } = require("node:sqlite");
    return new DatabaseSync(dbPath);
  } catch (e) {
    try {
      const { Database } = require("bun:sqlite");
      return new Database(dbPath);
    } catch {
      throw new Error("Neither node:sqlite nor bun:sqlite could be loaded.");
    }
  }
}

export function getHistoryDb(): any {
  if (!dbInstance) {
    const dbPath = getHistoryDbPath();
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    dbInstance = createSqliteDb(dbPath);
    initDatabaseSchema(dbInstance);
  }
  return dbInstance;
}

function initDatabaseSchema(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_modified INTEGER NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      working_directory TEXT,
      plan_state TEXT,
      active_preset TEXT,
      extra_data TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      reasoning TEXT,
      timestamp INTEGER NOT NULL,
      sequence_order INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, sequence_order);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_modified ON sessions(last_modified DESC);

    CREATE TABLE IF NOT EXISTS compaction_events (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      timestamp INTEGER NOT NULL,
      strategy TEXT NOT NULL,
      messages_before INTEGER NOT NULL,
      messages_after INTEGER NOT NULL,
      tokens_before INTEGER NOT NULL,
      tokens_after INTEGER NOT NULL,
      summary TEXT,
      summary_tokens INTEGER,
      pinned_messages TEXT,
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_compaction_timestamp ON compaction_events(timestamp DESC);

    CREATE TABLE IF NOT EXISTS pinned_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_data TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
  `);
}

export function saveSessionToDb(session: SessionRecord, messages: MessageRecord[], pinnedMessagesJson?: string): void {
  const db = getHistoryDb();

  db.exec("BEGIN TRANSACTION;");
  try {
    const upsertSessionStmt = db.prepare(`
      INSERT INTO sessions (
        id, file_path, display_name, message_count, last_modified, preview, working_directory, plan_state, active_preset, extra_data, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        display_name = excluded.display_name,
        message_count = excluded.message_count,
        last_modified = excluded.last_modified,
        preview = excluded.preview,
        working_directory = excluded.working_directory,
        plan_state = excluded.plan_state,
        active_preset = excluded.active_preset,
        extra_data = excluded.extra_data,
        updated_at = excluded.updated_at
    `);

    const now = Date.now();
    upsertSessionStmt.run(
      session.id,
      session.filePath,
      session.displayName,
      session.messageCount,
      session.lastModified,
      session.preview,
      session.workingDirectory || null,
      session.planState || null,
      session.activePreset || null,
      session.extraData || null,
      now
    );

    const deleteMessagesStmt = db.prepare("DELETE FROM messages WHERE session_id = ?");
    deleteMessagesStmt.run(session.id);

    const insertMessageStmt = db.prepare(`
      INSERT INTO messages (
        session_id, role, content, tool_calls, tool_results, reasoning, timestamp, sequence_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      insertMessageStmt.run(
        session.id,
        msg.role,
        msg.content,
        msg.toolCalls || null,
        msg.toolResults || null,
        msg.reasoning || null,
        msg.timestamp,
        i
      );
    }

    if (pinnedMessagesJson) {
      const deletePinnedStmt = db.prepare("DELETE FROM pinned_messages WHERE session_id = ?");
      deletePinnedStmt.run(session.id);

      const insertPinnedStmt = db.prepare(`
        INSERT INTO pinned_messages (session_id, message_data, created_at) VALUES (?, ?, ?)
      `);
      insertPinnedStmt.run(session.id, pinnedMessagesJson, now);
    }

    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export function loadSessionFromDb(sessionId: string): {
  session: SessionRecord | null;
  messages: MessageRecord[];
  pinnedMessagesJson?: string;
} {
  const db = getHistoryDb();

  const getSessionStmt = db.prepare(`
    SELECT id, file_path as filePath, display_name as displayName, message_count as messageCount,
           last_modified as lastModified, preview, working_directory as workingDirectory,
           plan_state as planState, active_preset as activePreset, extra_data as extraData
    FROM sessions WHERE id = ?
  `);
  const sessionRow = getSessionStmt.get(sessionId) as SessionRecord | undefined;

  if (!sessionRow) {
    return { session: null, messages: [] };
  }

  const getMessagesStmt = db.prepare(`
    SELECT session_id as sessionId, role, content, tool_calls as toolCalls,
           tool_results as toolResults, reasoning, timestamp, sequence_order as sequenceOrder
    FROM messages WHERE session_id = ? ORDER BY sequence_order ASC
  `);
  const messages = (getMessagesStmt.all(sessionId) || []) as MessageRecord[];

  const getPinnedStmt = db.prepare("SELECT message_data as messageData FROM pinned_messages WHERE session_id = ? ORDER BY id DESC LIMIT 1");
  const pinnedRow = getPinnedStmt.get(sessionId) as { messageData: string } | undefined;

  return {
    session: sessionRow,
    messages,
    pinnedMessagesJson: pinnedRow?.messageData,
  };
}

export function listSessionsFromDb(limit: number = 100): SessionRecord[] {
  const db = getHistoryDb();
  const stmt = db.prepare(`
    SELECT id, file_path as filePath, display_name as displayName, message_count as messageCount,
           last_modified as lastModified, preview, working_directory as workingDirectory,
           plan_state as planState, active_preset as activePreset
    FROM sessions ORDER BY last_modified DESC LIMIT ?
  `);
  return (stmt.all(limit) || []) as SessionRecord[];
}

export function deleteSessionFromDb(sessionId: string): void {
  const db = getHistoryDb();
  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM pinned_messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

export function recordCompactionToDb(record: CompactionRecord): void {
  const db = getHistoryDb();
  const stmt = db.prepare(`
    INSERT INTO compaction_events (
      id, session_id, timestamp, strategy, messages_before, messages_after,
      tokens_before, tokens_after, summary, summary_tokens, pinned_messages, reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      messages_before = excluded.messages_before,
      messages_after = excluded.messages_after,
      tokens_before = excluded.tokens_before,
      tokens_after = excluded.tokens_after,
      summary = excluded.summary,
      summary_tokens = excluded.summary_tokens,
      pinned_messages = excluded.pinned_messages,
      reason = excluded.reason
  `);
  stmt.run(
    record.id,
    record.sessionId || null,
    record.timestamp,
    record.strategy,
    record.messagesBefore,
    record.messagesAfter,
    record.tokensBefore,
    record.tokensAfter,
    record.summary || null,
    record.summaryTokens || null,
    record.pinnedMessages || null,
    record.reason
  );
}

export function getCompactionHistoryFromDb(limit: number = 50): CompactionRecord[] {
  const db = getHistoryDb();
  const stmt = db.prepare(`
    SELECT id, session_id as sessionId, timestamp, strategy, messages_before as messagesBefore,
           messages_after as messagesAfter, tokens_before as tokensBefore, tokens_after as tokensAfter,
           summary, summary_tokens as summaryTokens, pinned_messages as pinnedMessages, reason
    FROM compaction_events ORDER BY timestamp DESC LIMIT ?
  `);
  return (stmt.all(limit) || []) as CompactionRecord[];
}

export function clearCompactionHistoryInDb(): void {
  const db = getHistoryDb();
  db.prepare("DELETE FROM compaction_events").run();
}

export function searchMessagesInDb(query: string, limit: number = 50): Array<{
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
  displayName: string;
}> {
  const db = getHistoryDb();
  const stmt = db.prepare(`
    SELECT m.session_id as sessionId, m.role, m.content, m.timestamp, s.display_name as displayName
    FROM messages m
    JOIN sessions s ON m.session_id = s.id
    WHERE m.content LIKE ?
    ORDER BY m.timestamp DESC LIMIT ?
  `);
  const pattern = `%${query}%`;
  return (stmt.all(pattern, limit) || []) as Array<{
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
    displayName: string;
  }>;
}

export function closeHistoryDb(): void {
  if (dbInstance) {
    if (typeof dbInstance.close === "function") {
      dbInstance.close();
    }
    dbInstance = null;
  }
}
