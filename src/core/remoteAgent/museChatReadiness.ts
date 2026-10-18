import { getMuseWatcher, isMuseWatcherActive } from "./museWatcherRegistry.js";
import { getRemoteServiceStatus } from "./remoteStatusService.js";

export interface MuseDirectChatReadiness {
  ready: boolean;
  transport: string | null;
  watcherActive: boolean;
  watcherConnected: boolean;
  replyCorrelationSupported: boolean;
  reason: string;
  details: string[];
}

/**
 * Returns a conservative readiness assessment for direct two-way Muse chat.
 * Readiness is true only when the Muse watcher is active, the transport is WebSocket,
 * and the transport is currently connected so reply_to correlation can work.
 */
export async function getMuseDirectChatReadiness(): Promise<MuseDirectChatReadiness> {
  const status = await getRemoteServiceStatus("tunnel");
  const watcherActive = isMuseWatcherActive();
  const watcher = getMuseWatcher();
  const transport = status.tunnel.watcherTransport ?? null;
  const watcherConnected = Boolean(status.tunnel.museConnected);
  const replyCorrelationSupported = watcherActive && transport === "websocket" && watcherConnected;
  const details: string[] = [];

  if (!watcherActive) details.push("Muse watcher is not running.");
  if (transport !== "websocket") details.push(`Active transport is ${transport || "unknown"}; direct chat requires websocket.`);
  if (!watcherConnected) details.push("Muse websocket is not currently connected.");

  if (watcher && watcherActive) {
    const stats = watcher.getStats();
    details.push(`Watcher uptime: ${stats.uptimeSeconds}s`);
    if (stats.activeTaskId) details.push(`Active task: ${stats.activeTaskId}`);
  }

  return {
    ready: replyCorrelationSupported,
    transport,
    watcherActive,
    watcherConnected,
    replyCorrelationSupported,
    reason: replyCorrelationSupported ? "ready_for_reply_correlated_chat" : details[0] || "not_ready",
    details,
  };
}
