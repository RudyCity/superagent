import type { TunnelMetadata } from "../remoteAgent/cloudflareTunnel.js";

export interface EnsuredCoreHttpTunnel {
  pid: number;
  endpoint: string;
  reused: boolean;
}

const inFlight = new Map<number, Promise<EnsuredCoreHttpTunnel>>();

async function waitForPublicTunnelReady(endpoint: string, timeoutMs = 12_000): Promise<void> {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error("Core HTTPS tunnel endpoint is invalid.");
  const target = url.origin + "/api/device-tunnel/ping";
  const deadline = Date.now() + Math.max(2_000, Math.min(20_000, timeoutMs));
  let lastError = "not ready";
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      const response = await fetch(target, {
        method: "HEAD", redirect: "error", signal: controller.signal,
        headers: { "User-Agent": "SuperAgent-DeviceTunnel-Readiness/1.0", "Cache-Control": "no-cache" },
      });
      if (response.status === 204) return;
      lastError = "HTTP " + response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "network error";
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  throw new Error("Core HTTPS tunnel public endpoint is not ready: " + lastError.slice(0, 120));
}

async function ensureOnce(port: number): Promise<EnsuredCoreHttpTunnel> {
  const {
    getTunnelStatus,
    startQuickTunnel,
    claimTunnelServiceKind,
    stopQuickTunnel,
  } = await import("../remoteAgent/cloudflareTunnel.js");

  const existing = getTunnelStatus(port);
  if (existing.isRunning) {
    if (existing.serviceKind !== "superagent-http" || !existing.publicUrl || !existing.pid) {
      throw new Error("Existing tunnel on the Core port is not an owner-verified Core HTTPS tunnel.");
    }
    await waitForPublicTunnelReady(existing.publicUrl);
    return { pid: existing.pid, endpoint: existing.publicUrl, reused: true };
  }

  const created: TunnelMetadata = await startQuickTunnel({
    port,
    host: "127.0.0.1",
    path: "",
    serviceKind: "superagent-http",
  });
  const claimed = claimTunnelServiceKind(port, "superagent-http");
  if (!claimed || claimed.pid !== created.pid || !claimed.publicUrl) {
    await stopQuickTunnel(port, "superagent-http").catch(() => {});
    throw new Error("New Core HTTPS tunnel failed ownership verification.");
  }
  try {
    await waitForPublicTunnelReady(claimed.publicUrl);
  } catch (error) {
    await stopQuickTunnel(port, "superagent-http").catch(() => {});
    throw error;
  }
  return { pid: claimed.pid, endpoint: claimed.publicUrl, reused: false };
}

/**
 * Idempotently ensures the owner-verified Core HTTPS quick tunnel exists.
 * This is intended for explicit user actions (for example "Create QR") so a
 * Core restart does not leave those actions in a permanent HTTP 409 state.
 * Calls are serialized per port to avoid duplicate quick-tunnel spawns.
 */
export async function ensureOwnedCoreHttpTunnel(port = 7888): Promise<EnsuredCoreHttpTunnel> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("Invalid Core HTTPS tunnel port.");
  }
  const current = inFlight.get(port);
  if (current) return await current;

  const pending = ensureOnce(port);
  inFlight.set(port, pending);
  try {
    return await pending;
  } finally {
    if (inFlight.get(port) === pending) inFlight.delete(port);
  }
}
