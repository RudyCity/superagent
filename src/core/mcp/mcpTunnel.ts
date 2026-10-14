/**
 * mcpTunnel.ts - MCP via Cloudflare quick tunnel.
 *
 * Starts the local MCP-over-HTTP server and a Cloudflare quick tunnel in
 * front of it, returning the public MCP endpoint + a fresh Bearer token.
 *
 * SECURITY: the Bearer token is generated per invocation, printed ONCE to the
 * terminal, and never written to disk or logs. Treat the tunnel URL as
 * public - the Bearer token is the only access control.
 *
 * Cross-workspace listing: every started server persists a small state file
 * (~/.superagent-r/mcp-<port>.json, no secrets) so listActiveMcpServers()
 * can see servers owned by OTHER superagent instances. Stale files whose
 * owner PID is gone are removed on read.
 */

import fs from "fs";
import path from "path";
import os from "os";
import {
  startQuickTunnel,
  stopQuickTunnel,
  getTunnelStatus,
  isProcessRunning,
  type TunnelMetadata,
} from "../remoteAgent/cloudflareTunnel.js";
import {
  startMcpHttpServer,
  generateMcpBearerToken,
  getDefaultSafeTools,
  MCP_TOOL_CLASSIFICATION,
  type McpHttpServerHandle,
} from "./mcpHttpTransport.js";
import { DISABLED_MCP_TOOLS } from "./superagentMcpServer.js";
import { generateBootstrapCode } from "./mcpOAuthRoutes.js";
import type { McpAuthMode } from "./mcpAuth.js";
import { getYoloModeState } from "../permissions.js";

export const DEFAULT_MCP_PORT = 9227;

function getExposedMcpToolCount(allowDangerous: boolean): number {
  if (!allowDangerous) {
    return getDefaultSafeTools().length;
  }
  return Object.keys(MCP_TOOL_CLASSIFICATION).filter((name) => !DISABLED_MCP_TOOLS.has(name)).length;
}

interface ActiveMcp {
  handle: McpHttpServerHandle;
  bearerToken: string;
  auditLogPath: string;
  startedAt: number;
  authMode: McpAuthMode;
  /** True only when this invocation created the shared Quick Tunnel process. */
  ownsTunnel: boolean;
  bootstrapCode?: string;
}

const activeServers = new Map<number, ActiveMcp>();

export interface McpTunnelInfo {
  /** Public MCP endpoint, e.g. https://xxx.trycloudflare.com/mcp */
  publicUrl: string;
  /** Fresh Bearer token (transient - printed once, never stored). Empty in oauth mode. */
  bearerToken: string;
  /** Local endpoint, e.g. http://127.0.0.1:9227/mcp */
  localUrl: string;
  /** Local audit log path. */
  auditLogPath: string;
  dangerous: boolean;
  toolCount: number;
  authMode: McpAuthMode;
  /** One-time OAuth bootstrap approval code (transient - printed once, never stored). */
  bootstrapCode?: string;
  /** Public OAuth discovery base URL (oauth mode only). */
  oauthDiscoveryUrl?: string;
}

/** Disk-persisted MCP server state. NEVER contains the bearer token. */
export interface McpServerState {
  port: number;
  pid: number;
  publicUrl: string;
  localUrl: string;
  toolMode: "safe" | "dangerous";
  startedAt: number;
  workspace: string;
  /** Auth mode; defaults to "static-bearer" for states written before Task 8. */
  authMode?: McpAuthMode;
}

/** Full info for one active MCP server, including cross-workspace ones. */
export interface ActiveMcpInfo extends McpServerState {
  uptimeSeconds: number;
}

const MCP_STATE_FILE_RE = /^mcp-(\d+)\.json$/;

/** State dir shared with the WSS tunnel state (~/.superagent-r). */
export function getMcpStateDir(): string {
  const dir = path.join(os.homedir(), ".superagent-r");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getMcpStateFile(port: number): string {
  return path.join(getMcpStateDir(), `mcp-${port}.json`);
}

function writeMcpState(state: McpServerState): void {
  try {
    fs.writeFileSync(getMcpStateFile(state.port), JSON.stringify(state, null, 2), "utf-8");
  } catch {}
}

function deleteMcpState(port: number): void {
  try {
    const f = path.join(getMcpStateDir(), `mcp-${port}.json`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  } catch {}
}

export function readMcpStateFile(filePath: string): McpServerState | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const s = JSON.parse(raw) as Partial<McpServerState>;
    if (!s || typeof s.port !== "number" || typeof s.pid !== "number") return null;
    return {
      port: s.port,
      pid: s.pid,
      publicUrl: s.publicUrl || "",
      localUrl: s.localUrl || "",
      toolMode: s.toolMode === "dangerous" ? "dangerous" : "safe",
      startedAt: typeof s.startedAt === "number" ? s.startedAt : Date.now(),
      workspace: s.workspace || "",
      authMode: s.authMode === "oauth" ? "oauth" : "static-bearer",
    };
  } catch {
    return null;
  }
}

