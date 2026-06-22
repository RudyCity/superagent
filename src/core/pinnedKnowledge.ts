/**
 * Global Pinned Knowledge Store
 *
 * Stores pinned messages from ALL sessions in a central index file so that
 * AI agents in any session can discover and learn from past conversations.
 *
 * File location: ~/.superagent-r/pinned-knowledge.json
 */
import fs from "fs";
import path from "path";
import { getRootConfigDir, ensureGlobalConfigDir } from "./config/paths.js";
import type { PinnedMessage, AgentTag } from "./context/ContextManager.js";

export interface KnowledgeEntry {
  /** Unique ID for this knowledge entry */
  id: string;
  /** Full message content (un-truncated) */
  content: string;
  /** Message role */
  role: string;
  /** Agent metadata */
  agentTag?: AgentTag;
  /** User-defined tag/label */
  tag?: string;
  /** Absolute path to the source session JSON file */
  sourceSessionPath: string;
  /** Working directory of the source session */
  workingDirectory: string;
  /** When the message was pinned */
  pinnedAt: number;
  /** Original message timestamp */
  timestamp: number;
  /** Short summary (first 200 chars) for quick scanning */
  preview: string;
  /** Tool calls associated with the message */
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  /** Tool results associated with the message */
  toolResults?: Array<{ toolCallId: string; name: string; result: string; isError?: boolean }>;
}

interface KnowledgeStore {
  version: number;
  entries: KnowledgeEntry[];
}

const STORE_VERSION = 1;
const MAX_ENTRIES = 500; // Safety limit to prevent unbounded growth

function getKnowledgePath(): string {
  return path.join(getRootConfigDir(), "pinned-knowledge.json");
}

function readStore(): KnowledgeStore {
  const filePath = getKnowledgePath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        return parsed as KnowledgeStore;
      }
    }
  } catch {
    // Corrupted file — start fresh
  }
  return { version: STORE_VERSION, entries: [] };
}

function writeStore(store: KnowledgeStore): void {
  try {
    ensureGlobalConfigDir();
    const filePath = getKnowledgePath();
    // Enforce max entries (remove oldest)
    if (store.entries.length > MAX_ENTRIES) {
      store.entries.sort((a, b) => b.pinnedAt - a.pinnedAt);
      store.entries = store.entries.slice(0, MAX_ENTRIES);
    }
    fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write pinned knowledge store:", err);
  }
}

