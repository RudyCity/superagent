import type { Tool } from "./types.js";
import { delegateBridge, type DelegateMethod } from "../delegate/bridge.js";

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
  "Start a new ChatGPT chat exactly once. For multiple Chrome profiles choose clientId from delegate.read_chat({connections:true}). Optional tabId selects an exact ChatGPT tab. Never reloads to recover.",
  schema(optionalTarget),
);

export const delegateReadChatTool: Tool = tool(
  "delegate.read_chat",
  "Read the selected ChatGPT chat (no side effects). Use {connections:true} to list connected Chrome profiles and clientId values. With multiple connections choose clientId explicitly.",
  schema({ ...optionalTarget, connections: {
    type: "boolean", description: "Return list of connected Chrome profiles without accessing any ChatGPT tabs.",
  } }),
  20_000, false, true,
);

export const delegateSendMessageTool: Tool = tool(
  "delegate.send_message",
  "Send once to the chosen Chrome profile (clientId) and optional tabId. Never resend on timeout. With multiple connections, selection is mandatory.",
  schema({
    ...optionalTarget,
    message: { type: "string", minLength: 1, maxLength: 100_000 },
  }, ["message"]),
  30_000, true,
);

export const delegateStopGenerationTool: Tool = tool(
  "delegate.stop_generation",
  "Stop ChatGPT generation only on explicit invocation, directed to an optional clientId and tabId. Never used as timeout recovery.",
  schema(optionalTarget),
);
