/**
 * remoteStatusService.ts — Unified status detection for /muse tunnel, MCP, and Telegram services.
 *
 * Provides real-time inspection of:
 * 1. Cloudflare Quick Tunnels (/muse tunnel) & active Muse WebSocket watchers
 * 2. MCP servers (Cloudflare tunnel MCP servers & connected client MCPs)
 * 3. Telegram channels (Muse Watcher Telegram transport, fallback watcher, Gateway Telegram)
 */

import { listActiveTunnels, type ActiveTunnelInfo } from "./cloudflareTunnel.js";
import { getMuseWatcher, isMuseWatcherActive, TELEGRAM_FALLBACK_KEY } from "./museWatcherRegistry.js";
import { listActiveMcpServers, type ActiveMcpInfo } from "../mcp/mcpTunnel.js";
import { connectedServers } from "../mcp/McpManager.js";
import { gatewayManager } from "../gateway/gatewayManager.js";
import { loadRemoteAgentConfig } from "./config.js";

export interface TunnelServiceStatus {
  active: boolean;
  count: number;
  /** Whether a verified Muse WebSocket tunnel process is present. */
  tunnelProcessActive?: boolean;
  /** Routine status does not probe the local/public protocol endpoint. */
  endpointProbe?: "not-probed";
  /** True only when the Muse transport reports an authenticated live session. */
  museSessionAuthenticated?: boolean;
  /** Confirmed Muse WebSocket tunnels only. */
  tunnels: ActiveTunnelInfo[];
  /** Other known HTTP tunnels are reported here, not presented as Muse WSS. */
  otherTunnels?: ActiveTunnelInfo[];
  /** Legacy records without a service kind are surfaced separately, never assumed to be Muse. */
  unclassifiedTunnels?: ActiveTunnelInfo[];
  watcherActive: boolean;
  watcherTransport?: string;
  watcherDetails?: string;
  museConnected?: boolean;
  uptimeSeconds?: number;
  tasksCompleted?: number;
  batchesExecuted?: number;
  /** Task existence only; identity is workspace-scoped and withheld. */
  activeTaskPresent?: boolean;
}

export interface McpServiceStatus {
  active: boolean;
  tunnelServerCount: number;
  tunnelServers: ActiveMcpInfo[];
  clientServerCount: number;
  clientServers: Array<{
    name: string;
    status: string;
    toolCount: number;
    tools: string[];
    error?: string;
  }>;
}

export interface TelegramServiceStatus {
  active: boolean;
  museWatcherActive: boolean;
  museWatcherTransport?: string;
  museWatcherUptime?: number;
  museWatcherBatches?: number;
  museWatcherTasks?: number;
  museWatcherGroupId?: string | number;
  museWatcherBotId?: string | number;
  telegramFallbackActive: boolean;
  gatewayEnabled: boolean;
  gatewayConfigured: boolean;
  gatewayStats: {
    messagesReceived: number;
    messagesSent: number;
    errors: number;
  };
}

export interface RemoteServiceStatusResult {
  timestamp: number;
  anyActive: boolean;
  tunnel: TunnelServiceStatus;
  mcp: McpServiceStatus;
  telegram: TelegramServiceStatus;
}

/**
 * Checks live runtime status for /muse tunnel, MCP, and Telegram.
 */