function generateId(): string {
  return `pk-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Add a pinned message to the global knowledge store.
 * Returns the generated entry ID.
 */
export function addToKnowledge(
  pinned: PinnedMessage,
  sourceSessionPath: string,
  workingDirectory: string
): string {
  const store = readStore();

  // Check for duplicate (same session + same original index)
  const existing = store.entries.find(
    (e) => e.sourceSessionPath === sourceSessionPath && e.preview === (pinned.content || "").substring(0, 200)
  );
  if (existing) {
    // Update existing entry
    existing.content = pinned.content;
    existing.role = pinned.role;
    existing.agentTag = pinned.agentTag;
    existing.tag = pinned.tag;
    existing.pinnedAt = pinned.pinnedAt;
    existing.timestamp = pinned.timestamp;
    existing.preview = (pinned.content || "").substring(0, 200);
    existing.toolCalls = pinned.toolCalls;
    existing.toolResults = pinned.toolResults;
    writeStore(store);
    return existing.id;
  }

  const id = generateId();
  const entry: KnowledgeEntry = {
    id,
    content: pinned.content,
    role: pinned.role,
    agentTag: pinned.agentTag,
    tag: pinned.tag,
    sourceSessionPath,
    workingDirectory,
    pinnedAt: pinned.pinnedAt,
    timestamp: pinned.timestamp,
    preview: (pinned.content || "").substring(0, 200),
    toolCalls: pinned.toolCalls,
    toolResults: pinned.toolResults,
  };

  store.entries.push(entry);
  writeStore(store);
  return id;
}

/**
 * Remove a knowledge entry by ID.
 */
export function removeFromKnowledge(id: string): boolean {
  const store = readStore();
  const idx = store.entries.findIndex((e) => e.id === id);
  if (idx === -1) return false;
  store.entries.splice(idx, 1);
  writeStore(store);
  return true;
}

/**
 * Remove a knowledge entry matching a specific session path + content preview.
 * Used when unpinning a message to clean up the corresponding global entry.
 */
export function removeKnowledgeByPin(sourceSessionPath: string, contentPreview: string): boolean {
  const store = readStore();
  const preview = contentPreview.substring(0, 200);
  const idx = store.entries.findIndex(
    (e) => e.sourceSessionPath === sourceSessionPath && e.preview === preview
  );
  if (idx === -1) return false;
  store.entries.splice(idx, 1);
  writeStore(store);
  return true;
}

/**
 * Update the tag of a knowledge entry matching a specific session path + content preview.
 * Used when tagging a pinned message to sync the tag to the global store.
 */
export function updateKnowledgeTag(sourceSessionPath: string, contentPreview: string, tag: string): boolean {
  const store = readStore();
  const preview = contentPreview.substring(0, 200);
  const entry = store.entries.find(
    (e) => e.sourceSessionPath === sourceSessionPath && e.preview === preview
  );
  if (!entry) return false;
  entry.tag = tag;
  writeStore(store);
  return true;
}

/**
 * Remove all knowledge entries from a specific session.
 */
export function removeSessionFromKnowledge(sourceSessionPath: string): number {
  const store = readStore();
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.sourceSessionPath !== sourceSessionPath);
  const removed = before - store.entries.length;
  if (removed > 0) writeStore(store);
  return removed;
}

/**
 * Search knowledge entries by query (fuzzy match on content, tag, role).
 * Optionally filter by workingDirectory.
 */
export function searchKnowledge(
  query: string,
  options?: { workingDirectory?: string; tag?: string; limit?: number }
): KnowledgeEntry[] {
  const store = readStore();
  const q = query.toLowerCase();
  const limit = options?.limit || 20;

  let entries = store.entries;

  // Filter by working directory if specified
  if (options?.workingDirectory) {
    const wd = options.workingDirectory.toLowerCase();
    entries = entries.filter((e) => e.workingDirectory.toLowerCase() === wd);
  }

  // Filter by tag
  if (options?.tag) {
    const tag = options.tag.toLowerCase();
    entries = entries.filter((e) => e.tag?.toLowerCase() === tag);
  }

  // Score and sort
  const scored = entries.map((entry) => {
    let score = 0;
    const content = entry.content.toLowerCase();
    const preview = entry.preview.toLowerCase();
    const tag = (entry.tag || "").toLowerCase();

    if (content.includes(q)) score += 10;
    if (preview.includes(q)) score += 5;
    if (tag.includes(q)) score += 3;

    // Word-level matching
    const words = q.split(/\s+/).filter(Boolean);
    for (const word of words) {
      if (content.includes(word)) score += 2;
      if (preview.includes(word)) score += 1;
    }

    return { entry, score };
  });

  scored.sort((a, b) => b.score - a.score || b.entry.pinnedAt - a.entry.pinnedAt);

  return scored
    .filter((s) => s.score > 0)
    .slice(0, limit)
    .map((s) => s.entry);
}

/**
 * Get all knowledge entries, optionally filtered by working directory.
 */
export function getAllKnowledge(
  options?: { workingDirectory?: string; tag?: string; limit?: number }
): KnowledgeEntry[] {
  const store = readStore();
  let entries = store.entries;

  if (options?.workingDirectory) {
    const wd = options.workingDirectory.toLowerCase();
    entries = entries.filter((e) => e.workingDirectory.toLowerCase() === wd);
  }

  if (options?.tag) {
    const tag = options.tag.toLowerCase();
    entries = entries.filter((e) => e.tag?.toLowerCase() === tag);
  }

  // Sort by most recent first
  entries.sort((a, b) => b.pinnedAt - a.pinnedAt);

  return entries.slice(0, options?.limit || 50);
}

/**
 * Get unique working directories from knowledge entries.
 */
export function getKnowledgeProjects(): string[] {
  const store = readStore();
  const dirs = new Set(store.entries.map((e) => e.workingDirectory));
  return Array.from(dirs);
}

/**
 * Format knowledge entries for injection into an AI system prompt.
 * Returns a string that can be concatenated into the system prompt.
 */
export function formatKnowledgeForPrompt(
  entries: KnowledgeEntry[],
  maxEntries: number = 10,
  maxContentChars: number = 2000
): string {
  if (entries.length === 0) return "";

  const lines: string[] = [];
  lines.push("📌 PINNED KNOWLEDGE FROM PAST SESSIONS:");
  lines.push("Below are important messages pinned from previous sessions across all projects.");
  lines.push("You MUST use this knowledge to inform your responses and decisions.");
  lines.push("");
  lines.push("TOOLS AVAILABLE FOR PINNED KNOWLEDGE:");
  lines.push("- search_pinned_knowledge(query): Search the global pinned knowledge base");
  lines.push("- load_pinned_session(session_path): Load full conversation transcript from a past session");
  lines.push("- search_history(query, cross_session=true): Search ALL session histories cross-project");
  lines.push("");
  lines.push("WHEN TO USE THESE TOOLS (proactively, without being asked):");
  lines.push("- User mentions past sessions, previous conversations, or 'kemarin', 'sebelumnya', 'dulu'");
  lines.push("- User says 'baca pin', 'lihat pin', 'cari pin', 'recall', 'ingat', 'remember'");
  lines.push("- User references a tag like #auth, #database, #architecture — search by that tag");
  lines.push("- User asks 'pernah bahas X belum?' or 'ada context soal X?'");
  lines.push("- The current task relates to something in the pinned knowledge below");
  lines.push("- When you need historical context to make better decisions");
  lines.push("");

  const limited = entries.slice(0, maxEntries);
  for (let i = 0; i < limited.length; i++) {
    const e = limited[i];
    const tagStr = e.tag ? ` #${e.tag}` : "";
    const agentStr = e.agentTag ? ` [${e.agentTag.tier}${e.agentTag.subagentType ? ":" + e.agentTag.subagentType : ""}]` : "";
    const projectStr = e.workingDirectory ? ` (${e.workingDirectory})` : "";

    lines.push(`--- [${i + 1}] ${e.role.toUpperCase()}${agentStr}${tagStr}${projectStr} ---`);

    // Truncate content for prompt injection
    const content = e.content.length > maxContentChars
      ? e.content.substring(0, maxContentChars) + `\n... [truncated — session: ${e.sourceSessionPath}]`
      : e.content;
    lines.push(content);
    lines.push("");
  }

  if (entries.length > maxEntries) {
    lines.push(`... and ${entries.length - maxEntries} more entries available via search_pinned_knowledge or search_history(cross_session=true).`);
  }

  return lines.join("\n");
}

/**
 * Read the full conversation history from a session file referenced by a knowledge entry.
 * Returns the messages array or null if the file can't be read.
 */
export function loadSessionFromKnowledge(
  sourceSessionPath: string
): Array<{ role: string; content: string; timestamp?: number }> | null {
  try {
    if (!fs.existsSync(sourceSessionPath)) return null;
    const raw = fs.readFileSync(sourceSessionPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
      return parsed.messages;
    }
    if (Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Get a formatted transcript of a session for the AI to study.
 */
export function getSessionTranscript(
  sourceSessionPath: string,
  maxChars: number = 30000
): string | null {
  const messages = loadSessionFromKnowledge(sourceSessionPath);
  if (!messages) return null;

  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user" || msg.role === "assistant") {
      lines.push(`[${msg.role.toUpperCase()}]: ${msg.content || ""}`);
    }
  }

  let transcript = lines.join("\n\n");
  if (transcript.length > maxChars) {
    transcript = transcript.slice(-maxChars);
    transcript = "... [earlier content truncated] ...\n\n" + transcript;
  }

  return transcript;
}
