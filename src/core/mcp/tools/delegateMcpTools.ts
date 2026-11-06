/* MCP entrypoints for the single host-owned Delegate Chrome bridge.
 * The MCP transport may run in another process: never instantiate a second
 * DelegateBridge and never re-send chat messages on HTTP/network failures. */
import { getServerAuthToken } from "../../utils/serverSecurity.js";
import {
  signDelegateForwardedRequest, runWithTrustedDelegateForwardingConnection,
} from "../../browserTransport/delegateForwardedPrincipal.js";
import type { AuthenticatedDelegateMcpConnection } from "../../browserTransport/delegatePrincipalPolicy.js";

export const DELEGATE_MCP_TOOL_NAMES = {
  read: "superagent_delegate_read_chat",
  list: "superagent_delegate_list_chats",
  readFull: "superagent_delegate_read_chat_full",
  search: "superagent_delegate_search_history",
  sync: "superagent_delegate_sync_history",
  searchIndex: "superagent_delegate_search_index",
  doctor: "superagent_delegate_doctor",
  runUntilDone: "superagent_delegate_run_until_done",
  create: "superagent_delegate_create_chat",
  send: "superagent_delegate_send_message",
  stop: "superagent_delegate_stop_generation",
} as const;
export type DelegateMcpToolName = typeof DELEGATE_MCP_TOOL_NAMES[keyof typeof DELEGATE_MCP_TOOL_NAMES];

const clientId = {
  type: "string", minLength: 8, maxLength: 80,
  description: "Chrome Delegate profile ID from superagent_delegate_read_chat({connections:true}); required if multiple profiles are online.",
};
const tabId = {
  type: "integer", minimum: 1,
  description: "Exact ChatGPT tab ID. If several protected tabs remain, specify this explicitly.",
};
const optionalTarget = { clientId, tabId };
const requestId = {
  type: "string", minLength: 8, maxLength: 80,
  description: "Stable idempotency key. Reuse never re-dispatches, including after uncertain RPC outcomes.",
};
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const, properties, required, additionalProperties: false,
});

export const DELEGATE_MCP_TOOL_DEFS = [
  {
    name: DELEGATE_MCP_TOOL_NAMES.read,
    description: "Read the current ChatGPT chat through the connected Delegate extension, or list paired Chrome profiles with {connections:true}. Detects ChatGPT's visible delivery-timeout banner as status=delivery_timeout; the extension handles that UI state with one guarded 'continue until done' follow-up without clicking Retry. If no ChatGPT tab exists and tabId is omitted, Delegate opens https://chatgpt.com/ automatically before reading; connections:true never opens a tab.",
    inputSchema: schema({
      ...optionalTarget,
      connections: { type: "boolean", description: "Only list paired Chrome Delegate profiles; no ChatGPT DOM read." },
    }),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.list,
    description: "List ChatGPT history from the connected Chrome profile using an inactive read-only worker tab. Scrolls the Chat history sidebar to load older chats; paginate with cursor/limit until next_cursor is null.",
    inputSchema: schema({
      clientId,
      cursor: { type: "integer", minimum: 0, maximum: 5000 },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    }),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.readFull,
    description: "Read a historical ChatGPT conversation by chatId through an inactive read-only worker tab, including older/virtualized turns. Paginate message output with cursor/limit.",
    inputSchema: schema({
      clientId,
      chatId: { type: "string", minLength: 8, maxLength: 180 },
      cursor: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 80 },
    }, ["chatId"]),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.search,
    description: "Search ChatGPT history titles and message content without modifying the user's active chat. Scans up to maxChats conversations and returns matching chats with snippets.",
    inputSchema: schema({
      clientId,
      query: { type: "string", minLength: 1, maxLength: 500 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
      maxChats: { type: "integer", minimum: 1, maximum: 500 },
    }, ["query"]),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.sync,
    description: "Incrementally sync ChatGPT history into the local Delegate SQLite index without changing the active chat.",
    inputSchema: schema({
      clientId,
      maxChats: { type: "integer", minimum: 1, maximum: 500 },
      refreshRecent: { type: "integer", minimum: 0, maximum: 100 },
      force: { type: "boolean" },
    }),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.searchIndex,
    description: "Search the local Delegate SQLite history index without browser navigation.",
    inputSchema: schema({
      clientId,
      query: { type: "string", minLength: 1, maxLength: 500 },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }, ["query"]),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.doctor,
    description: "Read-only Delegate diagnostics for bridge, browser DOM compatibility, and local history-index health.",
    inputSchema: schema({ clientId, tabId }),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.runUntilDone,
    description: "Send and monitor on an explicit clientId/tabId. Holds the shared target lock; never replays uncertain sends.",
    inputSchema: schema({
      clientId,
      tabId,
      requestId,
      message: { type: "string", minLength: 1, maxLength: 100_000 },
      maxContinuations: { type: "integer", minimum: 0, maximum: 8 },
      pollMs: { type: "integer", minimum: 500, maximum: 5000 },
      stallMs: { type: "integer", minimum: 15000, maximum: 300000 },
      maxRuntimeMs: { type: "integer", minimum: 30000, maximum: 900000 },
      recoverStall: { type: "boolean" },
      completionMarker: { type: "string", minLength: 1, maxLength: 120 },
    }, ["message"]),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.create,
    description: "Start a ChatGPT chat on explicit clientId/tabId, or newTab:true for an independent tab in clientId.",
    inputSchema: schema({ ...optionalTarget, requestId, newTab: { type: "boolean", description: "Open an independent ChatGPT tab; mutually exclusive with tabId." } }),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.send,
    description: "Send once to explicit clientId and tabId; optional requestId prevents replay after uncertain RPC outcomes. No implicit tab fallback.",
    inputSchema: schema({
      ...optionalTarget,
      requestId,
      message: { type: "string", minLength: 1, maxLength: 100_000 },
    }, ["message"]),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.stop,
    description: "Explicit Stop generation only for clientId/tabId; no implicit fallback or automatic retry.",
    inputSchema: schema({ ...optionalTarget, requestId }),
  },
];

