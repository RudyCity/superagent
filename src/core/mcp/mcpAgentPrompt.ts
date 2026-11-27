/**
 * Operator-authored knowledge prompt advertised to external MCP clients at the
 * start of a session (MCP initialize handshake).
 *
 * This text is guidance only. It explains which tools are worth inspecting
 * first, project context and access limits, but it never grants permissions:
 * OAuth scopes, Security Approval grants, project grants and the host file
 * policy remain authoritative for every tool call.
 */
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";

export const MCP_AGENT_PROMPT_MAX_CHARS = 6000;
export const MCP_AGENT_PROMPT_MAX_HISTORY = 10;
const FILE_NAME = "mcp-agent-prompt.json";
// Ten retained versions of at most 6000 characters each, plus JSON overhead.
const MAX_FILE_BYTES = 256 * 1024;
// Keep tab/newline, drop every other C0/C1 control character and DEL.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export interface McpAgentPromptHistoryEntry {
  /** Epoch milliseconds of the save that produced this prompt. */
  at: number;
  /** Prompt length in characters (not bytes). */
  length: number;
  /** Full text of that version, so the operator can restore or diff it. */
  prompt: string;
}

export interface McpAgentPromptState {
  prompt: string;
  updatedAt: number | null;
  /** Newest first, bounded to MCP_AGENT_PROMPT_MAX_HISTORY. */
  history: McpAgentPromptHistoryEntry[];
}

export function getMcpAgentPromptPath(): string {
  return path.join(getRootConfigDir(), FILE_NAME);
}

/**
 * Normalize operator input: CRLF to LF, control characters removed, trailing
 * spaces trimmed per line. Throws when the result exceeds the documented cap so
 * the caller can surface a precise validation error instead of truncating.
 */
export function sanitizeMcpAgentPrompt(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("MCP_AGENT_PROMPT_INVALID");
  }
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
  if (normalized.length > MCP_AGENT_PROMPT_MAX_CHARS) {
    throw new Error("MCP_AGENT_PROMPT_TOO_LONG");
  }
  return normalized;
}

function readHistory(value: unknown): McpAgentPromptHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: McpAgentPromptHistoryEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.at !== "number" || !Number.isFinite(record.at) || record.at <= 0) continue;
    if (typeof record.length !== "number" || !Number.isInteger(record.length) ||
        record.length < 0 || record.length > MCP_AGENT_PROMPT_MAX_CHARS) continue;
    if (typeof record.prompt !== "string") continue;
    let prompt: string;
    try {
      prompt = sanitizeMcpAgentPrompt(record.prompt);
    } catch {
      // A historical version that no longer validates is dropped, never guessed.
      continue;
    }
    entries.push({ at: record.at, length: record.length, prompt });
    if (entries.length >= MCP_AGENT_PROMPT_MAX_HISTORY) break;
  }
  return entries;
}

export function readMcpAgentPrompt(): McpAgentPromptState {
  try {
    const file = getMcpAgentPromptPath();
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) {
      return { prompt: "", updatedAt: null, history: [] };
    }
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { prompt: "", updatedAt: null, history: [] };
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return { prompt: "", updatedAt: null, history: [] };
    const prompt = sanitizeMcpAgentPrompt(record.prompt ?? "");
    const updatedAt = typeof record.updatedAt === "number" &&
      Number.isFinite(record.updatedAt) && record.updatedAt > 0
      ? record.updatedAt
      : null;
    return { prompt, updatedAt, history: readHistory(record.history) };
  } catch {
    // Missing or unreadable state never blocks an MCP session.
    return { prompt: "", updatedAt: null, history: [] };
  }
}

/**
 * Persist the global prompt. New MCP sessions read it on initialize; running
 * owners must be reloaded separately so connected clients reconnect.
 */
export function saveMcpAgentPrompt(value: unknown): {
  prompt: string;
  length: number;
  updatedAt: number;
  history: McpAgentPromptHistoryEntry[];
} {
  const prompt = sanitizeMcpAgentPrompt(value);
  const updatedAt = Date.now();
  const previous = readMcpAgentPrompt();
  const history = prompt === previous.prompt
    ? previous.history
    : [{ at: updatedAt, length: prompt.length, prompt }, ...previous.history]
      .slice(0, MCP_AGENT_PROMPT_MAX_HISTORY);
  const target = getMcpAgentPromptPath();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${updatedAt}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      JSON.stringify({ version: 1, prompt, updatedAt, history }, null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    fs.renameSync(temporary, target);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
  return { prompt, length: prompt.length, updatedAt, history };
}
