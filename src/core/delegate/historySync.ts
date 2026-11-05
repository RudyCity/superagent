import { delegateBridge } from "./bridge.js";
import {
  DelegateHistoryIndex,
  type DelegateIndexedMessage,
  type DelegateIndexStats,
  type DelegateIndexSearchResult,
} from "./historyIndex.js";

export interface DelegateSyncHistoryOptions {
  clientId?: string;
  maxChats?: number;
  refreshRecent?: number;
  force?: boolean;
}

function parseJson(text: string): any {
  try { return JSON.parse(text); }
  catch { throw new Error("DELEGATE_INVALID_RESPONSE: Delegate returned invalid JSON"); }
}

export function resolveDelegateClientId(explicit?: string): string {
  if (explicit !== undefined) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(explicit)) {
      throw new Error("DELEGATE_INVALID_CLIENT_ID: invalid Delegate clientId");
    }
    return explicit;
  }
  const clients = delegateBridge.listConnections();
  if (clients.length === 0) throw new Error("DELEGATE_EXTENSION_NOT_CONNECTED");
  if (clients.length > 1) {
    throw new Error("DELEGATE_CLIENT_SELECTION_REQUIRED: multiple Delegate Chrome profiles are connected");
  }
  return clients[0].clientId;
}

async function listChats(
  clientId: string,
  maxChats: number,
  signal?: AbortSignal,
): Promise<any[]> {
  const chats: any[] = [];
  let cursor: number | null = 0;
  let guard = 0;
  while (cursor !== null && chats.length < maxChats && guard++ < 50) {
    const limit = Math.min(200, maxChats - chats.length);
    const result = parseJson(await delegateBridge.request(
      "delegate.list_chats",
      { cursor, limit },
      signal,
      65_000,
      clientId,
    ));
    const page = Array.isArray(result?.chats) ? result.chats : [];
    for (const chat of page) {
      if (chat && typeof chat.chat_id === "string") chats.push(chat);
      if (chats.length >= maxChats) break;
    }
    const next = result?.next_cursor;
    if (next === null || next === undefined) break;
    if (!Number.isSafeInteger(next) || Number(next) <= Number(cursor)) break;
    cursor = Number(next);
    if (page.length === 0) break;
  }
  return chats.slice(0, maxChats);
}

async function readFullChat(
  clientId: string,
  chatId: string,
  signal?: AbortSignal,
): Promise<{ title: string; messages: DelegateIndexedMessage[] }> {
  const messages: DelegateIndexedMessage[] = [];
  let cursor: number | null = 0;
  let title = "";
  let guard = 0;
  while (cursor !== null && messages.length < 5_000 && guard++ < 80) {
    const result = parseJson(await delegateBridge.request(
      "delegate.read_chat_full",
      { chatId, cursor, limit: 80 },
      signal,
      95_000,
      clientId,
    ));
    if (!title && typeof result?.title === "string") title = result.title;
    const page = Array.isArray(result?.messages) ? result.messages : [];
    for (const message of page) {
      messages.push({
        index: Number.isSafeInteger(message?.index) ? Number(message.index) : messages.length,
        role: typeof message?.role === "string" ? message.role : "unknown",
        text: typeof message?.text === "string" ? message.text : "",
        text_truncated: !!message?.text_truncated,
      });
      if (messages.length >= 5_000) break;
    }
    const next = result?.next_cursor;
    if (next === null || next === undefined) break;
    if (!Number.isSafeInteger(next) || Number(next) <= Number(cursor)) break;
    cursor = Number(next);
    if (page.length === 0) break;
  }
  return { title, messages };
}

export async function syncDelegateHistoryIndex(
  options: DelegateSyncHistoryOptions,
  signal?: AbortSignal,
): Promise<{
  profile_id: string;
  listed: number;
  indexed: number;
  changed: number;
  unchanged: number;
  skipped_cached: number;
  unavailable: number;
  stats: DelegateIndexStats;
}> {
  const clientId = resolveDelegateClientId(options.clientId);
  const maxChats = Math.min(Math.max(Number(options.maxChats ?? 50), 1), 500);
  const refreshRecent = Math.min(Math.max(Number(options.refreshRecent ?? 10), 0), 100);
  const force = options.force === true;
  const chats = await listChats(clientId, maxChats, signal);
  const index = new DelegateHistoryIndex();
  let indexed = 0;
  let changed = 0;
  let unchanged = 0;
  let skippedCached = 0;
  let unavailable = 0;
  try {
    for (let position = 0; position < chats.length; position++) {
      if (signal?.aborted) throw new Error("DELEGATE_ABORTED");
      const chat = chats[position];
      const chatId = String(chat.chat_id || "");
      const title = String(chat.title || "Untitled chat");
      const url = String(chat.url || `https://chatgpt.com/c/${chatId}`);
      const existing = index.getChat(clientId, chatId);
      const refresh = force || !existing || position < refreshRecent;
      if (!refresh) {
        index.markSeen(clientId, chatId);
        skippedCached++;
        continue;
      }

      try {
        const full = await readFullChat(clientId, chatId, signal);
        const result = index.upsertChat(clientId, {
          chat_id: chatId,
          title: full.title || title,
          url,
          messages: full.messages,
          availability: "ok",
        });
        indexed++;
        if (result.changed) changed++; else unchanged++;
      } catch (error) {
        const code = String((error as any)?.message || error);
        if (/CHATGPT_HISTORY_(?:UNAVAILABLE|CHAT_NOT_FOUND)|DELEGATE_DOM_TIMEOUT/.test(code)) {
          const result = index.upsertChat(clientId, {
            chat_id: chatId,
            title,
            url,
            messages: [],
            availability: "unavailable",
          });
          indexed++;
          unavailable++;
          if (result.changed) changed++; else unchanged++;
          continue;
        }
        throw error;
      }
    }

    return {
      profile_id: clientId,
      listed: chats.length,
      indexed,
      changed,
      unchanged,
      skipped_cached: skippedCached,
      unavailable,
      stats: index.stats(clientId),
    };
  } finally {
    index.close();
  }
}

export function searchDelegateHistoryIndex(
  clientId: string | undefined,
  query: string,
  limit = 20,
): {
  profile_id: string;
  query: string;
  results: DelegateIndexSearchResult[];
  stats: DelegateIndexStats;
} {
  const resolved = resolveDelegateClientId(clientId);
  const index = new DelegateHistoryIndex();
  try {
    return {
      profile_id: resolved,
      query,
      results: index.search(resolved, query, limit),
      stats: index.stats(resolved),
    };
  } finally {
    index.close();
  }
}

export function getDelegateHistoryIndexStats(clientId?: string): DelegateIndexStats {
  const index = new DelegateHistoryIndex();
  try {
    return index.stats(clientId);
  } finally {
    index.close();
  }
}
