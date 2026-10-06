/**
 * mcpTunnel.ts - MCP via Cloudflare quick tunnel.
 *
 * Starts the local MCP-over-HTTP server and a Cloudflare quick tunnel in
 * front of it, returning the public MCP endpoint + a fresh bearer token.
 *
 * SECURITY: the bearer is generated per invocation, printed ONCE to the
 * terminal, and never written to disk or logs. Treat the tunnel URL as
 * public - the bearer token is the only access control.
 */

import {
  startQuickTunnel,
  getTunnelStatus,
  type TunnelMetadata,
} from "../remoteAgent/cloudflareTunnel.js";
import {
  startMcpHttpServer,
  generateMcpBearerToken,
  getDefaultSafeTools,
  type McpHttpServerHandle,
} from "./mcpHttpTransport.js";

export const DEFAULT_MCP_PORT = 9227;
export const MCP_TUNNEL_TOOL_COUNT = 37;

interface ActiveMcp {
  handle: McpHttpServerHandle;
  bearerToken: string;
  auditLogPath: string;
}

const activeServers = new Map<number, ActiveMcp>();

export interface McpTunnelInfo {
  /** Public MCP endpoint, e.g. https://xxx.trycloudflare.com/mcp */
  publicUrl: string;
  /** Fresh bearer token (transient - printed once, never stored). */
  bearerToken: string;
  /** Local endpoint, e.g. http://127.0.0.1:9227/mcp */
  localUrl: string;
  /** Local audit log path. */
  auditLogPath: string;
  dangerous: boolean;
  toolCount: number;
}

export async function startMcpTunnel(opts: {
  port?: number;
  allowDangerous?: boolean;
  auditLogPath?: string;
}): Promise<McpTunnelInfo> {
  const port = opts.port ?? DEFAULT_MCP_PORT;
  const dangerous = !!opts.allowDangerous;

  // Reuse an already-running MCP server on this port (idempotent start).
  let active = activeServers.get(port);
  if (!active) {
    const bearerToken = generateMcpBearerToken();
    const handle = await startMcpHttpServer({
      port,
      bearerToken,
      allowDangerous: dangerous,
      auditLogPath: opts.auditLogPath,
    });
    active = { handle, bearerToken, auditLogPath: opts.auditLogPath ?? "default" };
    activeServers.set(port, active);
  }

  const existing = getTunnelStatus(port);
  let meta: TunnelMetadata | undefined;
  if (!existing.isRunning || !existing.publicUrl) {
    meta = await startQuickTunnel({ port, host: "127.0.0.1" });
  }
  const publicBase = (existing.isRunning && existing.publicUrl) || meta?.publicUrl;
  if (!publicBase) throw new Error("Cloudflare tunnel did not return a public URL");

  return {
    publicUrl: `${publicBase.replace(/\/$/, "")}/mcp`,
    bearerToken: active.bearerToken,
    localUrl: active.handle.url,
    auditLogPath: active.auditLogPath,
    dangerous,
    toolCount: dangerous ? MCP_TUNNEL_TOOL_COUNT : getDefaultSafeTools().length,
  };
}

export async function stopMcpTunnel(port = DEFAULT_MCP_PORT): Promise<void> {
  const active = activeServers.get(port);
  if (active) {
    activeServers.delete(port);
    await active.handle.close().catch(() => {});
  }
}

export async function stopAllMcpServers(): Promise<void> {
  for (const port of [...activeServers.keys()]) {
    await stopMcpTunnel(port);
  }
}

export function listActiveMcpServers(): number[] {
  return [...activeServers.keys()];
}
