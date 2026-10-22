import { createHash } from "node:crypto";
import path from "node:path";
import { getHistoryDb } from "../storage/historyDb.js";

export interface ToolEvidence {
  kind: "json" | "text";
  status?: string;
  paths: string[];
  messages: string[];
  counts: string[];
  tail: string[];
}

const MAX_ARCHIVE = 2 * 1024 * 1024;
const MAX_ENTRIES = 40;
const REDACTED_KEYS = /(?:api.?key|token|secret|password|authorization|cookie|credential|private.?key)/i;
const EVIDENCE_KEYS = /^(?:status|success|ok|error|errors|warning|warnings|message|reason|code|exitCode|path|file|files|changed|modified|created|deleted|count|total|tests|passed|failed)$/i;
const PATH_LIKE = /(?:^|[\s"'(])(?:[\w.-]+[/\\]){1,10}[\w.-]+/;

const asLine = (input: unknown): string => String(input == null ? "" : typeof input === "string" ? input : JSON.stringify(input))
  .replace(/\s+/g, " ").slice(0, 180);

/** Summarize existing tool observations, never invent success or authority. */
export function extractToolEvidence(output: string): ToolEvidence {
  const out: ToolEvidence = { kind: "text", paths: [], messages: [], counts: [], tail: [] };
  const trimmed = output.trimStart();
  if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && output.length < 2_000_000) {
    try {
      const json = JSON.parse(trimmed);
      out.kind = "json";
      const visit = (obj: unknown, depth: number) => {
        if (!obj || typeof obj !== "object" || depth > 2) return;
        if (Array.isArray(obj)) {
          for (const value of obj.slice(0, 4)) visit(value, depth + 1);
          return;
        }
        for (const [key, value] of Object.entries(obj).slice(0, 32)) {
          if (REDACTED_KEYS.test(key)) continue;
          if (typeof value === "object") {
            if (EVIDENCE_KEYS.test(key)) visit(value, depth + 1);
            continue;
          }
          if (!EVIDENCE_KEYS.test(key)) continue;
          const entry = key + ": " + asLine(value);
          if (/^(?:status|success|ok)$/i.test(key)) out.status = entry;
          else if (/^(?:code|exitCode)$/i.test(key)) { if (!out.status) out.status = entry; else out.counts.push(entry); }
          else if (/^(?:count|total|tests|passed|failed)$/i.test(key)) out.counts.push(entry);
          else if (/^(?:path|file|files|changed|modified|created|deleted)$/i.test(key)) out.paths.push(entry);
          else out.messages.push(entry);
        }
      };
      visit(json, 0);
    } catch { /* read as plain text instead */ }
  }
  const lines = output.slice(0, 750_000).split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.length > 3000 || REDACTED_KEYS.test(l)) continue;
    if (/^(?:exit code|status|result|error code)\s*:/i.test(l) && !out.status) out.status = asLine(l);
    if (PATH_LIKE.test(l) && out.paths.length < 6) out.paths.push(asLine(l));
    if (/(?:\b(error|failed|exception|warning|succeeded|passed|tests?)\b|^\s*[-+]\s+\S)/i.test(l)
      && out.messages.length < 9) out.messages.push(asLine(l));
  }
  out.tail = output.slice(-2000).split(/\r?\n/).slice(-2).filter(Boolean).map(asLine);
  return out;
}

export function formatToolEvidence(output: string, name: string, isError: boolean, maxChars = 900, archiveId?: string): string {
  if (output.length <= maxChars) return output;
  const data = extractToolEvidence(output);
  const budget = Math.max(100, maxChars - 160);
  const facts = [
    "Tool: " + name + (isError ? " (error)" : ""),
    "Format: " + data.kind,
    ...(data.status ? [data.status] : []),
    ...data.counts.slice(0, 3),
    ...data.paths.slice(0, 5),
    ...data.messages.slice(0, 8),
    ...data.tail.slice(-2),
  ];
  const unique = [...new Set(facts)].join("\n").slice(0, budget);
  const archive = archiveId ? "; /compact tool " + archiveId + " [offset] to inspect original" : "; original may be unavailable";
  return unique + "\n[truncated — structured tool result: " + output.length + " characters" + archive + "]";
}

/** Store original output in session-scoped SQLite; no project-global plaintext archives. */
export function archiveToolOutput(sessionPath: string, output: string, name: string, isError: boolean): string | undefined {
  if (!sessionPath || output.length < 800 || Buffer.byteLength(output, "utf8") > 512 * 1024) return undefined;
  const sessionId = createHash("sha256").update(path.resolve(sessionPath).toLowerCase()).digest("hex").slice(0, 32);
  if (!sessionId) return undefined;
  const id = createHash("sha256").update(name + "\0" + output).digest("hex").slice(0, 24);
  try {
    const db = getHistoryDb();
    db.exec("CREATE TABLE IF NOT EXISTS compaction_tool_archive (session_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, is_error INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(session_id,id))");
    db.prepare("INSERT OR IGNORE INTO compaction_tool_archive (session_id,id,name,is_error,body,created_at) VALUES (?,?,?,?,?,?)")
      .run(sessionId, id, name.slice(0, 128), isError ? 1 : 0, output, Date.now());
    db.prepare("DELETE FROM compaction_tool_archive WHERE created_at < ?")
      .run(Date.now() - 30 * 86400_000);
    db.prepare("DELETE FROM compaction_tool_archive WHERE session_id=? AND id NOT IN (SELECT id FROM compaction_tool_archive WHERE session_id=? ORDER BY created_at DESC LIMIT ?)")
      .run(sessionId, sessionId, MAX_ENTRIES);
    return id;
  } catch { return undefined; }
}

export function readArchivedToolOutput(sessionPath: string, id: string, offset = 0, pageSize = 3000):
  { name: string; text: string; totalChars: number; nextOffset: number | null } | undefined {
  if (!sessionPath || !/^[a-f0-9]{24}$/.test(id)) return undefined;
  const sessionId = createHash("sha256").update(path.resolve(sessionPath).toLowerCase()).digest("hex").slice(0, 32);
  try {
    const db = getHistoryDb();
    const row = db.prepare("SELECT name,body FROM compaction_tool_archive WHERE session_id=? AND id=?")
      .get(sessionId, id) as { name: string; body: string } | undefined;
    if (!row) return undefined;
    const at = Math.max(0, Math.min(Math.floor(offset), row.body.length));
    const end = Math.min(row.body.length, at + Math.min(Math.max(200, pageSize), 5000));
    return { name: row.name, text: row.body.slice(at, end), totalChars: row.body.length,
      nextOffset: end < row.body.length ? end : null };
  } catch { return undefined; }
}
