import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getRootConfigDir } from "../config/paths.js";

interface SqlStatement {
  run(...params: any[]): any;
  get(...params: any[]): any;
  all(...params: any[]): any[];
}
interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export interface DelegateIndexedMessage {
  index: number;
  role: string;
  text: string;
  text_truncated?: boolean;
}
export interface DelegateIndexedChat {
  chat_id: string;
  title: string;
  url: string;
  messages: DelegateIndexedMessage[];
  availability?: "ok" | "unavailable";
}
export interface DelegateIndexStats {
  path: string;
  profiles: number;
  chats: number;
  messages: number;
  lastIndexedAt: number | null;
}
export interface DelegateIndexSearchResult {
  chat_id: string;
  title: string;
  url: string;
  availability: string;
  message_count: number;
  indexed_at: number;
  last_seen_at: number;
  title_match: boolean;
  snippet: string;
  role: string | null;
  message_index: number | null;
}

function openSqlite(filename: string): SqlDatabase {
  if (process.versions.bun) {
    const { Database } = require("bun:sqlite");
    return new Database(filename, { create: true }) as SqlDatabase;
  }
  const { DatabaseSync } = require("node:sqlite");
  return new DatabaseSync(filename) as SqlDatabase;
}

export function getDelegateHistoryIndexPath(): string {
  return path.join(getRootConfigDir(), "delegate", "history-index.sqlite");
}

function normalizeProfileId(profileId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(profileId)) {
    throw new Error("DELEGATE_INVALID_CLIENT_ID: history index requires a valid Delegate clientId");
  }
  return profileId;
}

function normalizeChatId(chatId: string): string {
  if (!/^[a-zA-Z0-9:_-]{8,180}$/.test(chatId)) {
    throw new Error("DELEGATE_INVALID_CHAT_ID: history index requires a valid chatId");
  }
  return chatId;
}

function clipText(text: unknown, max = 120_000): string {
  return String(text ?? "").replace(/\u0000/g, "").slice(0, max);
}

function contentHash(chat: DelegateIndexedChat): string {
  return createHash("sha256").update(JSON.stringify({
    title: chat.title,
    availability: chat.availability || "ok",
    messages: chat.messages.map(message => [
      message.index, message.role, message.text, !!message.text_truncated,
    ]),
  })).digest("hex");
}

function snippetAround(text: string, query: string): string {
  const clean = clipText(text, 120_000);
  const lower = clean.toLowerCase();
  const needle = query.toLowerCase();
  const position = lower.indexOf(needle);
  if (position < 0) return clean.slice(0, 420);
  const start = Math.max(0, position - 180);
  const end = Math.min(clean.length, position + needle.length + 220);
  return clean.slice(start, end);
}

export class DelegateHistoryIndex {
  readonly filename: string;
  private readonly db: SqlDatabase;

