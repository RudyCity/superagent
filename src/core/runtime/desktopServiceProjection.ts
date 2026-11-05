import type { RemoteServiceStatusResult } from "../remoteAgent/remoteStatusService.js";
import { getMuseRuntimeConfigRevision } from "../remoteAgent/config.js";

/**
 * Authenticated, read-only desktop projection. Never expose tunnel URLs,
 * workspace task IDs, bot/group identifiers, bearer credentials or MCP tools.
 * All states are scoped to the Core process servicing this request.
 */
export function projectDesktopServices(status: RemoteServiceStatusResult) {
  const watcherActive=status.tunnel.watcherActive === true || status.telegram.museWatcherActive === true;
  const currentConfigRevision=getMuseRuntimeConfigRevision();
  const watcherConfigRevision=status.tunnel.watcherConfigRevision;
  return {
    success: true,
    scope: "this-core-process" as const,
    timestamp: status.timestamp,
    muse: {
      ownerPresent: watcherActive,
      watcherActive,
      transport: status.tunnel.watcherTransport || status.telegram.museWatcherTransport || null,
      connected: status.tunnel.museConnected === true,
      telegramFallbackActive: status.telegram.telegramFallbackActive === true,
      uptimeSeconds: status.tunnel.uptimeSeconds ?? null,
      tasksCompleted: status.tunnel.tasksCompleted ?? null,
      batchesExecuted: status.tunnel.batchesExecuted ?? null,
      queuedBatches: status.tunnel.queuedBatches ?? 0,
      workspaceCount: status.tunnel.workspaceCount ?? 0,
      activeTask: status.tunnel.activeTaskPresent === true,
      lastActiveAt: status.tunnel.lastActiveAt ?? null,
      lastTransportError: status.tunnel.lastTransportError ?? null,
      configStale: Boolean(watcherActive && watcherConfigRevision &&
        watcherConfigRevision !== currentConfigRevision),
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
      // remoteStatusService.tunnel.active may mean only a local WSS
      // watcher; it is NOT evidence of a running Cloudflare tunnel.
      active: status.tunnel.tunnelProcessActive === true || status.tunnel.count > 0,
      count: status.tunnel.count,
    },
    channelHosts: {
      verifiedCount: (status.channelHosts || []).filter(host => host.status === "running").length,
    },
  };
}
