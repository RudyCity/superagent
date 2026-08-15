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
import { getSettings } from "./config.js";
import type { PinnedMessage, AgentTag } from "./context/ContextManager.js";
import {
  savePinnedKnowledgeToDb,
  deletePinnedKnowledgeFromDb,
  deletePinnedKnowledgeByPinFromDb,
  updatePinnedKnowledgeTagInDb,
  deleteSessionFromPinnedKnowledgeDb,
  getAllPinnedKnowledgeFromDb,
  getHistoryDb
} from "./storage/historyDb.js";

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

let legacyPinnedKnowledgeMigrated = false;

function loadPinnedKnowledgeWithMigration(): KnowledgeEntry[] {
  if (legacyPinnedKnowledgeMigrated) {
    return getAllPinnedKnowledgeFromDb();
  }

  const filePath = getKnowledgePath();
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          savePinnedKnowledgeToDb(entry);
        }
      }
      fs.unlinkSync(filePath);
    } catch (e) {
      // Ignore migration errors
    }
  }

  legacyPinnedKnowledgeMigrated = true;
  return getAllPinnedKnowledgeFromDb();
}

function readStore(): KnowledgeStore {
  const entries = loadPinnedKnowledgeWithMigration();
  return { version: STORE_VERSION, entries };
}

