import { randomUUID } from "node:crypto";
import type { McpToolResult } from "../types.js";
import {
  generateSecureWsToken,
  getWatchedWorkspaces,
  loadRemoteAgentConfig,
  updateRemoteAgentConfig,
  type RemoteAgentConfig,
} from "../../remoteAgent/config.js";
import {
  getTunnelStatus,
  isSameTunnelTarget,
} from "../../remoteAgent/cloudflareTunnel.js";
import {
  getMuseWatcher,
  isMuseWatcherActive,
  startMuseWatcher,
  stopMuseWatcher,
} from "../../remoteAgent/museWatcherRegistry.js";
import { stopOwnedMuseTunnel } from "../../remoteAgent/museWatcherTunnel.js";
import { MuseClient } from "../../remoteAgent/museClient.js";
import type { ChatEnvelope } from "../../remoteAgent/protocol.js";

const DEFAULT_MUSE_WS_PORT = 9225;
const MAX_TELEGRAM_TEXT_LENGTH = 12_000;

type TunnelActionResult = {
  state: "started" | "already_running" | "restarted";
  service: "muse-websocket";
  port: number;
  publicUrl?: string;
  wssUrl?: string;
  localUrl?: string;
  watcherActive: boolean;
  museConnected: boolean;
  workspaceCount: number;
};

function asResult(value: unknown, isError = false): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function errorResult(message: string): McpToolResult {
  return asResult({ ok: false, error: message }, true);
}

function resolvePort(raw: unknown, config: RemoteAgentConfig): number {
  const configured = config.wsPort || DEFAULT_MUSE_WS_PORT;
  if (raw === undefined || raw === null) {
    if (!Number.isInteger(configured) || configured < 1024 || configured > 65535) {
      throw new Error("The configured Muse WebSocket port is invalid. Set wsPort to an integer between 1024 and 65535.");
    }
    return configured;
  }
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1024 || raw > 65535) {
    throw new Error("'port' must be an integer between 1024 and 65535.");
  }
  return raw;
}

function safeErrorMessage(error: unknown, config: RemoteAgentConfig): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [config.botToken, config.wsToken, config.cfAccessClientSecret]) {
    if (secret && secret.length >= 4) message = message.split(secret).join("[REDACTED]");
  }
  message = message.replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "[REDACTED_TELEGRAM_TOKEN]");
  return message.slice(0, 1200);
}

function prepareWebSocketConfig(config: RemoteAgentConfig): RemoteAgentConfig {
  if (config.wsMode === "client") {
    throw new Error("Muse is configured in WebSocket client mode. Switch to server mode before starting an inbound tunnel.");
  }
  if (config.wsToken) {
    return config.transport === "websocket"
      ? config
      : updateRemoteAgentConfig({ transport: "websocket" });
  }

  // Persist a random token, but never include it in the MCP result or logs.
  return updateRemoteAgentConfig({
    wsToken: generateSecureWsToken(),
    transport: "websocket",
  });
}

function expectedMuseLocalUrl(config: RemoteAgentConfig, port: number): string {
  return `http://${config.wsHost || "127.0.0.1"}:${port}`;
}

function resolveMuseWssUrl(
  status: ReturnType<typeof getTunnelStatus>,
  config: RemoteAgentConfig,
  fallback?: string
): string | undefined {
  if (status.wssUrl?.startsWith("wss://")) return status.wssUrl;
  if (fallback?.startsWith("wss://")) return fallback;
  if (!status.publicUrl) return undefined;
  try {
    const publicUrl = new URL(status.publicUrl);
    return `wss://${publicUrl.host}${config.wsPath || "/muse"}`;
  } catch {
    return undefined;
  }
}

function isMuseConnected(watcher: ReturnType<typeof getMuseWatcher> | undefined): boolean {
  try {
    const transport = (watcher as any)?.getTransport?.();
    return typeof transport?.isConnected === "function" && Boolean(transport.isConnected());
  } catch {
    return false;
  }
}

function assertMuseTunnelCanBeManaged(config: RemoteAgentConfig, port: number): ReturnType<typeof getTunnelStatus> {
  const status = getTunnelStatus(port);
  if (!status.isRunning) return status;

  if (status.serviceKind !== "muse-websocket") {
    throw new Error(
      `Port ${port} is occupied by ${status.serviceKind || "an unclassified tunnel"}. Refusing to stop or reuse it as a Muse tunnel.`
    );
  }

  if (!isSameTunnelTarget(status.localUrl, expectedMuseLocalUrl(config, port))) {
    throw new Error(
      `The Muse tunnel on port ${port} points to an unexpected local target. Refusing to modify it.`
    );
  }

  return status;
}

