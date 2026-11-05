import type { Tool } from "./types.js";
import { delegateBridge, type DelegateMethod } from "../delegate/bridge.js";
import {
  getDelegateHistoryIndexStats,
  searchDelegateHistoryIndex,
  syncDelegateHistoryIndex,
} from "../delegate/historySync.js";
import { runDelegateUntilDone } from "../delegate/runUntilDone.js";

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object", properties, required, additionalProperties: false,
});

const optionalTarget = {
  clientId: {
    type: "string", minLength: 8, maxLength: 80,
    description: "Target Chrome Delegate clientId from delegate.read_chat({connections:true}). Required when multiple Chrome profiles are connected.",
  },
  tabId: {
    type: "integer", minimum: 1,
    description: "Optional exact ChatGPT tab ID within the selected Chrome profile. No automatic tab fallback if specified.",
  },
};

function prepareTarget(
  args: Record<string, unknown>,
  allowMessage: boolean,
): { clientId?: string; params: Record<string, unknown> } {
  const keys = Object.keys(args || {});
  if (keys.some(k => !["clientId", "tabId", ...(allowMessage ? ["message"] : [])].includes(k))) {
    throw new Error("DELEGATE_INVALID_ARGUMENT: Unexpected delegate tool argument");
  }
  const clientId = args?.clientId;
  if (clientId !== undefined &&
      (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(clientId))) {
    throw new Error("DELEGATE_INVALID_CLIENT_ID: Use a clientId from delegate.read_chat({connections:true})");
  }
  const params: Record<string, unknown> = {};
  if (args?.tabId !== undefined) {
    if (!Number.isSafeInteger(args.tabId) || (args.tabId as number) < 1) {
      throw new Error("DELEGATE_INVALID_TAB_ID: tabId must be a positive integer");
    }
    params.tabId = args.tabId;
  }
  if (allowMessage) {
    if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 100_000) {
      throw new Error("DELEGATE_INVALID_MESSAGE: message must be nonempty text of at most 100000 characters");
    }
    params.message = args.message;
  }
  return { clientId: clientId as string | undefined, params };
}

function prepareHistoryTarget(
  args: Record<string, unknown>,
  allowedKeys: string[],
): { clientId?: string; params: Record<string, unknown> } {
  const keys = Object.keys(args || {});
  if (keys.some(key => !["clientId", ...allowedKeys].includes(key))) {
    throw new Error("DELEGATE_INVALID_ARGUMENT: Unexpected delegate history argument");
  }
  const clientId = args?.clientId;
  if (clientId !== undefined &&
      (typeof clientId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(clientId))) {
    throw new Error("DELEGATE_INVALID_CLIENT_ID: Use a clientId from delegate.read_chat({connections:true})");
  }
  const params = { ...args };
  delete params.clientId;
  return { clientId: clientId as string | undefined, params };
}