export async function getRemoteServiceStatus(
  service: "all" | "tunnel" | "mcp" | "telegram" = "all"
): Promise<RemoteServiceStatusResult> {
  const checkTunnel = service === "all" || service === "tunnel";
  const checkMcp = service === "all" || service === "mcp";
  const checkTelegram = service === "all" || service === "telegram";

  // 1. Cloudflare Quick Tunnels & Muse Watcher
  let tunnelStatus: TunnelServiceStatus = {
    active: false,
    count: 0,
    tunnelProcessActive: false,
    endpointProbe: "not-probed",
    museSessionAuthenticated: false,
    tunnels: [],
    watcherActive: false,
  };

  if (checkTunnel) {
    try {
      const allActiveTunnels = listActiveTunnels();
      const activeMcpPorts = new Set(listActiveMcpServers().map((server) => server.port));
      const activeTunnels = allActiveTunnels.filter((t) => t.serviceKind === "muse-websocket");
      const otherTunnels = allActiveTunnels.filter(
        (t) => t.serviceKind === "superagent-http" ||
          (t.serviceKind === "mcp-http" && !activeMcpPorts.has(t.port))
      );
      const unclassifiedTunnels = allActiveTunnels.filter(
        (t) => (!t.serviceKind || t.serviceKind === "unknown") && !activeMcpPorts.has(t.port)
      );
      const watcherActive = isMuseWatcherActive();
      const watcher = getMuseWatcher();
      let watcherTransport: string | undefined;
      let watcherDetails: string | undefined;
      let museConnected = false;
      let uptimeSeconds: number | undefined;
      let tasksCompleted: number | undefined;
      let batchesExecuted: number | undefined;
      let activeTaskPresent = false;

      if (watcher && watcherActive) {
        const stats = watcher.getStats();
        watcherTransport = stats.transport;
        watcherDetails = stats.transportDetails;
        uptimeSeconds = stats.uptimeSeconds;
        tasksCompleted = stats.tasksCompleted;
        batchesExecuted = stats.batchesExecuted;
        activeTaskPresent = Boolean(stats.activeTaskId);

        try {
          const transport = watcher.getTransport();
          if (transport && typeof (transport as any).isConnected === "function") {
            museConnected = Boolean((transport as any).isConnected());
          }
        } catch {}
      }

      const isWatcherTunnelRelevant = watcherActive && watcherTransport !== "telegram";
      const isTunnelActive = activeTunnels.length > 0 || isWatcherTunnelRelevant;

      tunnelStatus = {
        active: isTunnelActive,
        count: activeTunnels.length,
        tunnelProcessActive: activeTunnels.length > 0,
        endpointProbe: "not-probed",
        museSessionAuthenticated: museConnected,
        tunnels: activeTunnels,
        otherTunnels,
        unclassifiedTunnels,
        watcherActive,
        watcherTransport,
        watcherDetails,
        museConnected,
        uptimeSeconds,
        tasksCompleted,
        batchesExecuted,
        activeTaskPresent,
      };
    } catch {}
  }

  // 2. MCP Servers (Exposed via Tunnel/HTTP and connected client MCPs)
  let mcpStatus: McpServiceStatus = {
    active: false,
    tunnelServerCount: 0,
    tunnelServers: [],
    clientServerCount: 0,
    clientServers: [],
  };

  if (checkMcp) {
    try {
      const activeMcpServers = listActiveMcpServers();
      const clientList: Array<{
        name: string;
        status: string;
        toolCount: number;
        tools: string[];
        error?: string;
      }> = [];

      if (connectedServers && typeof connectedServers.entries === "function") {
        for (const [name, conn] of connectedServers.entries()) {
          clientList.push({
            name,
            status: conn.status || "disconnected",
            toolCount: Array.isArray(conn.tools) ? conn.tools.length : 0,
            tools: Array.isArray(conn.tools) ? conn.tools : [],
            error: conn.error,
          });
        }
      }

      const hasConnectedClients = clientList.some((c) => c.status === "connected");
      const isMcpActive = activeMcpServers.length > 0 || hasConnectedClients;

      mcpStatus = {
        active: isMcpActive,
        tunnelServerCount: activeMcpServers.length,
        tunnelServers: activeMcpServers,
        clientServerCount: clientList.length,
        clientServers: clientList,
      };
    } catch {}
  }

  // 3. Telegram (Muse Telegram Watcher, Fallback Watcher, Gateway Telegram)
  let telegramStatus: TelegramServiceStatus = {
    active: false,
    museWatcherActive: false,
    telegramFallbackActive: false,
    gatewayEnabled: false,
    gatewayConfigured: false,
    gatewayStats: {
      messagesReceived: 0,
      messagesSent: 0,
      errors: 0,
    },
  };

  if (checkTelegram) {
    try {
      const watcher = getMuseWatcher();
      const watcherActive = isMuseWatcherActive();
      let isMuseTelegram = false;
      let museWatcherTransport: string | undefined;
      let museWatcherUptime: number | undefined;
      let museWatcherBatches: number | undefined;
      let museWatcherTasks: number | undefined;
      let museWatcherGroupId: string | number | undefined;
      let museWatcherBotId: string | number | undefined;

      if (watcher && watcherActive) {
        const stats = watcher.getStats();
        museWatcherTransport = stats.transport;
        museWatcherUptime = stats.uptimeSeconds;
        museWatcherBatches = stats.batchesExecuted;
        museWatcherTasks = stats.tasksCompleted;
        museWatcherGroupId = stats.groupId;
        museWatcherBotId = stats.museBotId;

        if (
          stats.transport === "telegram" ||
          (stats.transportDetails && stats.transportDetails.toLowerCase().includes("telegram"))
        ) {
          isMuseTelegram = true;
        }
      }

      const telegramFallbackActive = isMuseWatcherActive(TELEGRAM_FALLBACK_KEY);

      let gatewayEnabled = false;
      let gatewayConfigured = false;
      let gatewayStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };

      try {
        const gw = gatewayManager.getStatus();
        const tg = gw.channels?.telegram;
        if (tg) {
          gatewayEnabled = Boolean(tg.enabled);
          gatewayConfigured = Boolean(tg.configured);
          gatewayStats = {
            messagesReceived: tg.messagesReceived || 0,
            messagesSent: tg.messagesSent || 0,
            errors: tg.errors || 0,
          };
        }
      } catch {}

      const isTelegramActive = isMuseTelegram || telegramFallbackActive || (gatewayEnabled && gatewayConfigured);

      telegramStatus = {
        active: isTelegramActive,
        museWatcherActive: isMuseTelegram,
        museWatcherTransport,
        museWatcherUptime,
        museWatcherBatches,
        museWatcherTasks,
        museWatcherGroupId,
        museWatcherBotId,
        telegramFallbackActive,
        gatewayEnabled,
        gatewayConfigured,
        gatewayStats,
      };
    } catch {}
  }

  const anyActive =
    tunnelStatus.active ||
    Boolean(tunnelStatus.otherTunnels?.length) ||
    Boolean(tunnelStatus.unclassifiedTunnels?.length) ||
    mcpStatus.active ||
    telegramStatus.active;

  return {
    timestamp: Date.now(),
    anyActive,
    tunnel: tunnelStatus,
    mcp: mcpStatus,
    telegram: telegramStatus,
  };
}