async function startMuseTunnelAtPort(port: number, requestedState: "started" | "already_running" | "restarted"): Promise<TunnelActionResult> {
  let config = loadRemoteAgentConfig();

  // Preflight before config mutation so a tunnel collision cannot switch the saved transport.
  const currentStatus = assertMuseTunnelCanBeManaged(config, port);
  config = prepareWebSocketConfig(config);
  const existingWatcher = isMuseWatcherActive(port) ? getMuseWatcher(port) : null;
  if (currentStatus.isRunning && !existingWatcher && requestedState !== "restarted") {
    return {
      state: "already_running",
      service: "muse-websocket",
      port,
      publicUrl: currentStatus.publicUrl,
      wssUrl: resolveMuseWssUrl(currentStatus, config),
      localUrl: currentStatus.localUrl,
      watcherActive: false,
      museConnected: false,
      workspaceCount: currentStatus.workspaces?.length || 0,
    };
  }
  if (existingWatcher && currentStatus.isRunning && requestedState !== "restarted") {
    const stats = existingWatcher.getStats();
    return {
      state: "already_running",
      service: "muse-websocket",
      port,
      publicUrl: currentStatus.publicUrl,
      wssUrl: resolveMuseWssUrl(currentStatus, loadRemoteAgentConfig(), stats.tunnelUrl),
      localUrl: currentStatus.localUrl,
      watcherActive: true,
      museConnected: isMuseConnected(existingWatcher),
      workspaceCount: stats.workspaces.length,
    };
  }

  const workspaces = getWatchedWorkspaces(config, process.cwd());
  const watcher = await startMuseWatcher({
    workspace: workspaces[0],
    workspaces,
    transportType: "websocket",
    tunnel: true,
    wsPort: port,
    announce: false,
  });

  const status = assertMuseTunnelCanBeManaged(config, port);
  const stats = watcher.getStats();
  const wssUrl = resolveMuseWssUrl(status, config, stats.tunnelUrl);

  if (!status.isRunning || !wssUrl) {
    // Do not claim success when the public endpoint was not recorded.
    await stopMuseWatcher(port).catch(() => false);
    throw new Error("Muse watcher started, but no verified Cloudflare WebSocket tunnel endpoint was reported.");
  }

  return {
    state: requestedState,
    service: "muse-websocket",
    port,
    publicUrl: status.publicUrl,
    wssUrl,
    localUrl: status.localUrl,
    watcherActive: isMuseWatcherActive(port),
    museConnected: isMuseConnected(watcher),
    workspaceCount: workspaces.length,
  };
}

export async function handleMuseTunnelStart(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const initialConfig = loadRemoteAgentConfig();
  let port: number;
  try {
    port = resolvePort(args.port, initialConfig);
    const currentStatus = assertMuseTunnelCanBeManaged(initialConfig, port);
    if (isMuseWatcherActive(port) && currentStatus.isRunning) {
      const stats = getMuseWatcher(port)?.getStats();
      return asResult({
        ok: true,
        state: "already_running",
        service: "muse-websocket",
        port,
        publicUrl: currentStatus.publicUrl,
        wssUrl: resolveMuseWssUrl(currentStatus, initialConfig, stats?.tunnelUrl),
        localUrl: currentStatus.localUrl,
        watcherActive: true,
        museConnected: isMuseConnected(getMuseWatcher(port) || undefined),
        workspaceCount: stats?.workspaces.length || 0,
      });
    }

    if (isMuseWatcherActive(port) && !currentStatus.isRunning) {
      await stopMuseWatcher(port);
    }

    const result = await startMuseTunnelAtPort(port, "started");
    return asResult({ ok: true, ...result });
  } catch (error) {
    return errorResult(safeErrorMessage(error, loadRemoteAgentConfig()));
  }
}