const nameSet = new Set<string>(Object.values(DELEGATE_MCP_TOOL_NAMES));
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Redacted summary for MCP activity, even when tunneled through tool_execute.
 * Delegate chat text and outgoing messages must never enter activity journals.
 */
export function delegateMcpObservation(name: string, args: unknown): {
  args: Record<string, unknown>;
  error: (text: string) => string;
} | null {
  const nested = name === "superagent_tool_execute" && isPlainObject(args) &&
    typeof args.name === "string" && nameSet.has(args.name)
    ? args.name : null;
  const target = nameSet.has(name) ? name : nested;
  if (!target) return null;
  const options = nested ? (isPlainObject(args) ? args.arguments : undefined) : args;
  const values = isPlainObject(options) ? options : {};
  return {
    args: {
      delegateTool: target,
      connections: values.connections === true,
      tabSpecified: values.tabId !== undefined,
      profileSpecified: values.clientId !== undefined,
      messageBytes: typeof values.message === "string" ? Buffer.byteLength(values.message, "utf8") : 0,
      contentRedacted: true,
    },
    error: (text: string): string => {
      const code = String(text).match(/(?:DELEGATE|CHATGPT)_[A-Z_]+/);
      return code ? code[0] : "DELEGATE_TOOL_FAILED";
    },
  };
}