function toActiveMcpInfo(s: McpServerState): ActiveMcpInfo {
  const uptime = Math.floor((Date.now() - (s.startedAt || Date.now())) / 1000);
  return { ...s, uptimeSeconds: Math.max(0, uptime) };
}

export async function startMcpTunnel(opts: {
  port?: number;
  allowDangerous?: boolean;
  auditLogPath?: string;
  authMode?: McpAuthMode;
  /** Explicit allowed Origin values (defense in depth). */
  allowedOrigins?: string[];
  /** Allow requests without Origin (server-to-server). Default true. */
  allowNoOrigin?: boolean;
}): Promise<McpTunnelInfo> {
  const port = opts.port ?? DEFAULT_MCP_PORT;
  const yoloActive = getYoloModeState() !== "off";
  const dangerous = Boolean(opts.allowDangerous || yoloActive);
  const authMode: McpAuthMode = opts.authMode ?? "static-bearer";

  // The public tunnel URL is needed up-front: OAuth discovery metadata must
  // carry the canonical public URL from the first request.
  const existing = getTunnelStatus(port);
  if (
    existing.isRunning &&
    existing.serviceKind &&
    existing.serviceKind !== "unknown" &&
    existing.serviceKind !== "mcp-http"
  ) {
    throw new Error(
      `Port ${port} already has a ${existing.serviceKind} tunnel. Choose a different --mcp-port or stop that service first.`
    );
  }
  if (existing.isRunning) {
    const { isSameTunnelTarget } = await import("../remoteAgent/cloudflareTunnel.js");
    const expectedLocalTarget = `http://127.0.0.1:${port}`;
    if (!isSameTunnelTarget(existing.localUrl, expectedLocalTarget)) {
      throw new Error(
        `Tunnel on port ${port} forwards to ${existing.localUrl || "an unknown local target"}, not ${expectedLocalTarget}. Stop/reconcile it before starting MCP.`
      );
    }
  }
  let meta: TunnelMetadata | undefined;
  let createdTunnel = false;
  if (!existing.isRunning || !existing.publicUrl) {
    meta = await startQuickTunnel({ port, host: "127.0.0.1", path: "", serviceKind: "mcp-http" });
    createdTunnel = true;
  }
  const publicBase = (existing.isRunning && existing.publicUrl) || meta?.publicUrl;
  if (!publicBase) {
    if (createdTunnel) await stopQuickTunnel(port, "mcp-http").catch(() => {});
    throw new Error("Cloudflare tunnel did not return a public URL");
  }
  const publicBaseClean = publicBase.replace(/\/$/, "");

  // Reuse an already-running MCP server on this port (idempotent start),
  // but never silently reuse a server started in a different auth mode.
  let active = activeServers.get(port);
  let createdServer = false;
  try {
    if (active && active.authMode !== authMode) {
      throw new Error(
        `MCP server on port ${port} is already running in ${active.authMode} mode; ` +
          `stop it first before starting in ${authMode} mode.`
      );
    }
    if (!active) {
      const bearerToken = generateMcpBearerToken();
      let bootstrapCode: string | undefined;
      const oauth =
        authMode === "oauth"
          ? (() => {
              const bc = generateBootstrapCode();
              bootstrapCode = bc.code;
              return { publicBaseUrl: publicBaseClean, bootstrapCodeHash: bc.codeHash };
            })()
          : undefined;
      const handle = await startMcpHttpServer({
        port,
        bearerToken,
        allowDangerous: dangerous,
        auditLogPath: opts.auditLogPath,
        authMode,
        oauth,
        publicBaseUrl: publicBaseClean,
        hostOriginPolicy: {
          allowedOrigins: opts.allowedOrigins,
          allowNoOrigin: opts.allowNoOrigin,
        },
      });
      const prev = readMcpStateFile(getMcpStateFile(port));
      active = {
        handle,
        bearerToken,
        auditLogPath: opts.auditLogPath ?? "default",
        startedAt: prev?.startedAt ?? Date.now(),
        authMode,
        ownsTunnel: createdTunnel,
        bootstrapCode,
      };
      activeServers.set(port, active);
      createdServer = true;
    }
  } catch (error) {
    // Roll back only a tunnel created by this invocation; never stop a reused tunnel.
    if (createdTunnel) await stopQuickTunnel(port, "mcp-http").catch(() => {});
    throw error;
  }
  if (!active) {
    if (createdTunnel) await stopQuickTunnel(port, "mcp-http").catch(() => {});
    throw new Error(`MCP server startup failed on port ${port}.`);
  }
  const { claimTunnelServiceKind } = await import("../remoteAgent/cloudflareTunnel.js");
  if (!claimTunnelServiceKind(port, "mcp-http")) {
    if (createdServer && activeServers.get(port) === active) {
      activeServers.delete(port);
      await active.handle.close().catch(() => {});
    }
    if (createdTunnel) await stopQuickTunnel(port, "mcp-http").catch(() => {});
    throw new Error(`Tunnel on port ${port} could not be safely claimed by the MCP service.`);
  }

  const publicUrl = `${publicBaseClean}/mcp`;
  const localUrl = active.handle.url;

  // Persist (no secrets) so other instances can list this server.
  writeMcpState({
    port,
    pid: process.pid,
    publicUrl,
    localUrl,
    toolMode: dangerous ? "dangerous" : "safe",
    startedAt: active.startedAt,
    workspace: process.cwd(),
    authMode,
  });

  return {
    publicUrl,
    bearerToken: authMode === "oauth" ? "" : active.bearerToken,
    localUrl,
    auditLogPath: active.auditLogPath,
    dangerous,
    toolCount: getExposedMcpToolCount(dangerous),
    authMode,
    bootstrapCode: active.bootstrapCode,
    oauthDiscoveryUrl: authMode === "oauth" ? `${publicBaseClean}/.well-known/oauth-authorization-server` : undefined,
  };
}

