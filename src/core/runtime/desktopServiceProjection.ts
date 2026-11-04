import type { RemoteServiceStatusResult } from "../remoteAgent/remoteStatusService.js";

/**
 * Authenticated, read-only desktop projection. Never expose tunnel URLs,
 * workspace task IDs, bot/group identifiers, bearer credentials or MCP tools.
 * All states are scoped to the Core process servicing this request.
 */
export function projectDesktopServices(status: RemoteServiceStatusResult) {
  return {
    success: true,
    scope: "this-core-process" as const,
    timestamp: status.timestamp,
    muse: {
      watcherActive: status.tunnel.watcherActive === true || status.telegram.museWatcherActive === true,
      transport: status.tunnel.watcherTransport || status.telegram.museWatcherTransport || null,
      connected: status.tunnel.museConnected === true,
      telegramFallbackActive: status.telegram.telegramFallbackActive === true,
    },
    telegram: {
      active: status.telegram.active === true,
      gatewayEnabled: status.telegram.gatewayEnabled === true,
      gatewayConfigured: status.telegram.gatewayConfigured === true,
    },
    mcp: {
      active: status.mcp.active === true,
      serverCount: status.mcp.tunnelServerCount,
      connectedClientCount: status.mcp.clientServers.filter(s => s.status === "connected").length,
    },
    tunnel: {
      active: status.tunnel.active === true,
      count: status.tunnel.count,
    },
    channelHosts: {
      verifiedCount: (status.channelHosts || []).filter(host => host.status === "running").length,
    },
  };
}