export async function handleMuseTunnelRestart(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const initialConfig = loadRemoteAgentConfig();
  try {
    const port = resolvePort(args.port, initialConfig);
    const before = assertMuseTunnelCanBeManaged(initialConfig, port);
    const config = prepareWebSocketConfig(initialConfig);
    const watcherWasActive = isMuseWatcherActive(port);

    if (watcherWasActive) {
      const stopped = await stopMuseWatcher(port);
      if (!stopped) throw new Error("Muse watcher was active but could not be stopped cleanly.");
    }

    // A watcher may have reused a tunnel created by another Superagent instance.
    // Restart it only after verifying its service kind and exact local target.
    const afterWatcherStop = assertMuseTunnelCanBeManaged(config, port);
    if (afterWatcherStop.isRunning) {
      const stoppedTunnel = await stopOwnedMuseTunnel(port);
      if (!stoppedTunnel) {
        throw new Error("The verified Muse tunnel is still running but its owning Cloudflare process could not be stopped safely.");
      }
    }

    const result = await startMuseTunnelAtPort(port, before.isRunning || watcherWasActive ? "restarted" : "started");
    return asResult({ ok: true, ...result });
  } catch (error) {
    return errorResult(safeErrorMessage(error, loadRemoteAgentConfig()));
  }
}

export async function handleTelegramSendToMuse(args: Record<string, unknown> = {}): Promise<McpToolResult> {
  const config = loadRemoteAgentConfig();
  const rawText = args.text ?? args.message;
  if (typeof rawText !== "string" || !rawText.trim()) {
    return errorResult("'text' is required and must contain a non-empty message.");
  }

  const text = rawText.trim();
  if (text.length > MAX_TELEGRAM_TEXT_LENGTH) {
    return errorResult(`Message exceeds the ${MAX_TELEGRAM_TEXT_LENGTH}-character limit.`);
  }

  if (!config.botToken || !config.groupId || !config.museBotId) {
    return errorResult(
      "Muse Telegram is not configured. Configure botToken, groupId, and museBotId with the existing Muse configuration before sending a message."
    );
  }

  try {
    const client = new MuseClient(config);
    const envelope: ChatEnvelope = {
      v: 1,
      kind: "chat",
      id: `mcp-chat-${randomUUID()}`,
      text,
    };
    const accepted = await client.sendEnvelope(envelope, config.groupId);
    if (!accepted) {
      return errorResult("Telegram did not confirm delivery of the Muse chat envelope. Check the bot token, group permissions, and Telegram API status.");
    }

    return asResult({
      ok: true,
      transport: "telegram",
      state: "accepted_by_telegram",
      groupId: config.groupId,
      museBotId: config.museBotId,
      messageLength: text.length,
      note: "Telegram accepted the message envelope. This does not confirm that Muse processed it.",
    });
  } catch (error) {
    return errorResult(safeErrorMessage(error, config));
  }
}

export const REMOTE_AGENT_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_muse_tunnel_start: "dangerous",
  superagent_muse_tunnel_restart: "dangerous",
  superagent_telegram_send_to_muse: "dangerous",
};

export const REMOTE_AGENT_MCP_TOOL_DEFS = [
  {
    name: "superagent_muse_tunnel_start",
    description: "Start the Muse WebSocket watcher and expose its verified local endpoint through a Cloudflare quick tunnel. Uses the saved Muse config and never returns the WebSocket bearer token.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Optional WebSocket port, integer from 1024 to 65535. Defaults to the configured Muse WebSocket port or 9225." },
      },
    },
  },
  {
    name: "superagent_muse_tunnel_restart",
    description: "Safely restart the Muse WebSocket watcher and its Cloudflare quick tunnel. Refuses to stop tunnels of another or unknown service type. Does not restart the MCP HTTP server.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "number", description: "Optional WebSocket port, integer from 1024 to 65535. Defaults to the configured Muse WebSocket port or 9225." },
      },
    },
  },
  {
    name: "superagent_telegram_send_to_muse",
    description: "Send an explicit chat message to Muse through the Telegram bot/group configured in Muse settings. Requires botToken, groupId, and museBotId; reports Telegram acceptance without claiming Muse processed it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message to send to Muse. Maximum 12000 characters." },
      },
      required: ["text"],
    },
  },
];

export async function dispatchRemoteAgentMcpTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<McpToolResult | null> {
  switch (name) {
    case "superagent_muse_tunnel_start":
      return handleMuseTunnelStart(args);
    case "superagent_muse_tunnel_restart":
      return handleMuseTunnelRestart(args);
    case "superagent_telegram_send_to_muse":
      return handleTelegramSendToMuse(args);
    default:
      return null;
  }
}
