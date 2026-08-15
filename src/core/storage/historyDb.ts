import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { getGlobalConfigDir, getWorkspaceId, getModelConfigPath, getRootConfigDir } from "../config/paths.js";
import { logE2E } from "../utils/unifiedLogger.js";

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
  tags?: string;
  workspaceId?: string;
  firstChat?: string;
  lastChat?: string;
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

let dbInstance: any = (globalThis as any).__superagent_db_instance || null;

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
  // Check global again in case another module instance initialized it
  if (!dbInstance && (globalThis as any).__superagent_db_instance) {
    dbInstance = (globalThis as any).__superagent_db_instance;
  }
  if (!dbInstance) {
    const dbPath = getHistoryDbPath();
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    dbInstance = createSqliteDb(dbPath);
    (globalThis as any).__superagent_db_instance = dbInstance;
    initDatabaseSchema(dbInstance);
  }
  return dbInstance;
}

function initDatabaseSchema(db: any): void {
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA temp_store = MEMORY;");
    db.exec("PRAGMA cache_size = -16000;"); // 16MB cache
  } catch {}

  // FTS5 table created below with full schema (incl display_name)

  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT,
      is_trusted INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL DEFAULT '',
      display_name TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      last_modified INTEGER NOT NULL,
      preview TEXT NOT NULL DEFAULT '',
      working_directory TEXT,
      plan_state TEXT,
      active_preset TEXT,
      extra_data TEXT,
      tags TEXT,
      workspace_id TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
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

    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      session_file_path TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      messages_json TEXT NOT NULL,
      plan_state TEXT NOT NULL DEFAULT 'IDLE',
      plan_file_content TEXT,
      task_file_content TEXT,
      task_history_file_content TEXT,
      walkthrough_file_content TEXT,
      git_sha TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, timestamp DESC);

    CREATE TABLE IF NOT EXISTS input_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workspace_id TEXT NOT NULL,
      command TEXT NOT NULL,
      timestamp INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_input_history_ws ON input_history(workspace_id, id ASC);

    CREATE TABLE IF NOT EXISTS model_caches (
      id TEXT PRIMARY KEY,
      context_limit INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS tool_support_cache (
      model_id TEXT PRIMARY KEY,
      supported INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS rate_limit_state (
      key TEXT PRIMARY KEY,
      tokens_remaining INTEGER NOT NULL,
      last_updated INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pinned_knowledge (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      role TEXT NOT NULL,
      agent_tag TEXT,
      tag TEXT,
      source_session_path TEXT NOT NULL,
      working_directory TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      preview TEXT NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      workspace_id TEXT,
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_pinned_knowledge_wd ON pinned_knowledge(working_directory);
    CREATE INDEX IF NOT EXISTS idx_pinned_knowledge_tag ON pinned_knowledge(tag);

    CREATE TABLE IF NOT EXISTS file_lock_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      session_id TEXT NOT NULL,
      terminal_type TEXT,
      event_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      project_path TEXT,
      line_range TEXT,
      ttl_ms INTEGER,
      is_intent_soft_lock INTEGER NOT NULL DEFAULT 0,
      remote_node_id TEXT,
      locked_at INTEGER,
      released_at INTEGER,
      force_unlock INTEGER NOT NULL DEFAULT 0,
      details TEXT
    );

    CREATE TABLE IF NOT EXISTS workspace_tasks (
      workspace_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      command TEXT NOT NULL,
      pid INTEGER NOT NULL,
      log_path TEXT,
      is_detached_window INTEGER NOT NULL DEFAULT 0,
      window_label TEXT,
      auto_retry INTEGER NOT NULL DEFAULT 0,
      on_exit TEXT,
      has_exited INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      completed_at INTEGER,
      is_hidden INTEGER NOT NULL DEFAULT 0,
      cwd TEXT,
      PRIMARY KEY (workspace_id, task_id),
      FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
    );
  `);

  // Schema migrations for missing columns in existing databases
  try {
    const sessionCols = [
      { name: "working_directory", type: "TEXT" },
      { name: "plan_state", type: "TEXT" },
      { name: "active_preset", type: "TEXT" },
      { name: "extra_data", type: "TEXT" },
      { name: "tags", type: "TEXT" },
      { name: "workspace_id", type: "TEXT" },
      { name: "first_chat", type: "TEXT" },
      { name: "last_chat", type: "TEXT" },
    ];
    for (const col of sessionCols) {
      try {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.type};`);
      } catch {}
    }
  } catch {}

  try {
    const checkpointCols = [
      { name: "plan_state", type: "TEXT NOT NULL DEFAULT 'IDLE'" },
      { name: "plan_file_content", type: "TEXT" },
      { name: "task_file_content", type: "TEXT" },
      { name: "task_history_file_content", type: "TEXT" },
      { name: "walkthrough_file_content", type: "TEXT" },
      { name: "git_sha", type: "TEXT" },
    ];
    for (const col of checkpointCols) {
      try {
        db.exec(`ALTER TABLE checkpoints ADD COLUMN ${col.name} ${col.type};`);
      } catch {}
    }
  } catch {}

  try {
    const pinnedCols = [
      { name: "workspace_id", type: "TEXT" },
    ];
    for (const col of pinnedCols) {
      try {
        db.exec(`ALTER TABLE pinned_knowledge ADD COLUMN ${col.name} ${col.type};`);
      } catch {}
    }
  } catch {}

  try {
    const workspacesCols = [
      { name: "name", type: "TEXT" },
    ];
    for (const col of workspacesCols) {
      try {
        db.exec(`ALTER TABLE workspaces ADD COLUMN ${col.name} ${col.type};`);
      } catch {}
    }
  } catch {}

  // Schema migrations for file_lock_events table (comprehensive lock audit fields)
  try {
    const lockEventCols = [
      { name: "project_path", type: "TEXT" },
      { name: "line_range", type: "TEXT" },
      { name: "ttl_ms", type: "INTEGER" },
      { name: "is_intent_soft_lock", type: "INTEGER NOT NULL DEFAULT 0" },
      { name: "remote_node_id", type: "TEXT" },
      { name: "locked_at", type: "INTEGER" },
      { name: "released_at", type: "INTEGER" },
      { name: "force_unlock", type: "INTEGER NOT NULL DEFAULT 0" },
      { name: "details", type: "TEXT" },
    ];
    for (const col of lockEventCols) {
      try {
        db.exec(`ALTER TABLE file_lock_events ADD COLUMN ${col.name} ${col.type};`);
      } catch {}
    }
  } catch {}

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        session_id UNINDEXED,
        role UNINDEXED,
        content,
        display_name
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, session_id, role, content, display_name)
        SELECT new.id, new.session_id, new.role, new.content, s.display_name
        FROM sessions s WHERE s.id = new.session_id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        DELETE FROM messages_fts WHERE rowid = old.id;
        INSERT INTO messages_fts(rowid, session_id, role, content, display_name)
        SELECT new.id, new.session_id, new.role, new.content, s.display_name
        FROM sessions s WHERE s.id = new.session_id;
      END;
    `);
  } catch {
    // FTS5 might not be enabled in all environments; fallback gracefully
  }

  // Run legacy migration to import existing trusted directories
  migrateLegacyTrustedDirs(db);
}

export function saveSessionToDb(session: SessionRecord, messages: MessageRecord[], pinnedMessagesJson?: string): void {
  const db = getHistoryDb();

  db.exec("BEGIN TRANSACTION;");
  try {
    const workspaceId = session.workingDirectory ? getWorkspaceId(session.workingDirectory) : null;
    if (workspaceId && session.workingDirectory) {
      try {
        const resolvedPath = (session.workingDirectory.startsWith("ssh:") || session.workingDirectory.startsWith("ssh://") || session.workingDirectory.startsWith("chain:"))
          ? session.workingDirectory
          : path.resolve(session.workingDirectory);
        db.prepare(`
          INSERT INTO workspaces (id, path, name, is_trusted)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(id) DO NOTHING
        `).run(workspaceId, resolvedPath, path.basename(resolvedPath));
      } catch {}
    }

    const upsertSessionStmt = db.prepare(`
      INSERT INTO sessions (
        id, file_path, display_name, message_count, last_modified, preview, working_directory, plan_state, active_preset, extra_data, workspace_id, first_chat, last_chat, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        workspace_id = excluded.workspace_id,
        first_chat = excluded.first_chat,
        last_chat = excluded.last_chat,
        updated_at = excluded.updated_at
    `);

    const userMsgs = (messages || []).filter(m => m && m.role === 'user' && m.content);
    const firstUserContent = userMsgs[0]?.content || null;
    const lastUserContent = userMsgs[userMsgs.length - 1]?.content || null;

    const now = Date.now();
    upsertSessionStmt.run(
      session.id,
      session.filePath || "",
      session.displayName,
      session.messageCount,
      session.lastModified,
      session.preview,
      session.workingDirectory || null,
      session.planState || null,
      session.activePreset || null,
      session.extraData || null,
      workspaceId,
      session.firstChat || firstUserContent,
      session.lastChat || lastUserContent,
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
    try {
      const { clearHistoryCache } = require("../config/history.js");
      clearHistoryCache();
    } catch {}
    logE2E("SQL", `saveSessionToDb: ${session.id}`, { messageCount: messages.length, workingDirectory: session.workingDirectory });
  } catch (err) {
    db.exec("ROLLBACK;");
    logE2E("SQL", `saveSessionToDb ERROR: ${session.id}`, { error: String(err) });
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
           plan_state as planState, active_preset as activePreset, extra_data as extraData,
           workspace_id as workspaceId,
           COALESCE(
             NULLIF(NULLIF(first_chat, ''), 'New Chat'),
             (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role = 'user' AND m.content != '' ORDER BY m.sequence_order ASC LIMIT 1)
           ) as firstChat,
           COALESCE(
             NULLIF(NULLIF(last_chat, ''), 'New Chat'),
             (SELECT m.content FROM messages m WHERE m.session_id = sessions.id AND m.role = 'user' AND m.content != '' ORDER BY m.sequence_order DESC LIMIT 1)
           ) as lastChat
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

  logE2E("SQL", `loadSessionFromDb: ${sessionId}`, {
    found: !!sessionRow,
    messageCount: messages.length,
    workingDirectory: sessionRow?.workingDirectory
  });

  return {
    session: sessionRow,
    messages,
    pinnedMessagesJson: pinnedRow?.messageData,
  };
}

export function listSessionsFromDb(limit: number = 100): SessionRecord[] {
  const db = getHistoryDb();
  const stmt = db.prepare(`
    SELECT s.id, s.file_path as filePath, s.display_name as displayName, s.message_count as messageCount,
           s.last_modified as lastModified, s.preview, s.working_directory as workingDirectory,
           s.plan_state as planState, s.active_preset as activePreset, s.workspace_id as workspaceId,
           COALESCE(
             NULLIF(NULLIF(s.first_chat, ''), 'New Chat'),
             (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.content != '' ORDER BY m.sequence_order ASC LIMIT 1)
           ) as firstChat,
           COALESCE(
             NULLIF(NULLIF(s.last_chat, ''), 'New Chat'),
             (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user' AND m.content != '' ORDER BY m.sequence_order DESC LIMIT 1)
           ) as lastChat
    FROM sessions s ORDER BY s.last_modified DESC LIMIT ?
  `);
  return (stmt.all(limit) || []) as SessionRecord[];
}

export function deleteSessionFromDb(sessionId: string): void {
  const db = getHistoryDb();
  const stmt = db.prepare("SELECT file_path as filePath FROM sessions WHERE id = ?");
  const rec = stmt.get(sessionId) as { filePath?: string } | undefined;

  db.exec("BEGIN TRANSACTION;");
  try {
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM pinned_messages WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(sessionId);
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.exec("COMMIT;");
    try {
      const { clearHistoryCache } = require("../config/history.js");
      clearHistoryCache();
    } catch {}
    vacuumDatabase();
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  if (rec && rec.filePath) {
    try {
      if (fs.existsSync(rec.filePath)) {
        fs.unlinkSync(rec.filePath);
      }
      const dir = path.dirname(rec.filePath);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {}
  }
}

export function purgeEmptySessionsFromDb(maxAgeMs: number = 24 * 3600 * 1000): { purgedCount: number; purgedFilePaths: string[] } {
  const db = getHistoryDb();
  const cutoffTime = Date.now() - maxAgeMs;
  const stmt = db.prepare(`
    SELECT id, file_path as filePath FROM sessions
    WHERE message_count = 0 OR (message_count = 0 AND last_modified <= ?)
  `);
  const candidates = (stmt.all(cutoffTime) || []) as { id: string; filePath: string }[];
  const purgedFilePaths: string[] = [];

  if (candidates.length === 0) {
    return { purgedCount: 0, purgedFilePaths: [] };
  }

  db.exec("BEGIN TRANSACTION;");
  try {
    const deleteSessionStmt = db.prepare("DELETE FROM sessions WHERE id = ?");
    const deleteMessagesStmt = db.prepare("DELETE FROM messages WHERE session_id = ?");
    const deletePinnedStmt = db.prepare("DELETE FROM pinned_messages WHERE session_id = ?");
    const deleteCheckpointsStmt = db.prepare("DELETE FROM checkpoints WHERE session_id = ?");

    for (const c of candidates) {
      deleteMessagesStmt.run(c.id);
      deletePinnedStmt.run(c.id);
      deleteCheckpointsStmt.run(c.id);
      deleteSessionStmt.run(c.id);
      if (c.filePath) {
        purgedFilePaths.push(c.filePath);
      }
    }
    db.exec("COMMIT;");
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }

  return { purgedCount: candidates.length, purgedFilePaths };
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

  try {
    const ftsStmt = db.prepare(`
      SELECT f.session_id as sessionId, f.role, f.content, m.timestamp, s.display_name as displayName
      FROM messages_fts f
      JOIN messages m ON f.rowid = m.id
      JOIN sessions s ON f.session_id = s.id
      WHERE messages_fts MATCH ?
      ORDER BY m.timestamp DESC LIMIT ?
    `);
    const cleanQuery = query.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
    if (cleanQuery.length > 0) {
      const ftsResults = ftsStmt.all(`*${cleanQuery}*`, limit) as Array<any>;
      if (ftsResults && ftsResults.length > 0) {
        return ftsResults;
      }
    }
  } catch {
    // Fallback to SQL LIKE search if FTS syntax error or missing virtual table
  }

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

export function migrateLegacyJsonToDb(): number {
  const configDir = getGlobalConfigDir();
  const historyBase = path.join(configDir, "history");
  if (!fs.existsSync(historyBase)) return 0;

  let importedCount = 0;
  const modes = ["single", "multi"];

  for (const mode of modes) {
    const modeDir = path.join(historyBase, mode);
    if (!fs.existsSync(modeDir)) continue;

    try {
      const dirs = fs.readdirSync(modeDir).filter(d => d !== "superagents" && d !== "subagents" && d !== "history-metadata.json");
      for (const d of dirs) {
        const filePath = path.join(modeDir, d, `${d}.json`);
        if (!fs.existsSync(filePath)) continue;

        const existing = loadSessionFromDb(d);
        if (existing.session && existing.messages.length > 0) continue;

        try {
          const raw = fs.readFileSync(filePath, "utf-8");
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object") continue;

          let messages: MessageRecord[] = [];
          if (Array.isArray(parsed.messages)) {
            messages = parsed.messages.map((m: any, idx: number) => ({
              sessionId: d,
              role: m.role || "user",
              content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
              toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
              toolResults: m.toolResults ? JSON.stringify(m.toolResults) : undefined,
              reasoning: m.reasoning,
              timestamp: m.timestamp || Date.now(),
              sequenceOrder: idx,
            }));
          }

          const userMsgs = messages.filter(m => m.role === "user");
          const lastUser = userMsgs[userMsgs.length - 1];
          const preview = lastUser
            ? lastUser.content.slice(0, 60).replace(/\n/g, " ") + (lastUser.content.length > 60 ? "…" : "")
            : "(imported session)";

          saveSessionToDb(
            {
              id: d,
              filePath,
              displayName: d,
              messageCount: messages.length,
              lastModified: fs.statSync(filePath).mtimeMs,
              preview,
              workingDirectory: parsed.workingDirectory,
              planState: parsed.planState,
              activePreset: parsed.activePreset ? JSON.stringify(parsed.activePreset) : undefined,
              extraData: JSON.stringify({
                superagents: parsed.superagents || [],
                subagents: parsed.subagents || [],
                historicalSuperagentTokens: parsed.historicalSuperagentTokens || 0,
                masterPromptTokens: parsed.masterPromptTokens || 0,
                masterCompletionTokens: parsed.masterCompletionTokens || 0,
                lastMasterPromptTokens: parsed.lastMasterPromptTokens || 0,
                lastCapturedTimestamp: parsed.lastCapturedTimestamp || 0,
              }),
            },
            messages,
            parsed.pinnedMessages ? JSON.stringify(parsed.pinnedMessages) : undefined
          );
          importedCount++;
        } catch {}
      }
    } catch {}
  }

  return importedCount;
}

export function cleanLegacyJsonFiles(): number {
  const configDir = getGlobalConfigDir();
  const historyBase = path.join(configDir, "history");
  if (!fs.existsSync(historyBase)) return 0;

  // First migrate any unimported legacy JSON files
  migrateLegacyJsonToDb();

  let cleanedCount = 0;
  const modes = ["single", "multi"];

  for (const mode of modes) {
    const modeDir = path.join(historyBase, mode);
    if (!fs.existsSync(modeDir)) continue;

    try {
      const entries = fs.readdirSync(modeDir);
      for (const entry of entries) {
        const fullPath = path.join(modeDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && entry.endsWith(".json")) {
            fs.unlinkSync(fullPath);
            cleanedCount++;
          } else if (stat.isDirectory() && entry !== "superagents" && entry !== "subagents") {
            const jsonFile = path.join(fullPath, `${entry}.json`);
            if (fs.existsSync(jsonFile)) {
              // Replace bulky JSON with empty 0-byte file anchor
              fs.writeFileSync(jsonFile, "", "utf-8");
              cleanedCount++;
            }
          }
        } catch {}
      }
    } catch {}
  }

  return cleanedCount;
}

export function exportSessionToJson(sessionId: string): string | null {
  const loaded = loadSessionFromDb(sessionId);
  if (!loaded.session) return null;

  let extraDataObj: any = {};
  if (loaded.session.extraData) {
    try { extraDataObj = JSON.parse(loaded.session.extraData); } catch {}
  }

  let pinnedMessagesObj: any[] = [];
  if (loaded.pinnedMessagesJson) {
    try { pinnedMessagesObj = JSON.parse(loaded.pinnedMessagesJson); } catch {}
  }

  let activePresetObj: any = undefined;
  if (loaded.session.activePreset) {
    try { activePresetObj = JSON.parse(loaded.session.activePreset); } catch {}
  }

  const exportData = {
    id: loaded.session.id,
    workingDirectory: loaded.session.workingDirectory,
    displayName: loaded.session.displayName,
    planState: loaded.session.planState,
    activePreset: activePresetObj,
    messages: loaded.messages.map(m => ({
      role: m.role,
      content: m.content.startsWith("[") || m.content.startsWith("{") ? (()=>{try{return JSON.parse(m.content);}catch{return m.content;}})() : m.content,
      toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined,
      toolResults: m.toolResults ? JSON.parse(m.toolResults) : undefined,
      reasoning: m.reasoning,
      timestamp: m.timestamp,
    })),
    pinnedMessages: pinnedMessagesObj,
    ...extraDataObj,
  };

  return JSON.stringify(exportData, null, 2);
}

export function backupDatabase(targetPath?: string): string {
  const dbPath = getHistoryDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error("No SQLite history database exists yet to backup.");
  }

  const backupPath = targetPath || path.join(path.dirname(dbPath), `history_backup_${Date.now()}.db`);
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

export interface DbCheckpointRecord {
  id: string;
  name: string;
  sessionId: string;
  sessionFilePath: string;
  timestamp: number;
  messagesJson: string;
  planState: string;
  planFileContent?: string;
  taskFileContent?: string;
  taskHistoryFileContent?: string;
  walkthroughFileContent?: string;
  gitSha?: string;
}

export function saveCheckpointToDb(cp: DbCheckpointRecord): void {
  const db = getHistoryDb();

  try {
    const sessionStmt = db.prepare(`
      INSERT INTO sessions (id, file_path, display_name, message_count, last_modified)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(id) DO NOTHING
    `);
    sessionStmt.run(cp.sessionId, cp.sessionFilePath, cp.sessionId, cp.timestamp);
  } catch {}

  const stmt = db.prepare(`
    INSERT INTO checkpoints (
      id, name, session_id, session_file_path, timestamp, messages_json, plan_state,
      plan_file_content, task_file_content, task_history_file_content, walkthrough_file_content, git_sha
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      session_id = excluded.session_id,
      session_file_path = excluded.session_file_path,
      timestamp = excluded.timestamp,
      messages_json = excluded.messages_json,
      plan_state = excluded.plan_state,
      plan_file_content = excluded.plan_file_content,
      task_file_content = excluded.task_file_content,
      task_history_file_content = excluded.task_history_file_content,
      walkthrough_file_content = excluded.walkthrough_file_content,
      git_sha = excluded.git_sha
  `);
  stmt.run(
    cp.id,
    cp.name,
    cp.sessionId,
    cp.sessionFilePath,
    cp.timestamp,
    cp.messagesJson,
    cp.planState || "IDLE",
    cp.planFileContent || null,
    cp.taskFileContent || null,
    cp.taskHistoryFileContent || null,
    cp.walkthroughFileContent || null,
    cp.gitSha || null
  );

  // Keep max 20 checkpoints per session in SQLite
  try {
    const pruneStmt = db.prepare(`
      DELETE FROM checkpoints WHERE id IN (
        SELECT id FROM checkpoints WHERE session_id = ? ORDER BY timestamp DESC LIMIT -1 OFFSET 20
      )
    `);
    pruneStmt.run(cp.sessionId);
  } catch {}
}

export function loadCheckpointFromDb(id: string): DbCheckpointRecord | null {
  const db = getHistoryDb();
  const stmt = db.prepare(`
    SELECT id, name, session_id as sessionId, session_file_path as sessionFilePath,
           timestamp, messages_json as messagesJson, plan_state as planState,
           plan_file_content as planFileContent, task_file_content as taskFileContent,
           task_history_file_content as taskHistoryFileContent, walkthrough_file_content as walkthroughFileContent,
           git_sha as gitSha
    FROM checkpoints WHERE id = ?
  `);
  const row = stmt.get(id) as DbCheckpointRecord | undefined;
  return row || null;
}

export function listCheckpointsFromDb(sessionId: string, limit: number = 50): DbCheckpointRecord[] {
  const db = getHistoryDb();
  const stmt = db.prepare(`
    SELECT id, name, session_id as sessionId, session_file_path as sessionFilePath,
           timestamp, messages_json as messagesJson, plan_state as planState,
           plan_file_content as planFileContent, task_file_content as taskFileContent,
           task_history_file_content as taskHistoryFileContent, walkthrough_file_content as walkthroughFileContent,
           git_sha as gitSha
    FROM checkpoints WHERE session_id = ? ORDER BY timestamp DESC LIMIT ?
  `);
  return (stmt.all(sessionId, limit) || []) as DbCheckpointRecord[];
}

export function deleteCheckpointFromDb(id: string): boolean {
  const db = getHistoryDb();
  const res = db.prepare("DELETE FROM checkpoints WHERE id = ?").run(id);
  return res && res.changes > 0;
}

export function deleteAllCheckpointsFromDb(sessionId: string): void {
  const db = getHistoryDb();
  db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(sessionId);
}

export function migrateLegacyCheckpointsToDb(): number {
  const configDir = getGlobalConfigDir();
  const historyBase = path.join(configDir, "history");
  if (!fs.existsSync(historyBase)) return 0;

  let importedCount = 0;
  const modes = ["single", "multi"];

  for (const mode of modes) {
    const modeDir = path.join(historyBase, mode);
    if (!fs.existsSync(modeDir)) continue;

    try {
      const dirs = fs.readdirSync(modeDir);
      for (const d of dirs) {
        const checkpointsDir = path.join(modeDir, d, "checkpoints");
        if (!fs.existsSync(checkpointsDir)) continue;

        try {
          const files = fs.readdirSync(checkpointsDir).filter(f => f.startsWith("checkpoint_") && f.endsWith(".json"));
          for (const f of files) {
            const filePath = path.join(checkpointsDir, f);
            try {
              const raw = fs.readFileSync(filePath, "utf-8");
              const parsed = JSON.parse(raw);
              if (!parsed || !parsed.id) continue;

              const existing = loadCheckpointFromDb(parsed.id);
              if (existing) continue;

              saveCheckpointToDb({
                id: parsed.id,
                name: parsed.name || parsed.id,
                sessionId: d,
                sessionFilePath: parsed.sessionFilePath || path.join(modeDir, d, `${d}.json`),
                timestamp: parsed.timestamp || Date.now(),
                messagesJson: JSON.stringify(parsed.messages || []),
                planState: parsed.planState || "IDLE",
                planFileContent: parsed.planFileContent,
                taskFileContent: parsed.taskFileContent,
                taskHistoryFileContent: parsed.taskHistoryFileContent,
                walkthroughFileContent: parsed.walkthroughFileContent,
                gitSha: parsed.gitSha,
              });
              importedCount++;
            } catch {}
          }
        } catch {}
      }
    } catch {}
  }

  return importedCount;
}

export function cleanLegacyCheckpointsFiles(): number {
  const configDir = getGlobalConfigDir();
  const historyBase = path.join(configDir, "history");
  if (!fs.existsSync(historyBase)) return 0;

  migrateLegacyCheckpointsToDb();

  let cleanedCount = 0;
  const modes = ["single", "multi"];

  for (const mode of modes) {
    const modeDir = path.join(historyBase, mode);
    if (!fs.existsSync(modeDir)) continue;

    try {
      const dirs = fs.readdirSync(modeDir);
      for (const d of dirs) {
        const checkpointsDir = path.join(modeDir, d, "checkpoints");
        if (!fs.existsSync(checkpointsDir)) continue;

        try {
          const files = fs.readdirSync(checkpointsDir);
          for (const f of files) {
            const filePath = path.join(checkpointsDir, f);
            try {
              fs.unlinkSync(filePath);
              cleanedCount++;
            } catch {}
          }
          try { fs.rmdirSync(checkpointsDir); } catch {}
        } catch {}
      }
    } catch {}
  }

  return cleanedCount;
}

export function vacuumDatabase(): void {
  try {
    const db = getHistoryDb();
    db.exec("PRAGMA incremental_vacuum(100);");
  } catch {}
}

export function performRollingBackup(maxBackups: number = 7): string | null {
  const dbPath = getHistoryDbPath();
  if (!fs.existsSync(dbPath)) return null;

  const configDir = getGlobalConfigDir();
  const backupDir = path.join(configDir, "backups");
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const timestamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const backupPath = path.join(backupDir, `history_backup_${timestamp}.db`);

  try {
    fs.copyFileSync(dbPath, backupPath);

    // Prune old backups keeping maxBackups newest
    const files = fs.readdirSync(backupDir).filter(f => f.startsWith("history_backup_") && f.endsWith(".db"));
    if (files.length > maxBackups) {
      const sorted = files.sort((a, b) => {
        const timeA = fs.statSync(path.join(backupDir, a)).mtimeMs;
        const timeB = fs.statSync(path.join(backupDir, b)).mtimeMs;
        return timeA - timeB; // oldest first
      });
      const toDelete = sorted.length - maxBackups;
      for (let i = 0; i < toDelete; i++) {
        try { fs.unlinkSync(path.join(backupDir, sorted[i])); } catch {}
      }
    }
    return backupPath;
  } catch {
    return null;
  }
}

export function getDatabaseStats(): {
  dbPath: string;
  dbSizeMb: number;
  sessionCount: number;
  messageCount: number;
  compactionCount: number;
  checkpointCount: number;
  journalMode: string;
  backupCount: number;
} {
  const dbPath = getHistoryDbPath();
  const db = getHistoryDb();

  let dbSizeMb = 0;
  try {
    if (fs.existsSync(dbPath)) {
      dbSizeMb = Number((fs.statSync(dbPath).size / (1024 * 1024)).toFixed(2));
    }
  } catch {}

  let sessionCount = 0;
  try { sessionCount = Number((db.prepare("SELECT COUNT(*) as count FROM sessions").get() as any)?.count || 0); } catch {}

  let messageCount = 0;
  try { messageCount = Number((db.prepare("SELECT COUNT(*) as count FROM messages").get() as any)?.count || 0); } catch {}

  let compactionCount = 0;
  try { compactionCount = Number((db.prepare("SELECT COUNT(*) as count FROM compaction_events").get() as any)?.count || 0); } catch {}

  let checkpointCount = 0;
  try { checkpointCount = Number((db.prepare("SELECT COUNT(*) as count FROM checkpoints").get() as any)?.count || 0); } catch {}

  let journalMode = "unknown";
  try { journalMode = String((db.prepare("PRAGMA journal_mode;").get() as any)?.journal_mode || "unknown"); } catch {}

  let backupCount = 0;
  try {
    const backupDir = path.join(getGlobalConfigDir(), "backups");
    if (fs.existsSync(backupDir)) {
      backupCount = fs.readdirSync(backupDir).filter(f => f.startsWith("history_backup_")).length;
    }
  } catch {}

  return {
    dbPath,
    dbSizeMb,
    sessionCount,
    messageCount,
    compactionCount,
    checkpointCount,
    journalMode,
    backupCount,
  };
}

export function tagSessionInDb(sessionId: string, tags: string): boolean {
  const db = getHistoryDb();
  try {
    const res = db.prepare("UPDATE sessions SET tags = ?, updated_at = ? WHERE id = ?").run(tags, Date.now(), sessionId);
    return res && res.changes > 0;
  } catch {
    return false;
  }
}

export function getSessionsByTagFromDb(tag: string): SessionRecord[] {
  const db = getHistoryDb();
  try {
    const stmt = db.prepare(`
      SELECT id, file_path as filePath, display_name as displayName, message_count as messageCount,
             last_modified as lastModified, preview, working_directory as workingDirectory,
             plan_state as planState, active_preset as activePreset, tags, workspace_id as workspaceId
      FROM sessions WHERE tags LIKE ? ORDER BY last_modified DESC
    `);
    return (stmt.all(`%${tag}%`) || []) as SessionRecord[];
  } catch {
    return [];
  }
}

export function saveInputHistoryToDb(workspaceId: string, command: string): void {
  const db = getHistoryDb();
  try {
    const stmt = db.prepare("INSERT INTO input_history (workspace_id, command, timestamp) VALUES (?, ?, ?)");
    stmt.run(workspaceId, command, Date.now());

    const pruneStmt = db.prepare(`
      DELETE FROM input_history WHERE id IN (
        SELECT id FROM input_history WHERE workspace_id = ? ORDER BY id DESC LIMIT -1 OFFSET 500
      )
    `);
    pruneStmt.run(workspaceId);
  } catch {}
}

export function getInputHistoryFromDb(workspaceId: string, limit: number = 100): string[] {
  const db = getHistoryDb();
  try {
    const stmt = db.prepare(`
      SELECT command FROM (
        SELECT id, command FROM input_history WHERE workspace_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `);
    const rows = stmt.all(workspaceId, limit) as Array<{ command: string }>;
    return rows.map((r) => r.command);
  } catch {
    return [];
  }
}

export function clearInputHistoryInDb(workspaceId: string): void {
  const db = getHistoryDb();
  try {
    db.prepare("DELETE FROM input_history WHERE workspace_id = ?").run(workspaceId);
  } catch {}
}

export function migrateLegacyInputHistoryToDb(): number {
  const configDir = getGlobalConfigDir();
  const workspacesDir = path.join(configDir, "workspaces");
  if (!fs.existsSync(workspacesDir)) return 0;

  let count = 0;
  try {
    const dirs = fs.readdirSync(workspacesDir);
    for (const wsId of dirs) {
      const historyFile = path.join(workspacesDir, wsId, "input-history.json");
      if (!fs.existsSync(historyFile)) continue;

      try {
        const raw = fs.readFileSync(historyFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const existing = getInputHistoryFromDb(wsId, 1);
          if (existing.length === 0) {
            for (const cmd of parsed) {
              if (typeof cmd === "string" && cmd.trim()) {
                saveInputHistoryToDb(wsId, cmd.trim());
                count++;
              }
            }
          }
        }
      } catch {}
    }
  } catch {}

  return count;
}

export function cleanLegacyInputHistoryFiles(): number {
  const configDir = getGlobalConfigDir();
  const workspacesDir = path.join(configDir, "workspaces");
  if (!fs.existsSync(workspacesDir)) return 0;

  migrateLegacyInputHistoryToDb();

  let cleaned = 0;
  try {
    const dirs = fs.readdirSync(workspacesDir);
    for (const wsId of dirs) {
      const historyFile = path.join(workspacesDir, wsId, "input-history.json");
      if (fs.existsSync(historyFile)) {
        try {
          fs.unlinkSync(historyFile);
          cleaned++;
        } catch {}
      }
    }
  } catch {}

  return cleaned;
}

export function closeHistoryDb(): void {
  const activeDb = dbInstance || (globalThis as any).__superagent_db_instance;
  if (activeDb) {
    if (typeof activeDb.close === "function") {
      try {
        activeDb.close();
      } catch (err) {}
    }
    dbInstance = null;
    delete (globalThis as any).__superagent_db_instance;
  }
}

export function saveModelCachesToDb(models: Record<string, number>): void {
  try {
    const db = getHistoryDb();
    const now = Date.now();
    db.exec("BEGIN;");
    try {
      const stmt = db.prepare(`
        INSERT INTO model_caches (id, context_limit, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET context_limit = excluded.context_limit, updated_at = excluded.updated_at
      `);
      for (const [id, limit] of Object.entries(models)) {
        stmt.run(id, limit, now);
      }
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  } catch {}
}


export function getModelCachesFromDb(): Record<string, number> {
  const result: Record<string, number> = {};
  try {
    const db = getHistoryDb();
    const rows = db.prepare("SELECT id, context_limit FROM model_caches").all();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && typeof row.id === "string" && typeof row.context_limit === "number") {
          result[row.id] = row.context_limit;
        }
      }
    }
  } catch {}
  return result;
}

export function deleteModelCachesFromDb(ids: string[]): void {
  try {
    const db = getHistoryDb();
    db.exec("BEGIN;");
    try {
      const stmt = db.prepare("DELETE FROM model_caches WHERE id = ?");
      for (const id of ids) {
        stmt.run(id);
      }
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
  } catch {}
}

export function saveToolSupportCacheToDb(modelId: string, supported: boolean): void {
  try {
    const db = getHistoryDb();
    const now = Date.now();
    const val = supported ? 1 : 0;
    db.prepare(`
      INSERT INTO tool_support_cache (model_id, supported, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(model_id) DO UPDATE SET supported = excluded.supported, updated_at = excluded.updated_at
    `).run(modelId, val, now);
  } catch {}
}

export function getToolSupportCacheFromDb(modelId: string, ttlMs: number): boolean | null {
  try {
    const db = getHistoryDb();
    const row = db.prepare("SELECT supported, updated_at FROM tool_support_cache WHERE model_id = ?").get(modelId);
    if (row && typeof row.updated_at === "number") {
      if (Date.now() - row.updated_at < ttlMs) {
        return row.supported === 1;
      }
    }
  } catch {}
  return null;
}

export function loadAllToolSupportCacheFromDb(ttlMs: number): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  try {
    const db = getHistoryDb();
    const rows = db.prepare("SELECT model_id, supported, updated_at FROM tool_support_cache").all();
    const now = Date.now();
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (row && typeof row.model_id === "string" && typeof row.updated_at === "number") {
          if (now - row.updated_at < ttlMs) {
            result[row.model_id] = row.supported === 1;
          }
        }
      }
    }
  } catch {}
  return result;
}

export function deleteAllToolSupportCacheFromDb(): void {
  try {
    const db = getHistoryDb();
    db.prepare("DELETE FROM tool_support_cache").run();
  } catch {}
}

export function getRateLimitStateFromDb(key: string): { tokensRemaining: number; lastUpdated: number } | null {
  try {
    const db = getHistoryDb();
    const row = db.prepare("SELECT tokens_remaining, last_updated FROM rate_limit_state WHERE key = ?").get(key);
    if (row && typeof row.tokens_remaining === "number" && typeof row.last_updated === "number") {
      return { tokensRemaining: row.tokens_remaining, lastUpdated: row.last_updated };
    }
  } catch {}
  return null;
}

export function saveRateLimitStateToDb(key: string, tokensRemaining: number, lastUpdated: number): void {
  try {
    const db = getHistoryDb();
    db.prepare(`
      INSERT INTO rate_limit_state (key, tokens_remaining, last_updated)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET tokens_remaining = excluded.tokens_remaining, last_updated = excluded.last_updated
    `).run(key, tokensRemaining, lastUpdated);
  } catch {}
}

export function savePinnedKnowledgeToDb(entry: any): void {
  try {
    const db = getHistoryDb();
    const workspaceId = entry.workingDirectory ? getWorkspaceId(entry.workingDirectory) : null;
    if (workspaceId && entry.workingDirectory) {
      try {
        const resolvedPath = (entry.workingDirectory.startsWith("ssh:") || entry.workingDirectory.startsWith("ssh://") || entry.workingDirectory.startsWith("chain:"))
          ? entry.workingDirectory
          : path.resolve(entry.workingDirectory);
        db.prepare(`
          INSERT INTO workspaces (id, path, name, is_trusted)
          VALUES (?, ?, ?, 0)
          ON CONFLICT(id) DO NOTHING
        `).run(workspaceId, resolvedPath, path.basename(resolvedPath));
      } catch {}
    }

    db.prepare(`
      INSERT INTO pinned_knowledge (
        id, content, role, agent_tag, tag, source_session_path, working_directory,
        pinned_at, timestamp, preview, tool_calls, tool_results, workspace_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        role = excluded.role,
        agent_tag = excluded.agent_tag,
        tag = excluded.tag,
        source_session_path = excluded.source_session_path,
        working_directory = excluded.working_directory,
        pinned_at = excluded.pinned_at,
        timestamp = excluded.timestamp,
        preview = excluded.preview,
        tool_calls = excluded.tool_calls,
        tool_results = excluded.tool_results,
        workspace_id = excluded.workspace_id
    `).run(
      entry.id,
      entry.content,
      entry.role,
      entry.agentTag ? JSON.stringify(entry.agentTag) : null,
      entry.tag || null,
      entry.sourceSessionPath,
      entry.workingDirectory,
      entry.pinnedAt,
      entry.timestamp,
      entry.preview,
      entry.toolCalls ? JSON.stringify(entry.toolCalls) : null,
      entry.toolResults ? JSON.stringify(entry.toolResults) : null,
      workspaceId
    );
  } catch {}
}

export function deletePinnedKnowledgeFromDb(id: string): void {
  try {
    const db = getHistoryDb();
    db.prepare("DELETE FROM pinned_knowledge WHERE id = ?").run(id);
  } catch {}
}

export function deletePinnedKnowledgeByPinFromDb(sourceSessionPath: string, contentPreview: string): void {
  try {
    const db = getHistoryDb();
    const preview = contentPreview.substring(0, 200);
    db.prepare("DELETE FROM pinned_knowledge WHERE source_session_path = ? AND preview = ?").run(sourceSessionPath, preview);
  } catch {}
}

export function updatePinnedKnowledgeTagInDb(sourceSessionPath: string, contentPreview: string, tag: string): void {
  try {
    const db = getHistoryDb();
    const preview = contentPreview.substring(0, 200);
    db.prepare("UPDATE pinned_knowledge SET tag = ? WHERE source_session_path = ? AND preview = ?").run(tag || null, sourceSessionPath, preview);
  } catch {}
}

export function deleteSessionFromPinnedKnowledgeDb(sourceSessionPath: string): number {
  try {
    const db = getHistoryDb();
    const stmt = db.prepare("DELETE FROM pinned_knowledge WHERE source_session_path = ?");
    const info = stmt.run(sourceSessionPath);
    return info.changes || 0;
  } catch {
    return 0;
  }
}

export function getAllPinnedKnowledgeFromDb(): any[] {
  try {
    const db = getHistoryDb();
    const rows = db.prepare("SELECT * FROM pinned_knowledge").all() || [];
    return rows.map((row: any) => ({
      id: row.id,
      content: row.content,
      role: row.role,
      agentTag: row.agent_tag ? JSON.parse(row.agent_tag) : undefined,
      tag: row.tag || undefined,
      sourceSessionPath: row.source_session_path,
      workingDirectory: row.working_directory,
      pinnedAt: row.pinned_at,
      timestamp: row.timestamp,
      preview: row.preview,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results) : undefined,
      workspaceId: row.workspace_id || undefined,
    }));
  } catch {
    return [];
  }
}

export function saveWorkspaceTaskToDb(workspaceId: string, task: any): void {
  try {
    const db = getHistoryDb();
    db.prepare(`
      INSERT INTO workspace_tasks (
        workspace_id, task_id, command, pid, log_path, is_detached_window, window_label,
        auto_retry, on_exit, has_exited, exit_code, completed_at, is_hidden, cwd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, task_id) DO UPDATE SET
        command = excluded.command,
        pid = excluded.pid,
        log_path = excluded.log_path,
        is_detached_window = excluded.is_detached_window,
        window_label = excluded.window_label,
        auto_retry = excluded.auto_retry,
        on_exit = excluded.on_exit,
        has_exited = excluded.has_exited,
        exit_code = excluded.exit_code,
        completed_at = excluded.completed_at,
        is_hidden = excluded.is_hidden,
        cwd = excluded.cwd
    `).run(
      workspaceId,
      task.id,
      task.command,
      task.pid,
      task.logPath || null,
      task.isDetachedWindow ? 1 : 0,
      task.windowLabel || null,
      task.autoRetry ? 1 : 0,
      task.onExit || null,
      task.hasExited ? 1 : 0,
      task.exitCode !== undefined ? task.exitCode : null,
      task.completedAt || null,
      task.isHidden ? 1 : 0,
      task.cwd || null
    );
  } catch {}
}

export function getWorkspaceTasksFromDb(workspaceId: string): any[] {
  try {
    const db = getHistoryDb();
    const rows = db.prepare("SELECT * FROM workspace_tasks WHERE workspace_id = ?").all(workspaceId) || [];
    return rows.map((row: any) => ({
      id: row.task_id,
      command: row.command,
      pid: row.pid,
      logPath: row.log_path || undefined,
      isDetachedWindow: row.is_detached_window === 1,
      windowLabel: row.window_label || undefined,
      autoRetry: row.auto_retry === 1,
      onExit: row.on_exit || undefined,
      hasExited: row.has_exited === 1,
      exitCode: row.exit_code !== null ? row.exit_code : undefined,
      completedAt: row.completed_at || undefined,
      isHidden: row.is_hidden === 1,
      cwd: row.cwd || undefined,
    }));
  } catch {
    return [];
  }
}

export function deleteWorkspaceTaskFromDb(workspaceId: string, taskId: string): void {
  try {
    const db = getHistoryDb();
    db.prepare("DELETE FROM workspace_tasks WHERE workspace_id = ? AND task_id = ?").run(workspaceId, taskId);
  } catch {}
}

export function deleteWorkspaceDataFromDb(workspaceId: string): void {
  try {
    const db = getHistoryDb();
    db.prepare("DELETE FROM workspace_tasks WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM input_history WHERE workspace_id = ?").run(workspaceId);
    db.prepare("DELETE FROM workspaces WHERE id = ?").run(workspaceId);

    try {
      const cachePath = path.join(getRootConfigDir(), "workspace-caches", `${workspaceId}.json`);
      if (fs.existsSync(cachePath)) {
        fs.rmSync(cachePath, { force: true });
      }
    } catch {}
  } catch {}
}

export interface WorkspaceRecord {
  id: string;
  path: string;
  name?: string;
  isTrusted: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export function saveWorkspaceToDb(workspace: WorkspaceRecord): void {
  try {
    const db = getHistoryDb();
    const now = Date.now();
    
    // Determine the name to save:
    // 1. If explicitly provided, use it.
    // 2. If it already exists in the DB, preserve it.
    // 3. Otherwise, default to path.basename.
    let name = workspace.name;
    if (name === undefined) {
      try {
        const existing = db.prepare("SELECT name FROM workspaces WHERE id = ?").get(workspace.id);
        if (existing) {
          name = existing.name;
        }
      } catch {}
      if (name === undefined) {
        name = path.basename(workspace.path);
      }
    }

    db.prepare(`
      INSERT INTO workspaces (id, path, name, is_trusted, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        path = excluded.path,
        name = excluded.name,
        is_trusted = excluded.is_trusted,
        updated_at = excluded.updated_at
    `).run(workspace.id, workspace.path, name || null, workspace.isTrusted ? 1 : 0, now);
  } catch {}
}

export function getWorkspacesFromDb(): WorkspaceRecord[] {
  try {
    const db = getHistoryDb();
    const rows = db.prepare("SELECT * FROM workspaces").all() || [];
    return rows.map((row: any) => ({
      id: row.id,
      path: row.path,
      name: row.name || undefined,
      isTrusted: row.is_trusted === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  } catch {
    return [];
  }
}

export function getWorkspaceFromDb(id: string): WorkspaceRecord | null {
  try {
    const db = getHistoryDb();
    const row = db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    if (row) {
      return {
        id: row.id,
        path: row.path,
        name: row.name || undefined,
        isTrusted: row.is_trusted === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    }
  } catch {}
  return null;
}

export function deleteWorkspaceFromDb(idOrPath: string): void {
  try {
    const db = getHistoryDb();
    const resolved = (idOrPath.startsWith("ssh:") || idOrPath.startsWith("ssh://") || idOrPath.startsWith("chain:")) ? idOrPath : path.resolve(idOrPath);
    const normalized = (process.platform === "win32" && !resolved.startsWith("ssh:") && !resolved.startsWith("ssh://") && !resolved.startsWith("chain:") && /^[a-z]:/i.test(resolved))
      ? resolved[0].toUpperCase() + resolved.slice(1)
      : resolved;
    const id = getWorkspaceId(normalized);

    if (process.platform === "win32") {
      db.prepare("DELETE FROM workspaces WHERE id = ? OR id = ? OR LOWER(path) = LOWER(?) OR LOWER(path) = LOWER(?)").run(id, idOrPath, normalized, idOrPath);
    } else {
      db.prepare("DELETE FROM workspaces WHERE id = ? OR id = ? OR path = ? OR path = ?").run(id, idOrPath, normalized, idOrPath);
    }
  } catch {}
}

export function migrateLegacyTrustedDirs(db: any): void {
  try {
    const configPath = getModelConfigPath();
    if (!fs.existsSync(configPath)) return;
    const content = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content);
    if (parsed && Array.isArray(parsed.trustedDirectories)) {
      for (const dir of parsed.trustedDirectories) {
        if (typeof dir === "string" && dir.trim()) {
          const resolved = path.resolve(dir);
          const id = getWorkspaceId(resolved);
          try {
            db.prepare(`
              INSERT INTO workspaces (id, path, name, is_trusted, created_at, updated_at)
              VALUES (?, ?, ?, 1, ?, ?)
              ON CONFLICT(id) DO NOTHING
            `).run(id, resolved, path.basename(resolved), Date.now(), Date.now());
          } catch {}
        }
      }
      // Remove trustedDirectories from configuration once migrated to SQLite
      try {
        delete parsed.trustedDirectories;
        fs.writeFileSync(configPath, JSON.stringify(parsed, null, 2), "utf-8");
      } catch {}
    }
  } catch {}
}

export interface LockEventDetails {
  projectPath?: string;
  lineRange?: { startLine: number; endLine: number } | null;
  ttlMs?: number;
  isIntentSoftLock?: boolean;
  remoteNodeId?: string;
  lockedAt?: number;
  releasedAt?: number;
  forceUnlock?: boolean;
  details?: string;
}

export function recordLockEvent(
  filePath: string,
  sessionId: string,
  terminalType: string = "cli",
  eventType: "acquired" | "conflict_blocked" | "released" | "soft_locked" | "lock_updated" | "deadlock_recovered",
  opts: LockEventDetails = {}
) {
  try {
    const db = getHistoryDb();
    const now = Date.now();
    const lineRangeStr = opts.lineRange ? `${opts.lineRange.startLine}-${opts.lineRange.endLine}` : null;
    db.prepare(`
      INSERT INTO file_lock_events (
        file_path, session_id, terminal_type, event_type, created_at,
        project_path, line_range, ttl_ms, is_intent_soft_lock, remote_node_id,
        locked_at, released_at, force_unlock, details
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      filePath,
      sessionId,
      terminalType,
      eventType,
      now,
      opts.projectPath || null,
      lineRangeStr,
      opts.ttlMs ?? null,
      opts.isIntentSoftLock ? 1 : 0,
      opts.remoteNodeId || null,
      opts.lockedAt ?? null,
      opts.releasedAt ?? null,
      opts.forceUnlock ? 1 : 0,
      opts.details || null
    );
  } catch {}
}

export function getLockEventHistoryFromDb(limit: number = 100): Array<{
  id: number;
  filePath: string;
  sessionId: string;
  terminalType: string | null;
  eventType: string;
  createdAt: number;
  projectPath: string | null;
  lineRange: string | null;
  ttlMs: number | null;
  isIntentSoftLock: boolean;
  remoteNodeId: string | null;
  lockedAt: number | null;
  releasedAt: number | null;
  forceUnlock: boolean;
  details: string | null;
}> {
  try {
    const db = getHistoryDb();
    const rows = db.prepare(`
      SELECT id, file_path as filePath, session_id as sessionId, terminal_type as terminalType,
             event_type as eventType, created_at as createdAt, project_path as projectPath,
             line_range as lineRange, ttl_ms as ttlMs, is_intent_soft_lock as isIntentSoftLock,
             remote_node_id as remoteNodeId, locked_at as lockedAt, released_at as releasedAt,
             force_unlock as forceUnlock, details
      FROM file_lock_events ORDER BY id DESC LIMIT ?
    `).all(limit) || [];
    return rows.map((row: any) => ({
      id: row.id,
      filePath: row.filePath,
      sessionId: row.sessionId,
      terminalType: row.terminalType,
      eventType: row.eventType,
      createdAt: row.createdAt,
      projectPath: row.projectPath,
      lineRange: row.lineRange,
      ttlMs: row.ttlMs,
      isIntentSoftLock: row.isIntentSoftLock === 1,
      remoteNodeId: row.remoteNodeId,
      lockedAt: row.lockedAt,
      releasedAt: row.releasedAt,
      forceUnlock: row.forceUnlock === 1,
      details: row.details,
    }));
  } catch {
    return [];
  }
}