function historyTool(
  name: DelegateMethod,
  description: string,
  parameters: Record<string, unknown>,
  validate: (params: Record<string, unknown>) => void,
  timeoutMs: number,
): Tool {
  return {
    name, description, parameters,
    async execute(args: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<string> {
      try {
        const allowedKeys = Object.keys((parameters as { properties?: Record<string, unknown> }).properties || {})
          .filter(key => key !== "clientId");
        const { clientId, params } = prepareHistoryTarget(args, allowedKeys);
        validate(params);
        return await delegateBridge.request(name, params, signal, timeoutMs, clientId);
      } catch (error) {
        return "Error: " + (error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function tool(
  name: DelegateMethod,
  description: string,
  parameters: Record<string, unknown>,
  timeoutMs = 20_000,
  allowMessage = false,
  allowConnectionList = false,
): Tool {
  return {
    name, description, parameters,
    async execute(args: Record<string, unknown>, _cwd: string, signal?: AbortSignal): Promise<string> {
      try {
        if (allowConnectionList && args?.connections === true) {
          if (Object.keys(args).some(k => !["connections"].includes(k))) {
            throw new Error("DELEGATE_INVALID_ARGUMENT: connections:true cannot be combined with other options");
          }
          const clients = delegateBridge.listConnections();
          return JSON.stringify({
            connections: clients,
            count: clients.length,
            hint: "For multiple connected profiles, pass clientId to create_chat, read_chat, send_message or stop_generation.",
          });
        }
        const copy = { ...args };
        if (allowConnectionList) {
          if (copy.connections !== undefined && copy.connections !== false) {
            throw new Error("DELEGATE_INVALID_ARGUMENT: connections must be boolean");
          }
          delete copy.connections;
        }
        const { clientId, params } = prepareTarget(copy, allowMessage);
        return await delegateBridge.request(name, params, signal, timeoutMs, clientId);
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

export const delegateCreateChatTool: Tool = tool(
  "delegate.create_chat",
  "Start a new ChatGPT chat exactly once. If the selected Chrome profile has no ChatGPT tab and tabId is omitted, Delegate opens https://chatgpt.com/ automatically, waits for readiness, then continues. For multiple Chrome profiles choose clientId from delegate.read_chat({connections:true}). Optional tabId selects an exact ChatGPT tab and never falls back.",
  schema(optionalTarget),
);

export const delegateReadChatTool: Tool = tool(
  "delegate.read_chat",
  "Read the selected ChatGPT chat. Detects ChatGPT's visible 'Message delivery timed out. Please try again.' state as delivery_timeout. The extension recovers that UI timeout with one guarded follow-up message, 'continue until done', without clicking Retry or replaying the original request. If no ChatGPT tab exists and tabId is omitted, Delegate opens https://chatgpt.com/ automatically before reading. Use {connections:true} to list connected Chrome profiles without opening a tab. With multiple connections choose clientId explicitly.",
  schema({ ...optionalTarget, connections: {
    type: "boolean", description: "Return list of connected Chrome profiles without accessing any ChatGPT tabs.",
  } }),
  20_000, false, true,
);

export const delegateListChatsTool: Tool = historyTool(
  "delegate.list_chats",
  "List ChatGPT conversation history from the selected Chrome profile without changing the user's active chat. Uses an inactive read-only worker tab and scrolls the Chat history sidebar to load older entries. Paginate with cursor/limit until next_cursor is null.",
  schema({
    clientId: optionalTarget.clientId,
    cursor: { type: "integer", minimum: 0, maximum: 5000, description: "Zero-based history offset." },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "Chats per page; default 50." },
  }),
  (params) => {
    if (params.cursor !== undefined && (!Number.isSafeInteger(params.cursor) || Number(params.cursor) < 0 || Number(params.cursor) > 5000)) {
      throw new Error("DELEGATE_INVALID_CURSOR: cursor must be an integer from 0 to 5000");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 200)) {
      throw new Error("DELEGATE_INVALID_LIMIT: limit must be an integer from 1 to 200");
    }
  },
  60_000,
);

export const delegateReadChatFullTool: Tool = historyTool(
  "delegate.read_chat_full",
  "Read a historical ChatGPT conversation by chatId in an inactive read-only worker tab. It scrolls through virtualized/older turns, returns paginated messages, and never sends, retries, or modifies the user's active chat.",
  schema({
    clientId: optionalTarget.clientId,
    chatId: { type: "string", minLength: 8, maxLength: 180, description: "Conversation ID returned by delegate.list_chats." },
    cursor: { type: "integer", minimum: 0, description: "Zero-based message offset." },
    limit: { type: "integer", minimum: 1, maximum: 80, description: "Messages per page; default 40." },
  }, ["chatId"]),
  (params) => {
    if (typeof params.chatId !== "string" || !/^[a-zA-Z0-9:_-]{8,180}$/.test(params.chatId)) {
      throw new Error("DELEGATE_INVALID_CHAT_ID: use a chatId returned by delegate.list_chats");
    }
    if (params.cursor !== undefined && (!Number.isSafeInteger(params.cursor) || Number(params.cursor) < 0)) {
      throw new Error("DELEGATE_INVALID_CURSOR: cursor must be a non-negative integer");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 80)) {
      throw new Error("DELEGATE_INVALID_LIMIT: limit must be an integer from 1 to 80");
    }
  },
  90_000,
);

export const delegateSearchHistoryTool: Tool = historyTool(
  "delegate.search_history",
  "Search ChatGPT history titles and message content through an inactive read-only worker tab. Scans up to maxChats conversations and returns matching chat IDs/titles with snippets; no active chat, draft, or conversation is modified.",
  schema({
    clientId: optionalTarget.clientId,
    query: { type: "string", minLength: 1, maxLength: 500 },
    limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum matching conversations; default 20." },
    maxChats: { type: "integer", minimum: 1, maximum: 500, description: "Maximum conversations to scan; default 100." },
  }, ["query"]),
  (params) => {
    if (typeof params.query !== "string" || !params.query.trim() || params.query.length > 500) {
      throw new Error("DELEGATE_INVALID_QUERY: query must be 1 to 500 characters");
    }
    if (params.limit !== undefined && (!Number.isSafeInteger(params.limit) || Number(params.limit) < 1 || Number(params.limit) > 50)) {
      throw new Error("DELEGATE_INVALID_LIMIT: limit must be an integer from 1 to 50");
    }
    if (params.maxChats !== undefined && (!Number.isSafeInteger(params.maxChats) || Number(params.maxChats) < 1 || Number(params.maxChats) > 500)) {
      throw new Error("DELEGATE_INVALID_MAX_CHATS: maxChats must be an integer from 1 to 500");
    }
  },
  300_000,
);

export const delegateSyncHistoryTool: Tool = {
  name: "delegate.sync_history",
  description: "Incrementally mirror ChatGPT history into the local SuperAgent SQLite index. Reads through Delegate worker tabs, refreshes recent chats, and leaves the active ChatGPT tab untouched.",
  parameters: schema({
    clientId: optionalTarget.clientId,
    maxChats: { type: "integer", minimum: 1, maximum: 500 },
    refreshRecent: { type: "integer", minimum: 0, maximum: 100 },
    force: { type: "boolean" },
  }),
  async execute(args, _cwd, signal) {
    try {
      return JSON.stringify(await syncDelegateHistoryIndex({
        clientId: typeof args.clientId === "string" ? args.clientId : undefined,
        maxChats: args.maxChats as number | undefined,
        refreshRecent: args.refreshRecent as number | undefined,
        force: args.force === true,
      }, signal));
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateSearchIndexTool: Tool = {
  name: "delegate.search_index",
  description: "Search the local SQLite mirror of ChatGPT history. No browser navigation occurs and no message is sent. Run delegate.sync_history first to refresh the cache.",
  parameters: schema({
    clientId: optionalTarget.clientId,
    query: { type: "string", minLength: 1, maxLength: 500 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  }, ["query"]),
  async execute(args) {
    try {
      if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500) {
        throw new Error("DELEGATE_INVALID_QUERY: query must be 1 to 500 characters");
      }
      return JSON.stringify(searchDelegateHistoryIndex(
        typeof args.clientId === "string" ? args.clientId : undefined,
        args.query,
        Number(args.limit ?? 20),
      ));
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateDoctorTool: Tool = {
  name: "delegate.doctor",
  description: "Read-only Delegate diagnostics for bridge/profile connection, browser DOM state, and local history-index statistics. Never sends, stops, retries, or navigates a chat.",
  parameters: schema({ clientId: optionalTarget.clientId, tabId: optionalTarget.tabId }),
  async execute(args, _cwd, signal) {
    try {
      const clients = delegateBridge.listConnections();
      const selected = typeof args.clientId === "string"
        ? clients.find(client => client.clientId === args.clientId)
        : clients.length === 1 ? clients[0] : undefined;
      let browser: unknown = null;
      let browserError: string | null = null;
      if (selected) {
        try {
          browser = JSON.parse(await delegateBridge.request(
            "delegate.doctor",
            args.tabId === undefined ? {} : { tabId: args.tabId },
            signal,
            20_000,
            selected.clientId,
          ));
        } catch (error) {
          browserError = error instanceof Error ? error.message : String(error);
        }
      }
      return JSON.stringify({
        bridge: {
          connected_profiles: clients.length,
          selected_client_id: selected?.clientId || null,
          selection_required: clients.length > 1 && !selected,
        },
        browser,
        browser_error: browserError,
        history_index: getDelegateHistoryIndexStats(selected?.clientId),
      });
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateRunUntilDoneTool: Tool = {
  name: "delegate.run_until_done",
  description: "Send one task and monitor ChatGPT until an explicit completion marker appears. Continuation count and total runtime are bounded. Optional stall recovery may stop a stalled generation before sending a distinct 'continue until done'.",
  parameters: schema({
    ...optionalTarget,
    message: { type: "string", minLength: 1, maxLength: 100_000 },
    maxContinuations: { type: "integer", minimum: 0, maximum: 8 },
    pollMs: { type: "integer", minimum: 500, maximum: 5000 },
    stallMs: { type: "integer", minimum: 15000, maximum: 300000 },
    maxRuntimeMs: { type: "integer", minimum: 30000, maximum: 900000 },
    recoverStall: { type: "boolean" },
    completionMarker: { type: "string", minLength: 1, maxLength: 120 },
  }, ["message"]),
  async execute(args, _cwd, signal) {
    try {
      return JSON.stringify(await runDelegateUntilDone({
        clientId: typeof args.clientId === "string" ? args.clientId : undefined,
        tabId: args.tabId as number | undefined,
        message: String(args.message || ""),
        maxContinuations: args.maxContinuations as number | undefined,
        pollMs: args.pollMs as number | undefined,
        stallMs: args.stallMs as number | undefined,
        maxRuntimeMs: args.maxRuntimeMs as number | undefined,
        recoverStall: args.recoverStall === true,
        completionMarker: typeof args.completionMarker === "string" ? args.completionMarker : undefined,
      }, signal));
    } catch (error) {
      return "Error: " + (error instanceof Error ? error.message : String(error));
    }
  },
};

export const delegateSendMessageTool: Tool = tool(
  "delegate.send_message",
  "Send once to the chosen Chrome profile (clientId) and optional tabId. If ChatGPT later shows its delivery-timeout banner, the extension sends one distinct guarded follow-up, 'continue until done'; it never clicks Retry or resends the original message. If no ChatGPT tab exists and tabId is omitted, Delegate opens https://chatgpt.com/ automatically and waits for readiness before the single send. Transport/RPC timeouts are never retried. With multiple connections, selection is mandatory.",
  schema({
    ...optionalTarget,
    message: { type: "string", minLength: 1, maxLength: 100_000 },
  }, ["message"]),
  30_000, true,
);

export const delegateStopGenerationTool: Tool = tool(
  "delegate.stop_generation",
  "Stop ChatGPT generation only on explicit invocation, directed to an optional clientId and tabId. If no ChatGPT tab exists and tabId is omitted, Delegate may open https://chatgpt.com/ first; an explicit missing tabId never falls back. Never used as timeout recovery.",
  schema(optionalTarget),
);
