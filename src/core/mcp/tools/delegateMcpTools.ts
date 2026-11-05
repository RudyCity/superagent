/* MCP entrypoints for the single host-owned Delegate Chrome bridge.
 * The MCP transport may run in another process: never instantiate a second
 * DelegateBridge and never re-send chat messages on HTTP/network failures. */
import { getServerAuthToken } from "../../utils/serverSecurity.js";

export const DELEGATE_MCP_TOOL_NAMES = {
  read: "superagent_delegate_read_chat",
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
const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const, properties, required, additionalProperties: false,
});

export const DELEGATE_MCP_TOOL_DEFS = [
  {
    name: DELEGATE_MCP_TOOL_NAMES.read,
    description: "Read the current ChatGPT chat through the connected Delegate extension, or list paired Chrome profiles with {connections:true}. If no ChatGPT tab exists and tabId is omitted, Delegate opens https://chatgpt.com/ automatically before reading; connections:true never opens a tab.",
    inputSchema: schema({
      ...optionalTarget,
      connections: { type: "boolean", description: "Only list paired Chrome Delegate profiles; no ChatGPT DOM read." },
    }),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.create,
    description: "Explicitly start a new ChatGPT chat once. If no ChatGPT tab exists and tabId is omitted, Delegate opens https://chatgpt.com/ automatically and waits for readiness. Requires MCP write permission; never reloads or retries a click.",
    inputSchema: schema(optionalTarget),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.send,
    description: "Send one message through the selected ChatGPT web tab. If no ChatGPT tab exists and tabId is omitted, Delegate opens https://chatgpt.com/ automatically and waits for readiness before the single send. Requires MCP write permission; never retries on timeout or disconnection.",
    inputSchema: schema({
      ...optionalTarget,
      message: { type: "string", minLength: 1, maxLength: 100_000 },
    }, ["message"]),
  },
  {
    name: DELEGATE_MCP_TOOL_NAMES.stop,
    description: "Explicitly click Stop generation in the selected ChatGPT tab. If no ChatGPT tab exists and tabId is omitted, Delegate may open https://chatgpt.com/ first; an explicit missing tabId never falls back. Requires MCP write permission; never runs automatically.",
    inputSchema: schema(optionalTarget),
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
    ? ["clientId", "tabId", "message"]
    : name === DELEGATE_MCP_TOOL_NAMES.read
      ? ["clientId", "tabId", "connections"]
      : ["clientId", "tabId"];
  if (keys.some(key => !allowed.includes(key))) return "DELEGATE_UNEXPECTED_ARGUMENT";
  if (args.clientId !== undefined &&
    (typeof args.clientId !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(args.clientId)))
    return "DELEGATE_INVALID_CLIENT_ID";
  if (args.tabId !== undefined && (!Number.isSafeInteger(args.tabId) || Number(args.tabId) < 1))
    return "DELEGATE_INVALID_TAB_ID";
  if (name === DELEGATE_MCP_TOOL_NAMES.read && args.connections !== undefined) {
    if (typeof args.connections !== "boolean") return "DELEGATE_INVALID_CONNECTIONS";
    if (args.connections === true && keys.some(key => key !== "connections"))
      return "DELEGATE_CONNECTION_LIST_EXCLUSIVE";
  }
  if (name === DELEGATE_MCP_TOOL_NAMES.send &&
    (typeof args.message !== "string" || !args.message.trim() || args.message.length > 100_000))
    return "DELEGATE_INVALID_MESSAGE";
  return null;
}

export async function dispatchDelegateMcpTool(
  name: string, args: Record<string, unknown>,
): Promise<{ content: Array<{type: "text"; text: string}>; isError?: boolean } | null> {
  if (!nameSet.has(name)) return null;
  const invalid = validateDelegateMcpArgs(name, args);
  if (invalid) return { content: [{ type: "text", text: invalid }], isError: true };

  // Only the loopback SuperAgent server owns the authenticated Chrome bridge.
  // Credentials never enter tool arguments, logs, or a browser.
  const port = 7888;
  try {
    const token = getServerAuthToken(port);
    const response = await fetch(`http://127.0.0.1:${port}/api/delegate/mcp-dispatch`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(name === DELEGATE_MCP_TOOL_NAMES.send ? 36_000 : 26_000),
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
  } catch {
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
