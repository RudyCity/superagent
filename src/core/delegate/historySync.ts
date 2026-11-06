import { delegateBridge } from "./bridge.js";
import { withDelegateTargetLock } from "../browserTransport/sessionCoordinator.js";
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

const AUTO_SYNC_MAX_AGE_MS = 15 * 60_000;
const autoSyncInFlight = new Map<string, Promise<ReturnType<typeof getDelegateHistoryIndexStats>>>();


function parseJson(text: string): any {
  try { return JSON.parse(text); }
  catch { throw new Error("DELEGATE_INVALID_RESPONSE: Delegate returned invalid JSON"); }
}

export const OPEN_CHAT_READ_JS = [
  "(() => {",
  "  const norm = (text) => String(text || \"\").replace(/\\s+/g, \" \").trim();",
  "  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;",
  "  const roleOf = (node) => {",
  "    const legacy = node.getAttribute(\"data-message-author-role\");",
  "    if (legacy) return legacy;",
  "    const key = node.getAttribute(\"data-chatgpt-search-unit-key\") || \"\";",
  "    if (key.endsWith(\":user\")) return \"user\";",
  "    if (key.endsWith(\":assistant\")) return \"assistant\";",
  "    return \"unknown\";",
  "  };",
  "  const legacy = Array.from(document.querySelectorAll(\"[data-message-author-role]\"));",
  "  const modern = Array.from(document.querySelectorAll('[data-chatgpt-search-unit-key$=\\\":user\\\"], [data-chatgpt-search-unit-key$=\\\":assistant\\\"]'));",
  "  const nodes = [...new Set([...legacy, ...modern])].filter(visible).slice(-200);",
  "  const messages = nodes.map((node, index) => {",
  "    const body = node.querySelector?.(\".markdown, [data-message-content], [data-testid='conversation-turn-content']\") || node;",
  "    let text = norm(body.innerText || body.textContent);",
  "    const key = node.getAttribute(\"data-chatgpt-search-unit-key\") || \"\";",
  "    if (key.endsWith(\":assistant\")) text = text.replace(/^chatgpt said:\s*/i, \"\");",
  "    else if (key.endsWith(\":user\")) text = text.replace(/^you said:\s*/i, \"\");",
  "    return { index, role: roleOf(node), text: text.slice(0, 12000), text_truncated: text.length > 12000 };",
  "  });",
  "  return { url: String(location.href || \"\"), title: String(document.title || \"\").slice(0, 2000), messages };",
  "})()",
].join("\n");