/**
 * Formats status result into human-readable plain text without markdown embellishments.
 */
export function formatRemoteServiceStatus(
  status: RemoteServiceStatusResult,
  service: "all" | "tunnel" | "mcp" | "telegram" = "all",
  detailed: boolean = true
): string {
  const lines: string[] = [];
  const includeTunnel = service === "all" || service === "tunnel";
  const includeMcp = service === "all" || service === "mcp";
  const includeTelegram = service === "all" || service === "telegram";

  lines.push("Remote Services Status Overview:");
  lines.push(`Overall state: ${status.anyActive ? "ACTIVE (one or more services online)" : "INACTIVE (no active services)"}`);

  if (includeTunnel) {
    lines.push("");
    lines.push("[1] Muse Tunnel (/muse tunnel):");
    lines.push(`- Status: ${status.tunnel.active ? "ACTIVE" : "INACTIVE"}`);
    lines.push(`- Verified Muse tunnel process: ${status.tunnel.tunnelProcessActive ? "ACTIVE" : "INACTIVE"}`);
    lines.push("- Endpoint protocol probe: NOT PERFORMED (non-invasive status check)");
    lines.push(`- Muse authenticated session: ${status.tunnel.museSessionAuthenticated ? "YES" : "NO"}`);
    if (status.tunnel.tunnels.length > 0) {
      lines.push(`- Running Cloudflare tunnels: ${status.tunnel.tunnels.length}`);
      status.tunnel.tunnels.forEach((t, i) => {
        lines.push(`  - Tunnel ${i + 1}: Port ${t.port} (PID: ${t.pid}, Uptime: ${t.uptimeSeconds}s)`);
        lines.push(`    Public URL : ${t.publicUrl}`);
        if (t.wssUrl) lines.push(`    WSS URL    : ${t.wssUrl}`);
        if (t.localUrl) lines.push(`    Local URL  : ${t.localUrl}`);
        if (t.workspace) lines.push(`    Workspace  : ${t.workspace}`);
      });
    } else {
      lines.push("- Running Muse WebSocket tunnels: 0");
    }
    if (status.tunnel.otherTunnels && status.tunnel.otherTunnels.length > 0) {
      lines.push(`- Other service tunnels (not Muse WebSocket): ${status.tunnel.otherTunnels.length}`);
      status.tunnel.otherTunnels.forEach((t) => {
        lines.push(`  - Port ${t.port} (${t.serviceKind}) : ${t.publicUrl}`);
      });
    }
    if (status.tunnel.unclassifiedTunnels && status.tunnel.unclassifiedTunnels.length > 0) {
      lines.push(`- Unclassified quick tunnels: ${status.tunnel.unclassifiedTunnels.length} (legacy state; service type not verified)`);
      status.tunnel.unclassifiedTunnels.forEach((t) => {
        lines.push(`  - Port ${t.port} (PID: ${t.pid}) : ${t.publicUrl}`);
      });
    }
    if (status.tunnel.watcherActive) {
      lines.push("- Muse Watcher: ACTIVE");
      if (status.tunnel.watcherTransport) lines.push(`  Transport      : ${status.tunnel.watcherTransport}`);
      if (status.tunnel.watcherDetails) lines.push(`  Details        : ${status.tunnel.watcherDetails}`);
      lines.push(`  Muse connected : ${status.tunnel.museConnected ? "YES (active session)" : "NO (listening/idle)"}`);
      if (status.tunnel.uptimeSeconds !== undefined) lines.push(`  Uptime         : ${status.tunnel.uptimeSeconds}s`);
      if (status.tunnel.batchesExecuted !== undefined) lines.push(`  Batches run    : ${status.tunnel.batchesExecuted}`);
      if (status.tunnel.tasksCompleted !== undefined) lines.push(`  Tasks done     : ${status.tunnel.tasksCompleted}`);
      if (status.tunnel.activeTaskPresent) lines.push("  Active task    : present (task ID withheld in global service status)");
    } else {
      lines.push("- Muse Watcher: INACTIVE");
    }
  }

  if (includeMcp) {
    lines.push("");
    lines.push("[2] MCP (Model Context Protocol):");
    lines.push(`- Status: ${status.mcp.active ? "ACTIVE" : "INACTIVE"}`);
    lines.push(`- Exposed MCP tunnel servers: ${status.mcp.tunnelServerCount}`);
    if (status.mcp.tunnelServers.length > 0) {
      lines.push("- Endpoint protocol/auth probe: NOT PERFORMED (state metadata only)");
      status.mcp.tunnelServers.forEach((s, i) => {
        lines.push(`  - Server ${i + 1}: Port ${s.port} (PID: ${s.pid}, Uptime: ${s.uptimeSeconds}s)`);
        lines.push(`    Public URL : ${s.publicUrl}`);
        lines.push(`    Local URL  : ${s.localUrl}`);
        lines.push(`    Tool mode  : ${s.toolMode} | Auth mode: ${s.authMode || "static-bearer"}`);
        if (s.workspace) lines.push(`    Workspace  : ${s.workspace}`);
      });
    }
    lines.push(`- Connected client MCP servers: ${status.mcp.clientServerCount}`);
    if (status.mcp.clientServers.length > 0) {
      status.mcp.clientServers.forEach((cs) => {
        lines.push(`  - Client [${cs.name}]: Status: ${cs.status} (${cs.toolCount} tools)`);
        if (cs.error) lines.push(`    Error: ${cs.error}`);
        if (detailed && cs.tools.length > 0) {
          lines.push(`    Tools: ${cs.tools.join(", ")}`);
        }
      });
    }
  }

  if (includeTelegram) {
    lines.push("");
    lines.push("[3] Telegram:");
    lines.push(`- Status: ${status.telegram.active ? "ACTIVE" : "INACTIVE"}`);
    lines.push(`- Muse Telegram Watcher: ${status.telegram.museWatcherActive ? "ACTIVE" : "INACTIVE"}`);
    if (status.telegram.museWatcherActive) {
      if (status.telegram.museWatcherUptime !== undefined) lines.push(`  Uptime         : ${status.telegram.museWatcherUptime}s`);
      if (status.telegram.museWatcherBatches !== undefined) lines.push(`  Batches run    : ${status.telegram.museWatcherBatches}`);
      if (status.telegram.museWatcherTasks !== undefined) lines.push(`  Tasks done     : ${status.telegram.museWatcherTasks}`);
      if (status.telegram.museWatcherGroupId) lines.push(`  Group ID       : ${status.telegram.museWatcherGroupId}`);
      if (status.telegram.museWatcherBotId) lines.push(`  Muse Bot ID    : ${status.telegram.museWatcherBotId}`);
    }
    lines.push(`- Telegram Fallback Transport: ${status.telegram.telegramFallbackActive ? "ACTIVE" : "INACTIVE"}`);
    lines.push(`- Gateway Telegram: ${status.telegram.gatewayEnabled ? "ENABLED" : "DISABLED"} (Configured: ${status.telegram.gatewayConfigured ? "YES" : "NO"})`);
    if (status.telegram.gatewayEnabled || status.telegram.gatewayConfigured) {
      lines.push(`  Recv=${status.telegram.gatewayStats.messagesReceived} Sent=${status.telegram.gatewayStats.messagesSent} Errors=${status.telegram.gatewayStats.errors}`);
    }
  }

  return lines.join("\n");
}