function generateId(): string {
  return `pk-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

function enforceMaxEntriesLimit(): void {
  try {
    const db = getHistoryDb();
    const countRow = db.prepare("SELECT count(*) as cnt FROM pinned_knowledge").get() as { cnt: number } | undefined;
    if (countRow && countRow.cnt > MAX_ENTRIES) {
      const excess = countRow.cnt - MAX_ENTRIES;
      const oldestRows = db.prepare("SELECT id FROM pinned_knowledge ORDER BY pinned_at ASC LIMIT ?").all(excess) as Array<{ id: string }>;
      if (Array.isArray(oldestRows)) {
        for (const row of oldestRows) {
          deletePinnedKnowledgeFromDb(row.id);
        }
      }
    }
  } catch {}
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
  
  let entry: KnowledgeEntry;
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
    savePinnedKnowledgeToDb(existing);
    entry = existing;
  } else {
    const id = generateId();
    entry = {
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
    savePinnedKnowledgeToDb(entry);
    enforceMaxEntriesLimit();
  }

  // Sync to RMemory
  const settings = getSettings();
  if (settings.enableRmemory) {
    const entryCopy = { ...entry };
    Promise.resolve().then(async () => {
      try {
        const { getRMemoryClient } = await import("./rmemoryUtil.js");
        const client = getRMemoryClient(2000);
        const scopeTag = entryCopy.tag ? `[tag:${entryCopy.tag}]` : "";
        const projectTag = entryCopy.workingDirectory ? `[project:${path.basename(entryCopy.workingDirectory)}]` : "";
        await client.updateAtomic({
          id: `pinned-knowledge-${entryCopy.id}`,
          content: `[pinned-knowledge] ${scopeTag} ${projectTag} ${entryCopy.content}`
        });
      } catch {}
    });
  }

  return entry.id;
}

/**
 * Remove a knowledge entry by ID.
 */
export function removeFromKnowledge(id: string): boolean {
  deletePinnedKnowledgeFromDb(id);

  // Sync to RMemory
  const settings = getSettings();
  if (settings.enableRmemory) {
    Promise.resolve().then(async () => {
      try {
        const { getRMemoryClient } = await import("./rmemoryUtil.js");
        const client = getRMemoryClient(2000);
        await client.deleteAtomic({ ids: [`pinned-knowledge-${id}`] });
      } catch {}
    });
  }

  return true;
}

/**
 * Remove a knowledge entry matching a specific session path + content preview.
 * Used when unpinning a message to clean up the corresponding global entry.
 */
export function removeKnowledgeByPin(sourceSessionPath: string, contentPreview: string): boolean {
  const store = readStore();
  const preview = contentPreview.substring(0, 200);
  const entry = store.entries.find(
    (e) => e.sourceSessionPath === sourceSessionPath && e.preview === preview
  );
  if (!entry) return false;

  deletePinnedKnowledgeByPinFromDb(sourceSessionPath, contentPreview);

  // Sync to RMemory
  const settings = getSettings();
  if (settings.enableRmemory) {
    Promise.resolve().then(async () => {
      try {
        const { getRMemoryClient } = await import("./rmemoryUtil.js");
        const client = getRMemoryClient(2000);
        await client.deleteAtomic({ ids: [`pinned-knowledge-${entry.id}`] });
      } catch {}
    });
  }

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

  updatePinnedKnowledgeTagInDb(sourceSessionPath, contentPreview, tag);
  entry.tag = tag;

  // Sync to RMemory
  const settings = getSettings();
  if (settings.enableRmemory) {
    const entryCopy = { ...entry };
    Promise.resolve().then(async () => {
      try {
        const { getRMemoryClient } = await import("./rmemoryUtil.js");
        const client = getRMemoryClient(2000);
        const scopeTag = tag ? `[tag:${tag}]` : "";
        const projectTag = entryCopy.workingDirectory ? `[project:${path.basename(entryCopy.workingDirectory)}]` : "";
        await client.updateAtomic({
          id: `pinned-knowledge-${entryCopy.id}`,
          content: `[pinned-knowledge] ${scopeTag} ${projectTag} ${entryCopy.content}`
        });
      } catch {}
    });
  }

  return true;
}

/**
 * Remove all knowledge entries from a specific session.
 */
export function removeSessionFromKnowledge(sourceSessionPath: string): number {
  const store = readStore();
  const toRemove = store.entries.filter((e) => e.sourceSessionPath === sourceSessionPath);
  if (toRemove.length === 0) return 0;

  const removed = deleteSessionFromPinnedKnowledgeDb(sourceSessionPath);

  // Sync to RMemory
  const settings = getSettings();
  if (settings.enableRmemory && removed > 0) {
    Promise.resolve().then(async () => {
      try {
        const { getRMemoryClient } = await import("./rmemoryUtil.js");
        const client = getRMemoryClient(2000);
        const ids = toRemove.map((e) => `pinned-knowledge-${e.id}`);
        await client.deleteAtomic({ ids });
      } catch {}
    });
  }
  return removed;
}

/**
 * Search knowledge entries by query (fuzzy match on content, tag, role).
 * Optionally filter by workingDirectory.
 */
const stopWords = new Set([
  "a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "at", "by", "for", "with",
  "about", "against", "between", "into", "through", "during", "before", "after", "above", "below",
  "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further",
  "then", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both", "each",
  "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "can", "will", "just", "should", "now"
]);

function computeKnowledgeBm25Score(
  entry: KnowledgeEntry,
  queryTerms: string[],
  docFreqs: Record<string, number>,
  numDocs: number,
  docLength: number,
  avgDocLength: number
): number {
  const content = entry.content.toLowerCase();
  const tag = (entry.tag || "").toLowerCase();
  
  let score = 0;
  const k1 = 1.2;
  const b = 0.75;

  for (const term of queryTerms) {
    const df = docFreqs[term] || 0;
    // Standard BM25 IDF
    const idf = Math.log((numDocs - df + 0.5) / (df + 0.5) + 1.0);

    let tf = 0;
    let matchPenalty = 1.0;

    // Check matches in tag (highest priority)
    if (tag.includes(term)) {
      tf += 3;
    }
    
    // Check matches in content
    if (content.includes(term)) {
      let pos = content.indexOf(term);
      while (pos !== -1) {
        tf += 1;
        pos = content.indexOf(term, pos + term.length);
      }
    } else {
      // Fuzzy subsequence match fallback
      let lastIdx = -1;
      let possibleMatch = true;
      for (let j = 0; j < term.length; j++) {
        const idx = content.indexOf(term[j], lastIdx + 1);
        if (idx === -1) {
          possibleMatch = false;
          break;
        }
        lastIdx = idx;
      }
      if (possibleMatch) {
        tf = 1;
        matchPenalty = 0.4;
      }
    }

    if (tf > 0) {
      const adjustedTf = tf * matchPenalty;
      // BM25 formula
      const tfWeight = (adjustedTf * (k1 + 1)) / (adjustedTf + k1 * (1 - b + b * (docLength / (avgDocLength || 1))));
      score += idf * tfWeight;
    }
  }

  return score;
}

/**
 * Search knowledge entries by query (fuzzy match on content, tag, role).
 * Optionally filter by workingDirectory.
 */
export async function searchKnowledge(
  query: string,
  options?: { workingDirectory?: string; tag?: string; limit?: number }
): Promise<KnowledgeEntry[]> {
  const limit = options?.limit || 20;

  const settings = getSettings();
  if (settings.enableRmemory) {
    try {
      const { getRMemoryClient } = await import("./rmemoryUtil.js");
      const client = getRMemoryClient(3000);
      const searchRes = await client.searchAtomic({ query, limit: limit * 2 });
      const items = searchRes.items || [];
      const matchedIds = items
        .filter((item) => item.id.startsWith("pinned-knowledge-"))
        .map((item) => item.id.replace("pinned-knowledge-", ""));

      if (matchedIds.length > 0) {
        const store = readStore();
        const matchedEntries = matchedIds
          .map((id) => store.entries.find((e) => e.id === id))
          .filter(Boolean) as KnowledgeEntry[];

        let filtered = matchedEntries;
        if (options?.workingDirectory) {
          const wd = options.workingDirectory.toLowerCase();
          filtered = filtered.filter((e) => e.workingDirectory.toLowerCase() === wd);
        }
        if (options?.tag) {
          const tag = options.tag.toLowerCase();
          filtered = filtered.filter((e) => e.tag?.toLowerCase() === tag);
        }
        return filtered.slice(0, limit);
      }
    } catch (err) {
      // ignore and fallback to local search
    }
  }

  const store = readStore();
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

  // Tokenize query
  const queryTerms = query.toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .split(/\s+/)
    .filter((k) => k.length > 1 && !stopWords.has(k));

  const finalQueryTerms = queryTerms.length > 0 ? queryTerms : query.toLowerCase().split(/\s+/).filter(Boolean);

  // Calculate Document Frequency
  const numDocs = entries.length;
  const docFreqs: Record<string, number> = {};
  for (const term of finalQueryTerms) {
    let freq = 0;
    for (const entry of entries) {
      if (entry.content.toLowerCase().includes(term) || (entry.tag || "").toLowerCase().includes(term)) {
        freq++;
      } else {
        const c = entry.content.toLowerCase();
        let lastIdx = -1;
        let possibleMatch = true;
        for (let j = 0; j < term.length; j++) {
          const idx = c.indexOf(term[j], lastIdx + 1);
          if (idx === -1) {
            possibleMatch = false;
            break;
          }
          lastIdx = idx;
        }
        if (possibleMatch) {
          freq++;
        }
      }
    }
    docFreqs[term] = freq;
  }

  const getWordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

  // Calculate average document length
  const totalLength = entries.reduce((sum, e) => sum + getWordCount(e.content), 0);
  const avgDocLength = numDocs > 0 ? totalLength / numDocs : 1;

  // Score and sort
  const scored = entries
    .map((entry) => {
      const docLength = getWordCount(entry.content);
      const score = computeKnowledgeBm25Score(entry, finalQueryTerms, docFreqs, numDocs, docLength, avgDocLength);
      return { entry, score };
    })
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score || b.entry.pinnedAt - a.entry.pinnedAt);

  return scored.slice(0, limit).map((s) => s.entry);
}

export async function syncAllPinnedToRMemory(): Promise<void> {
  const settings = getSettings();
  if (!settings.enableRmemory) return;
  try {
    const store = readStore();
    const { getRMemoryClient } = await import("./rmemoryUtil.js");
    const client = getRMemoryClient(5000);
    for (const entry of store.entries) {
      const scopeTag = entry.tag ? `[tag:${entry.tag}]` : "";
      const projectTag = entry.workingDirectory ? `[project:${path.basename(entry.workingDirectory)}]` : "";
      await client.updateAtomic({
        id: `pinned-knowledge-${entry.id}`,
        content: `[pinned-knowledge] ${scopeTag} ${projectTag} ${entry.content}`
      });
    }
  } catch (err) {
    console.error("Failed to sync pinned knowledge to RMemory:", err);
  }
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
  lines.push("Use search_pinned_knowledge, load_pinned_session, or search_history when past context is referenced.");
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