  constructor(filename = getDelegateHistoryIndexPath()) {
    this.filename = path.resolve(filename);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.db = openSqlite(this.filename);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=3000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delegate_chats (
        profile_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        availability TEXT NOT NULL DEFAULT 'ok',
        content_hash TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        indexed_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        PRIMARY KEY (profile_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS delegate_messages (
        profile_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_index INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        text_truncated INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (profile_id, chat_id, message_index)
      );
      CREATE INDEX IF NOT EXISTS delegate_messages_chat
        ON delegate_messages(profile_id, chat_id, message_index);
      CREATE INDEX IF NOT EXISTS delegate_chats_seen
        ON delegate_chats(profile_id, last_seen_at DESC);
    `);
  }

  close(): void {
    this.db.close();
  }

  getChat(profileId: string, chatId: string): {
    content_hash: string;
    indexed_at: number;
    last_seen_at: number;
    message_count: number;
    availability: string;
  } | null {
    profileId = normalizeProfileId(profileId);
    chatId = normalizeChatId(chatId);
    const row = this.db.prepare(`
      SELECT content_hash, indexed_at, last_seen_at, message_count, availability
      FROM delegate_chats WHERE profile_id=? AND chat_id=?
    `).get(profileId, chatId);
    return row ? {
      content_hash: String(row.content_hash),
      indexed_at: Number(row.indexed_at),
      last_seen_at: Number(row.last_seen_at),
      message_count: Number(row.message_count),
      availability: String(row.availability),
    } : null;
  }

  markSeen(profileId: string, chatId: string, seenAt = Date.now()): void {
    profileId = normalizeProfileId(profileId);
    chatId = normalizeChatId(chatId);
    this.db.prepare(`
      UPDATE delegate_chats SET last_seen_at=? WHERE profile_id=? AND chat_id=?
    `).run(seenAt, profileId, chatId);
  }

  upsertChat(profileId: string, chat: DelegateIndexedChat, now = Date.now()): {
    changed: boolean;
    hash: string;
  } {
    profileId = normalizeProfileId(profileId);
    const chatId = normalizeChatId(chat.chat_id);
    const normalized: DelegateIndexedChat = {
      chat_id: chatId,
      title: clipText(chat.title, 2_000),
      url: clipText(chat.url, 2_000),
      availability: chat.availability === "unavailable" ? "unavailable" : "ok",
      messages: (chat.messages || []).slice(0, 5_000).map((message, index) => ({
        index: Number.isSafeInteger(message.index) && message.index >= 0 ? message.index : index,
        role: clipText(message.role, 32) || "unknown",
        text: clipText(message.text),
        text_truncated: !!message.text_truncated,
      })),
    };
    const hash = contentHash(normalized);
    const previous = this.getChat(profileId, chatId);
    const changed = previous?.content_hash !== hash;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO delegate_chats (
          profile_id, chat_id, title, url, availability, content_hash,
          message_count, indexed_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, chat_id) DO UPDATE SET
          title=excluded.title,
          url=excluded.url,
          availability=excluded.availability,
          content_hash=excluded.content_hash,
          message_count=excluded.message_count,
          indexed_at=excluded.indexed_at,
          last_seen_at=excluded.last_seen_at
      `).run(
        profileId, chatId, normalized.title, normalized.url,
        normalized.availability, hash, normalized.messages.length, now, now,
      );
      if (changed) {
        this.db.prepare(`
          DELETE FROM delegate_messages WHERE profile_id=? AND chat_id=?
        `).run(profileId, chatId);
        const insert = this.db.prepare(`
          INSERT INTO delegate_messages (
            profile_id, chat_id, message_index, role, text, text_truncated
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const message of normalized.messages) {
          insert.run(
            profileId, chatId, message.index, message.role, message.text,
            message.text_truncated ? 1 : 0,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return { changed, hash };
  }

  stats(profileId?: string): DelegateIndexStats {
    const where = profileId ? " WHERE profile_id=?" : "";
    const args = profileId ? [normalizeProfileId(profileId)] : [];
    const chatRow = this.db.prepare(`
      SELECT COUNT(*) AS chats, MAX(indexed_at) AS lastIndexedAt
      FROM delegate_chats${where}
    `).get(...args) || {};
    const messageRow = this.db.prepare(`
      SELECT COUNT(*) AS messages FROM delegate_messages${where}
    `).get(...args) || {};
    const profileRow = this.db.prepare(`
      SELECT COUNT(DISTINCT profile_id) AS profiles FROM delegate_chats
    `).get() || {};
    return {
      path: this.filename,
      profiles: Number(profileRow.profiles || 0),
      chats: Number(chatRow.chats || 0),
      messages: Number(messageRow.messages || 0),
      lastIndexedAt: chatRow.lastIndexedAt == null ? null : Number(chatRow.lastIndexedAt),
    };
  }

  search(profileId: string, query: string, limit = 20): DelegateIndexSearchResult[] {
    profileId = normalizeProfileId(profileId);
    const cleanQuery = String(query || "").trim().slice(0, 500);
    if (!cleanQuery) throw new Error("DELEGATE_INVALID_QUERY: query must be nonempty");
    limit = Math.min(Math.max(Number(limit) || 20, 1), 50);

    const chats = this.db.prepare(`
      SELECT c.chat_id, c.title, c.url, c.availability, c.message_count,
             c.indexed_at, c.last_seen_at
      FROM delegate_chats c
      WHERE c.profile_id=? AND (
        instr(lower(c.title), lower(?)) > 0 OR EXISTS (
          SELECT 1 FROM delegate_messages m
          WHERE m.profile_id=c.profile_id AND m.chat_id=c.chat_id
            AND instr(lower(m.text), lower(?)) > 0
        )
      )
      ORDER BY c.last_seen_at DESC, c.indexed_at DESC
      LIMIT ?
    `).all(profileId, cleanQuery, cleanQuery, limit);

    const firstMessage = this.db.prepare(`
      SELECT message_index, role, text FROM delegate_messages
      WHERE profile_id=? AND chat_id=? AND instr(lower(text), lower(?)) > 0
      ORDER BY message_index ASC LIMIT 1
    `);
    return chats.map(row => {
      const title = String(row.title || "");
      const match = firstMessage.get(profileId, String(row.chat_id), cleanQuery);
      return {
        chat_id: String(row.chat_id),
        title,
        url: String(row.url || ""),
        availability: String(row.availability || "ok"),
        message_count: Number(row.message_count || 0),
        indexed_at: Number(row.indexed_at || 0),
        last_seen_at: Number(row.last_seen_at || 0),
        title_match: title.toLowerCase().includes(cleanQuery.toLowerCase()),
        snippet: match ? snippetAround(String(match.text || ""), cleanQuery) : "",
        role: match ? String(match.role || "unknown") : null,
        message_index: match ? Number(match.message_index) : null,
      };
    });
  }
}