/**
 * Compact dynamic prompt block injected when any remote service is active.
 */
export function formatDynamicRemoteNotice(status: RemoteServiceStatusResult): string | null {
  if (!status.anyActive) {
    return null;
  }

  const lines: string[] = ["# ACTIVE REMOTE SERVICES (TUNNELS / MCP / TELEGRAM)"];

  if (status.tunnel.active) {
    const tunnelDetails = status.tunnel.tunnels.map((t) => `Port ${t.port} -> ${t.publicUrl}`).join(", ") || "Active";
    const musePart = status.tunnel.watcherActive
      ? ` | Muse watcher: active (connected: ${status.tunnel.museConnected ? "yes" : "listening"})`
      : "";
    lines.push(`- Muse Tunnel: ACTIVE [${tunnelDetails}${musePart}]`);
  } else {
    lines.push("- Muse Tunnel: INACTIVE");
  }
  if (status.tunnel.otherTunnels?.length) {
    lines.push(`- Other service tunnels: ${status.tunnel.otherTunnels.map((t) => `${t.serviceKind} port ${t.port} -> ${t.publicUrl}`).join(", ")}`);
  }
  if (status.tunnel.unclassifiedTunnels?.length) {
    lines.push(`- Unclassified quick tunnels: ${status.tunnel.unclassifiedTunnels.length} (service kind not verified)`);
  }

  if (status.mcp.active) {
    const servers = status.mcp.tunnelServers.map((s) => `Port ${s.port} (${s.toolMode}) -> ${s.publicUrl}`).join(", ");
    const clients = status.mcp.clientServerCount > 0 ? ` | Client MCPs: ${status.mcp.clientServerCount} connected` : "";
    lines.push(`- MCP: ACTIVE [${servers || "Active"}${clients}]`);
  } else {
    lines.push("- MCP: INACTIVE");
  }

  if (status.telegram.active) {
    const parts: string[] = [];
    if (status.telegram.museWatcherActive) parts.push("Muse Watcher (Telegram)");
    if (status.telegram.telegramFallbackActive) parts.push("Telegram Fallback");
    if (status.telegram.gatewayEnabled && status.telegram.gatewayConfigured) parts.push("Gateway Telegram Bot");
    lines.push(`- Telegram: ACTIVE [${parts.join(", ") || "Active"}]`);
  } else {
    lines.push("- Telegram: INACTIVE");
  }

  lines.push("- Note: Use 'get_remote_service_status' tool to query full endpoints, PIDs, and diagnostic logs.");

  return lines.join("\n");
}