export function validateDelegateMcpArgs(name: string, args: unknown): string | null {
  if (!nameSet.has(name)) return "DELEGATE_UNKNOWN_MCP_TOOL";
  if (!isPlainObject(args)) return "DELEGATE_INVALID_ARGUMENTS";
  const keys = Object.keys(args);
  const allowed = name === DELEGATE_MCP_TOOL_NAMES.send
    ? ["clientId", "tabId", "message", "requestId"]
    : name === DELEGATE_MCP_TOOL_NAMES.create
      ? ["clientId", "tabId", "newTab", "requestId"]
      : name === DELEGATE_MCP_TOOL_NAMES.read
      ? ["clientId", "tabId", "connections"]
      : name === DELEGATE_MCP_TOOL_NAMES.list
        ? ["clientId", "cursor", "limit"]
        : name === DELEGATE_MCP_TOOL_NAMES.readFull
          ? ["clientId", "chatId", "cursor", "limit"]
          : name === DELEGATE_MCP_TOOL_NAMES.search
            ? ["clientId", "query", "limit", "maxChats"]
            : name === DELEGATE_MCP_TOOL_NAMES.sync
              ? ["clientId", "maxChats", "refreshRecent", "force"]
              : name === DELEGATE_MCP_TOOL_NAMES.searchIndex
                ? ["clientId", "query", "limit"]
                : name === DELEGATE_MCP_TOOL_NAMES.doctor
                  ? ["clientId", "tabId"]
                  : name === DELEGATE_MCP_TOOL_NAMES.runUntilDone
                    ? ["clientId", "tabId", "message", "maxContinuations", "pollMs", "stallMs", "maxRuntimeMs", "recoverStall", "completionMarker", "requestId"]
                    : ["clientId", "tabId", "requestId"];
  if (keys.some(key => !allowed.includes(key))) return "DELEGATE_UNEXPECTED_ARGUMENT";
  if (args.clientId !== undefined &&
    (typeof args.clientId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId)))
    return "DELEGATE_INVALID_CLIENT_ID";
  if (args.tabId !== undefined && (!Number.isSafeInteger(args.tabId) || Number(args.tabId) < 1))
    return "DELEGATE_INVALID_TAB_ID";
  if (args.requestId !== undefined && (typeof args.requestId !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(args.requestId)))
    return "DELEGATE_INVALID_REQUEST_ID";
  if (name === DELEGATE_MCP_TOOL_NAMES.create) {
    if (args.newTab !== undefined && typeof args.newTab !== "boolean")
      return "DELEGATE_INVALID_NEW_TAB";
    if (args.newTab === true && args.tabId !== undefined)
      return "DELEGATE_NEW_TAB_WITH_TAB_ID";
  }
  if (name === DELEGATE_MCP_TOOL_NAMES.read && args.connections !== undefined) {
    if (typeof args.connections !== "boolean") return "DELEGATE_INVALID_CONNECTIONS";
    if (args.connections === true && keys.some(key => key !== "connections"))
      return "DELEGATE_CONNECTION_LIST_EXCLUSIVE";
  }
  if (name === DELEGATE_MCP_TOOL_NAMES.send &&
    (typeof args.message !== "string" || !args.message.trim() || args.message.length > 100_000))
    return "DELEGATE_INVALID_MESSAGE";
  if (name === DELEGATE_MCP_TOOL_NAMES.list) {
    if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || Number(args.cursor) < 0 || Number(args.cursor) > 5000))
      return "DELEGATE_INVALID_CURSOR";
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 200))
      return "DELEGATE_INVALID_LIMIT";
  }
  if (name === DELEGATE_MCP_TOOL_NAMES.readFull) {
    if (typeof args.chatId !== "string" || !/^[a-zA-Z0-9:_-]{8,180}$/.test(args.chatId))
      return "DELEGATE_INVALID_CHAT_ID";
    if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || Number(args.cursor) < 0))
      return "DELEGATE_INVALID_CURSOR";
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 80))
      return "DELEGATE_INVALID_LIMIT";
  }
  if (name === DELEGATE_MCP_TOOL_NAMES.search || name === DELEGATE_MCP_TOOL_NAMES.searchIndex) {
    if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 500)
      return "DELEGATE_INVALID_QUERY";
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 50))
      return "DELEGATE_INVALID_LIMIT";
  }
  if (name === DELEGATE_MCP_TOOL_NAMES.search &&
      args.maxChats !== undefined && (!Number.isSafeInteger(args.maxChats) || Number(args.maxChats) < 1 || Number(args.maxChats) > 500))
    return "DELEGATE_INVALID_MAX_CHATS";
  if (name === DELEGATE_MCP_TOOL_NAMES.sync) {
    if (args.maxChats !== undefined && (!Number.isSafeInteger(args.maxChats) || Number(args.maxChats) < 1 || Number(args.maxChats) > 500))
      return "DELEGATE_INVALID_MAX_CHATS";
    if (args.refreshRecent !== undefined && (!Number.isSafeInteger(args.refreshRecent) || Number(args.refreshRecent) < 0 || Number(args.refreshRecent) > 100))
      return "DELEGATE_INVALID_REFRESH_RECENT";
    if (args.force !== undefined && typeof args.force !== "boolean")
      return "DELEGATE_INVALID_FORCE";
  }
  if (name === DELEGATE_MCP_TOOL_NAMES.runUntilDone) {
    if (typeof args.message !== "string" || !args.message.trim() || args.message.length > 100_000)
      return "DELEGATE_INVALID_MESSAGE";
    if (args.maxContinuations !== undefined && (!Number.isSafeInteger(args.maxContinuations) || Number(args.maxContinuations) < 0 || Number(args.maxContinuations) > 8))
      return "DELEGATE_INVALID_CONTINUATIONS";
    if (args.pollMs !== undefined && (!Number.isSafeInteger(args.pollMs) || Number(args.pollMs) < 500 || Number(args.pollMs) > 5000))
      return "DELEGATE_INVALID_POLL_MS";
    if (args.stallMs !== undefined && (!Number.isSafeInteger(args.stallMs) || Number(args.stallMs) < 15000 || Number(args.stallMs) > 300000))
      return "DELEGATE_INVALID_STALL_MS";
    if (args.maxRuntimeMs !== undefined && (!Number.isSafeInteger(args.maxRuntimeMs) || Number(args.maxRuntimeMs) < 30000 || Number(args.maxRuntimeMs) > 900000))
      return "DELEGATE_INVALID_RUNTIME_MS";
    if (args.recoverStall !== undefined && typeof args.recoverStall !== "boolean")
      return "DELEGATE_INVALID_RECOVER_STALL";
    if (args.completionMarker !== undefined && (typeof args.completionMarker !== "string" || !args.completionMarker.trim() || args.completionMarker.length > 120))
      return "DELEGATE_INVALID_COMPLETION_MARKER";
  }
  return null;
}

