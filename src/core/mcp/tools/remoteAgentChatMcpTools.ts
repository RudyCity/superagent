import type { McpToolResult } from "../types.js";
import { loadRemoteAgentConfig } from "../../remoteAgent/config.js";
import { getMuseWatcher, isMuseWatcherActive } from "../../remoteAgent/museWatcherRegistry.js";
import { asResult, errorResult, DEFAULT_MUSE_CHAT_TIMEOUT_MS, MAX_MUSE_CHAT_TIMEOUT_MS, MAX_TELEGRAM_TEXT_LENGTH, resolveMusePort, safeErrorMessage } from "./remoteAgentMcpShared.js";

export interface MuseChatReadiness {
  ok: boolean;
  port: number;
  watcherActive: boolean;
  transportType: "websocket" | "telegram" | "https" | "none";
  connected: boolean;
  canChat: boolean;
  reason?: string;
}

export function getMuseChatReadiness(portArg?: unknown): MuseChatReadiness {
  const config = loadRemoteAgentConfig();
  let port = config.wsPort || 9225;
  try {
    port = resolveMusePort(portArg, config);
  } catch (error) {
    return {
      ok: false,
      port,
      watcherActive: false,
      transportType: "none",
      connected: false,
      canChat: false,
      reason: safeErrorMessage(error, config),
    };
  }

  const watcher = isMuseWatcherActive(port) ? getMuseWatcher(port) : null;
  if (!watcher) {
    return {
      ok: false,
      port,
      watcherActive: false,
      transportType: "none",
      connected: false,
      canChat: false,
      reason: `No active Muse watcher on WebSocket port ${port}. Start it with superagent_muse_tunnel_start, then connect Muse.`,
    };
  }

  const transport = watcher.getTransport();
  if (transport.type !== "websocket") {
    return {
      ok: false,
      port,
      watcherActive: true,
      transportType: transport.type,
      connected: transport.isConnected(),
      canChat: false,
      reason: `Muse watcher on port ${port} uses ${transport.type}, not WebSocket. Two-way MCP chat requires the Muse tunnel transport.`,
    };
  }

  if (!transport.isConnected()) {
    return {
      ok: false,
      port,
      watcherActive: true,
      transportType: transport.type,
      connected: false,
      canChat: false,
      reason: `Muse WebSocket on port ${port} is not connected. Start the tunnel and connect the Muse client first.`,
    };
  }

  return {
    ok: true,
    port,
    watcherActive: true,
    transportType: transport.type,
    connected: true,
    canChat: true,
  };
}

export async function handleMuseChatStatus(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const readiness = getMuseChatReadiness(args.port);
  return asResult({
    ok: readiness.ok,
    port: readiness.port,
    watcherActive: readiness.watcherActive,
    transportType: readiness.transportType,
    connected: readiness.connected,
    canChat: readiness.canChat,
    reason: readiness.reason,
  });
}

export async function handleMuseChat(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const config = loadRemoteAgentConfig();
  const rawText = args.text ?? args.message;
  if (typeof rawText !== "string" || !rawText.trim()) {
    return errorResult("'text' is required and must contain a non-empty message.");
  }

  const text = rawText.trim();
  if (text.length > MAX_TELEGRAM_TEXT_LENGTH) {
    return errorResult(`Message exceeds the ${MAX_TELEGRAM_TEXT_LENGTH}-character limit.`);
  }

  const readiness = getMuseChatReadiness(args.port);
  if (!readiness.ok) {
    return errorResult(readiness.reason || "Muse direct chat is not ready.");
  }

  const timeoutRaw = args.timeoutMs ?? DEFAULT_MUSE_CHAT_TIMEOUT_MS;
  if (typeof timeoutRaw !== "number" || !Number.isInteger(timeoutRaw) || timeoutRaw < 1_000 || timeoutRaw > MAX_MUSE_CHAT_TIMEOUT_MS) {
    return errorResult(`'timeoutMs' must be an integer between 1000 and ${MAX_MUSE_CHAT_TIMEOUT_MS}.`);
  }

  const watcher = getMuseWatcher(readiness.port);
  if (!watcher) {
    return errorResult(`Muse watcher on port ${readiness.port} is not available in this Superagent runtime.`);
  }

  try {
    const result = await watcher.requestChat(text, timeoutRaw);
    return asResult({
      ok: true,
      state: "reply_received",
      transport: "mcp-to-muse-websocket",
      port: readiness.port,
      requestId: result.requestId,
      responseId: result.responseId,
      reply: result.reply,
    });
  } catch (error) {
    return errorResult(safeErrorMessage(error, config));
  }
}

export const REMOTE_AGENT_CHAT_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_muse_chat_status: "safe",
  superagent_muse_chat: "dangerous",
};

export const REMOTE_AGENT_CHAT_MCP_TOOL_DEFS = [
  {
    name: "superagent_muse_chat_status",
    description: "Check whether the Muse two-way chat path is ready. Reports watcher, transport, and WebSocket connection state without sending a message.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Optional Muse WebSocket port. Defaults to the configured port or 9225." },
      },
    },
  },
  {
    name: "superagent_muse_chat",
    description: "Have a two-way conversation with Muse over the authenticated Muse WebSocket tunnel. Sends one conversational message and waits for a correlated reply from Muse; it is not a task-execution API. Requires an active Muse watcher and connected Muse client.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message or question to discuss with Muse. Maximum 12000 characters." },
        port: { type: "number", description: "Optional Muse WebSocket port. Defaults to the configured port or 9225." },
        timeoutMs: { type: "number", description: "Optional wait timeout for Muse's correlated reply, integer from 1000 to 120000. Defaults to 30000." },
      },
      required: ["text"],
    },
  },
];