export function parseDelegateCdpChatReadResult(
  raw: unknown,
  expectedChatId: string,
): { title: string; messages: DelegateIndexedMessage[] } {
  if (!/^[a-zA-Z0-9_-]{8,180}$/.test(expectedChatId)) {
    throw new Error("DELEGATE_INVALID_CHAT_ID");
  }
  const value = (raw as any)?.result?.value;
  if ((raw as any)?.exceptionDetails || !value || typeof value !== "object") {
    throw new Error("DELEGATE_CDP_CHAT_READ_FAILED");
  }
  const url = typeof value.url === "string" ? value.url : "";
  const match = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9_-]{8,180})(?:[/?#]|$)/.exec(url);
  if (!match || match[1] !== expectedChatId) {
    throw new Error("DELEGATE_CDP_CHAT_TARGET_CHANGED");
  }
  const page = Array.isArray(value.messages) ? value.messages.slice(-200) : [];
  return {
    title: typeof value.title === "string" ? value.title.slice(0, 2_000) : "",
    messages: page.map((message: any, index: number) => ({
      index: Number.isSafeInteger(message?.index) && Number(message.index) >= 0
        ? Number(message.index) : index,
      role: typeof message?.role === "string"
        ? String(message.role).slice(0, 32) : "unknown",
      text: typeof message?.text === "string"
        ? String(message.text).slice(0, 12_000) : "",
      text_truncated: !!message?.text_truncated ||
        (typeof message?.text === "string" && message.text.length > 12_000),
    })),
  };
}

export function openDelegateTabsToHistoryRows(
  value: unknown,
  maxChats = 100,
): Array<{ chat_id: string; title: string; url: string; tab_id?: number }> {
  const tabs = Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.tabs) ? (value as any).tabs : [];
  const unique = new Map<string, { chat_id: string; title: string; url: string; tab_id?: number }>();
  for (const tab of tabs) {
    const url = typeof tab?.url === "string" ? tab.url : "";
    const match = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9_-]{8,180})(?:[/?#]|$)/.exec(url);
    if (!match || unique.has(match[1])) continue;
    unique.set(match[1], {
      chat_id: match[1],
      title: typeof tab?.title === "string" && tab.title.trim()
        ? tab.title.trim().slice(0, 2_000) : "Untitled chat",
      url: "https://chatgpt.com/c/" + match[1],
      ...(Number.isSafeInteger(tab?.tabId) && Number(tab.tabId) > 0
        ? { tab_id: Number(tab.tabId) } : {}),
    });
    if (unique.size >= Math.min(Math.max(maxChats, 1), 500)) break;
  }
  return [...unique.values()];
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
  if (chats.length === 0) {
    // Prefer Core's structured Delegate-CDP inventory. It is the same read-only
    // transport used by control_chrome_cdp(list_targets), avoids per-tab DOM
    // probes, and remains principal-filtered inside the Core host.
    try {
      const { getBrowserTransport } = await import("../browserTransport/router.js");
      const targets = await getBrowserTransport("delegate").listTargets(clientId, signal);
      const rows = openDelegateTabsToHistoryRows({ tabs: targets }, maxChats);
      if (rows.length > 0) return rows;
    } catch {
      // Semantic-only Delegate profiles may not expose CDP. Fall through.
    }

    // Semantic tab listing is a compatibility fallback. It is read-only but
    // can be slower on profiles with many busy tabs because it probes DOM
    // readiness before returning.
    try {
      const tabs = parseJson(await delegateBridge.request(
        "delegate.list_tabs", {}, signal, 20_000, clientId,
      ));
      const rows = openDelegateTabsToHistoryRows(tabs, maxChats);
      if (rows.length > 0) return rows;
    } catch {
      // Keep the zero-row sidebar result fail-safe rather than making sync fail.
    }
  }
  return chats.slice(0, maxChats);
}