/** Delegate-browser MCP calls use the existing Core bridge, never a second WS listener. */
export async function dispatchDelegateBrowserMcpTool(
  name: "superagent_chrome_cdp" | "superagent_chrome_vision",
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const port = 7888;
    const signedBody = signDelegateForwardedRequest(name, args);
    const token = getServerAuthToken(port);
    const response = await fetch("http://127.0.0.1:" + port + "/api/delegate/mcp-dispatch", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(signedBody),
      signal: AbortSignal.timeout(name === "superagent_chrome_vision" ? 180_000 : 95_000),
    });
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) throw new Error("DELEGATE_HOST_INVALID_RESPONSE");
    if (response.ok && payload.success === true && typeof payload.result === "string") {
      return { content: [{ type: "text", text: payload.result }] };
    }
    return { content: [{ type: "text", text: typeof payload.error === "string"
      ? payload.error : "DELEGATE_CDP_HOST_REQUEST_FAILED" }], isError: true };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (/^DELEGATE_FORWARD_[A-Z_]+$/.test(code))
      return { content: [{ type: "text", text: code }], isError: true };
    return { content: [{ type: "text", text: "DELEGATE_CDP_HOST_UNAVAILABLE_OR_TIMEOUT: Core at 127.0.0.1:7888 did not confirm the browser operation. No retry was performed; inspect the tab before attempting a write again." }], isError: true };
  }
}

export async function dispatchDelegateMcpTool(
  name: string, args: Record<string, unknown>,
  trustedConnection?: AuthenticatedDelegateMcpConnection,
): Promise<{ content: Array<{type: "text"; text: string}>; isError?: boolean } | null> {
  if (!nameSet.has(name)) return null;
  if (trustedConnection) return runWithTrustedDelegateForwardingConnection(
    trustedConnection, () => dispatchDelegateMcpTool(name, args),
  );
  const invalid = validateDelegateMcpArgs(name, args);
  if (invalid) return { content: [{ type: "text", text: invalid }], isError: true };

  // Only the loopback SuperAgent server owns the authenticated Chrome bridge.
  // Credentials never enter tool arguments, logs, or a browser.
  const port = 7888;
  try {
    const signedBody = signDelegateForwardedRequest(name, args);
    const token = getServerAuthToken(port);
    const timeoutMs = name === DELEGATE_MCP_TOOL_NAMES.runUntilDone ? 910_000
      : name === DELEGATE_MCP_TOOL_NAMES.sync ? 910_000
        : name === DELEGATE_MCP_TOOL_NAMES.search ? 305_000
          : name === DELEGATE_MCP_TOOL_NAMES.readFull ? 95_000
            : name === DELEGATE_MCP_TOOL_NAMES.list ? 65_000
              : name === DELEGATE_MCP_TOOL_NAMES.send ? 36_000 : 26_000;
    const response = await fetch(`http://127.0.0.1:${port}/api/delegate/mcp-dispatch`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(signedBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload: unknown = await response.json();
    if (!isPlainObject(payload)) throw new Error("DELEGATE_HOST_INVALID_RESPONSE");
    if (response.ok && payload.success === true && typeof payload.result === "string") {
      return { content: [{ type: "text", text: payload.result }] };
    }
    return {
      content: [{
        type: "text",
        text: typeof payload.error === "string" ? payload.error : "DELEGATE_HOST_REQUEST_FAILED",
      }],
      isError: true,
    };
  } catch (error) {
    const code = error instanceof Error ? error.message : "";
    if (/^DELEGATE_FORWARD_[A-Z_]+$/.test(code))
      return { content: [{ type: "text", text: code }], isError: true };
    // A transport timeout is NOT evidence the host did not click Send.
    // Never retry a mutation automatically; caller must inspect read_chat.
    return {
      content: [{
        type: "text",
        text: "DELEGATE_HOST_UNAVAILABLE_OR_TIMEOUT: Local SuperAgent server on 127.0.0.1:7888 did not confirm the Delegate RPC. Verify the server is rebuilt and running. Do NOT automatically retry create_chat, send_message or stop_generation; inspect read_chat first.",
      }],
      isError: true,
    };
  }
}