export async function stopMcpTunnel(port = DEFAULT_MCP_PORT): Promise<void> {
  const active = activeServers.get(port);
  if (active) {
    activeServers.delete(port);
    await active.handle.close().catch(() => {});
    // This instance may stop only the tunnel it created, not a shared/reused one.
    if (active.ownsTunnel) {
      await stopQuickTunnel(port, "mcp-http").catch(() => {});
    }
  }

  // If this process does not own an active HTTP server handle, it cannot stop
  // a server in another process and must not kill that server's shared tunnel.
  // Only this instance's persisted state can be removed here.
  const state = readMcpStateFile(getMcpStateFile(port));
  if (state?.pid === process.pid) {
    deleteMcpState(port);
  } else if (!state) {
    deleteMcpState(port);
  }
}

export async function stopAllMcpServers(): Promise<void> {
  for (const port of [...activeServers.keys()]) {
    await stopMcpTunnel(port);
  }
}

/**
 * All active MCP servers: in-memory (this process) + disk scan
 * (~/.superagent-r/mcp-*.json) for servers owned by other instances.
 * Stale files whose owner PID is gone are deleted.
 */
export function listActiveMcpServers(): ActiveMcpInfo[] {
  const byPort = new Map<number, ActiveMcpInfo>();

  // 1. In-memory servers owned by this process.
  for (const [port, active] of activeServers.entries()) {
    const state = readMcpStateFile(getMcpStateFile(port));
    byPort.set(
      port,
      toActiveMcpInfo({
        port,
        pid: process.pid,
        publicUrl: state?.publicUrl ?? "",
        localUrl: active.handle.url,
        toolMode: state?.toolMode ?? "safe",
        startedAt: active.startedAt,
        workspace: state?.workspace ?? process.cwd(),
        authMode: active.authMode,
      }),
    );
  }

  // 2. Disk scan: servers owned by other superagent instances.
  try {
    const dir = getMcpStateDir();
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(MCP_STATE_FILE_RE);
      if (!m) continue;
      const filePath = path.join(dir, f);
      const state = readMcpStateFile(filePath);
      if (!state) continue;
      const effectivePort = state.port || parseInt(m[1], 10);
      if (!isProcessRunning(state.pid)) {
        // Stale: owner is gone.
        try {
          fs.unlinkSync(filePath);
        } catch {}
        continue;
      }
      if (!byPort.has(effectivePort)) {
        byPort.set(effectivePort, toActiveMcpInfo({ ...state, port: effectivePort }));
      }
    }
  } catch {}

  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

export function formatActiveMcpServers(servers: ActiveMcpInfo[]): string {
  if (!servers || servers.length === 0) {
    return [
      "Active MCP Servers: NONE ACTIVE",
      "No active MCP servers found.",
      "Run '/muse tunnel start --mcp' to expose an MCP server via Cloudflare tunnel.",
    ].join("\n");
  }

  const lines: string[] = [`Active MCP Servers (${servers.length}):`];
  servers.forEach((s, i) => {
    const authMode = s.authMode ?? "static-bearer";
    const toolMode = s.toolMode === "dangerous" ? "FULL" : "SAFE";
    lines.push(
      `${i + 1}. Port ${s.port} (PID: ${s.pid}, Uptime: ${s.uptimeSeconds}s)`,
      `   - Public URL : ${s.publicUrl}`,
      `   - Local URL  : ${s.localUrl}`,
      `   - Auth mode  : ${authMode} | Tool mode: ${toolMode}`,
    );
    if (s.workspace) {
      lines.push(`   - Workspace  : ${s.workspace}`);
    }
  });
  lines.push(
    "",
    "Commands:",
    "  Stop MCP server      : /muse tunnel stop --mcp-port <port>",
    "  Stop all incl. MCP   : /muse tunnel stop all",
  );
  return lines.join("\n");
}