async function readOpenChatTab(
  clientId: string,
  tabId: number,
  expectedChatId: string,
  signal?: AbortSignal,
): Promise<{ title: string; messages: DelegateIndexedMessage[] }> {
  if (!Number.isSafeInteger(tabId) || tabId < 1) {
    throw new Error("DELEGATE_INVALID_TAB_ID");
  }

  // Prefer the semantic side-effect-free read when supported by the loaded
  // extension. This path disables automatic delivery-timeout continuation.
  try {
    const result = parseJson(await delegateBridge.request(
      "delegate.peek_chat",
      { tabId },
      signal,
      12_000,
      clientId,
    ));
    const url = typeof result?.url === "string" ? result.url : "";
    const match = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9_-]{8,180})(?:[/?#]|$)/.exec(url);
    if (!match || match[1] !== expectedChatId) {
      throw new Error("DELEGATE_PEEK_CHAT_TARGET_CHANGED");
    }
    const page = Array.isArray(result?.messages) ? result.messages : [];
    return {
      title: "",
      messages: page.slice(-200).map((message: any, index: number) => ({
        index: Number.isSafeInteger(message?.index) ? Number(message.index) : index,
        role: typeof message?.role === "string" ? message.role : "unknown",
        text: typeof message?.text === "string" ? message.text : "",
        text_truncated: !!message?.text_truncated,
      })),
    };
  } catch {
    // Loaded 1.9.0 profiles may not expose peek_chat. Compatibility reads are
    // allowed only after an explicit doctor probe proves that no delivery
    // timeout/retry state can trigger the legacy automatic continuation path.
    try {
      const doctor = parseJson(await delegateBridge.request(
        "delegate.doctor",
        { tabId },
        signal,
        12_000,
        clientId,
      ));
      if (doctor?.ready !== true || doctor?.logged_in === false ||
          doctor?.delivery_timeout === true || doctor?.retry_visible === true) {
        throw new Error("DELEGATE_HISTORY_OPEN_TAB_READ_UNSAFE");
      }
      const legacy = parseJson(await delegateBridge.request(
        "delegate.read_chat",
        { tabId },
        signal,
        20_000,
        clientId,
      ));
      if (legacy?.delivery_error === true || legacy?.retry_available === true) {
        throw new Error("DELEGATE_HISTORY_OPEN_TAB_READ_UNSAFE");
      }
      const url = typeof legacy?.url === "string" ? legacy.url : "";
      const match = /^https:\/\/chatgpt\.com\/c\/([a-zA-Z0-9_-]{8,180})(?:[/?#]|$)/.exec(url);
      if (!match || match[1] !== expectedChatId) {
        throw new Error("DELEGATE_HISTORY_OPEN_TAB_TARGET_CHANGED");
      }
      const page = Array.isArray(legacy?.messages) ? legacy.messages : [];
      return {
        title: "",
        messages: page.slice(-80).map((message: any, index: number) => ({
          index: Number.isSafeInteger(message?.index) ? Number(message.index) : index,
          role: typeof message?.role === "string" ? message.role : "unknown",
          text: typeof message?.text === "string" ? message.text : "",
          text_truncated: !!message?.text_truncated,
        })),
      };
    } catch {
      // Continue with the audited Delegate-CDP read path.
    }
  }

  const { delegateCdpTransport } = await import("./cdpTransport.js");
  const targets = await delegateCdpTransport.listTargets(clientId, signal);
  const target = targets.find(row =>
    row.tabId === tabId &&
    row.connectionId === clientId &&
    typeof row.url === "string" &&
    row.url.startsWith("https://chatgpt.com/c/"));
  if (!target) throw new Error("DELEGATE_CDP_CHAT_TARGET_NOT_FOUND");

  // attach/detach are protected low-level RPCs even for a read-only Runtime.evaluate.
  // Enter the same per-target operation fence used by normal Delegate-CDP commands;
  // this serializes the compatibility read without granting a write lease.
  return withDelegateTargetLock(clientId, tabId, async () => {
    const attached = await delegateCdpTransport.rpc<any>(
      "delegate.cdp.attach", { tabId }, signal, clientId);
    const ownedHere = attached?.alreadyOwned !== true;
    try {
      const raw = await delegateCdpTransport.command(
        target,
        "Runtime.evaluate",
        { expression: OPEN_CHAT_READ_JS, returnByValue: true, awaitPromise: true },
        signal,
        { trustedGenerated: true },
      );
      return parseDelegateCdpChatReadResult(raw, expectedChatId);
    } finally {
      if (ownedHere) {
        try {
          await delegateCdpTransport.rpc(
            "delegate.cdp.detach", { tabId }, undefined, clientId);
        } catch {}
      }
    }
  });
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
          if (Number.isSafeInteger(chat.tab_id) && Number(chat.tab_id) > 0) {
            try {
              const open = await readOpenChatTab(
                clientId, Number(chat.tab_id), chatId, signal);
              const result = index.upsertChat(clientId, {
                chat_id: chatId,
                title: open.title || title,
                url,
                messages: open.messages,
                availability: "ok",
              });
              indexed++;
              if (result.changed) changed++; else unchanged++;
              continue;
            } catch {
              // Preserve fail-closed unavailable state if the open tab changed,
              // closed, or cannot be inspected read-only.
            }
          }
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


export async function ensureDelegateHistoryIndexWarm(
  clientId?: string,
  signal?: AbortSignal,
): Promise<{ refreshed: boolean; stats: DelegateIndexStats }> {
  const resolved = resolveDelegateClientId(clientId);
  const before = getDelegateHistoryIndexStats(resolved);
  const fresh = before.chats > 0 && before.lastIndexedAt !== null &&
    Date.now() - before.lastIndexedAt < AUTO_SYNC_MAX_AGE_MS;
  if (fresh) return { refreshed: false, stats: before };

  let pending = autoSyncInFlight.get(resolved);
  if (!pending) {
    pending = (async () => {
      await syncDelegateHistoryIndex({
        clientId: resolved,
        maxChats: 100,
        refreshRecent: 20,
        force: false,
      }, signal);
      return getDelegateHistoryIndexStats(resolved);
    })().finally(() => {
      autoSyncInFlight.delete(resolved);
    });
    autoSyncInFlight.set(resolved, pending);
  }
  return { refreshed: true, stats: await pending };
}
