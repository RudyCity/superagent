/**
 * mcpTunnel.ts - MCP via Cloudflare quick tunnel or OpenAI Secure MCP Tunnel.
 *
 * Supports two tunnel providers:
 * 1. "cloudflare" (default): Exposes local MCP HTTP server via Cloudflare quick tunnel (trycloudflare.com).
 * 2. "openai": Exposes local MCP HTTP server to ChatGPT, Codex, and OpenAI Responses API
 *    via OpenAI's official `tunnel-client` daemon (Secure MCP Tunnel).
 *
 * SECURITY: in static-bearer mode, the Bearer token is generated per invocation, printed ONCE to the
 * terminal, and never written to disk or logs. Treat public tunnel URLs as public -
 * the Bearer token or OAuth authorization is the only access control.
 * In OpenAI tunnel mode, connection is outbound-only to api.openai.com control plane.
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
  type McpHttpServerHandle,
} from "./mcpHttpTransport.js";
import { DISABLED_MCP_TOOLS, MCP_TOOL_DEFINITIONS } from "./superagentMcpServer.js";
import { generateBootstrapCode } from "./mcpOAuthRoutes.js";
import type { McpAuthMode } from "./mcpAuth.js";
import { getYoloModeState } from "../permissions.js";
import {
  startOpenAiTunnel,
  stopOpenAiTunnel,
  getOpenAiTunnelStatus,
  isValidTunnelId,
  type OpenAiTunnelStatus,
} from "./openaiTunnelClient.js";
import { getOpenAiMcpTunnelConfig } from "./openaiMcpTunnelConfig.js";
import { formatPythonMcpClientHints } from "./pythonMcpClientHints.js";

export const DEFAULT_MCP_PORT = 9227;
export type McpTunnelProvider = "cloudflare" | "openai";

function getExposedMcpToolCount(allowDangerous: boolean): number {
  if (!allowDangerous) return getDefaultSafeTools().length;
  return MCP_TOOL_DEFINITIONS.filter((tool) => !DISABLED_MCP_TOOLS.has(tool.name)).length;
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
  tunnelProvider: McpTunnelProvider;
  openAiTunnelId?: string;
  openAiStatus?: OpenAiTunnelStatus;
  oauthPublicBaseUrl?: string;
}

const activeServers = new Map<number, ActiveMcp>();

export interface McpTunnelInfo {
  /** Public MCP endpoint, e.g. https://xxx.trycloudflare.com/mcp or openai-tunnel://<tunnel_id> */
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
  /** Tunnel provider ("cloudflare" or "openai"). */
  tunnelProvider: McpTunnelProvider;
  /** OpenAI tunnel ID when tunnelProvider is "openai". */
  openAiTunnelId?: string;
  /** Local admin UI URL for tunnel-client (when tunnelProvider is "openai"). */
  adminUrl?: string;
  /** Whether tunnel-client has reported ready. */
  ready?: boolean;
}

/** Disk-persisted MCP server state. NEVER contains the bearer token or credentials. */
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
  tunnelProvider?: McpTunnelProvider;
  openAiTunnelId?: string;
  adminUrl?: string;
  /** Public OAuth issuer URL; never includes credentials. */
  oauthPublicBaseUrl?: string;
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
      tunnelProvider: s.tunnelProvider === "openai" ? "openai" : "cloudflare",
      openAiTunnelId: s.openAiTunnelId,
      adminUrl: s.adminUrl,
      oauthPublicBaseUrl: s.oauthPublicBaseUrl,
    };
  } catch {
    return null;
  }
}

function toActiveMcpInfo(s: McpServerState): ActiveMcpInfo {
  const uptime = Math.floor((Date.now() - (s.startedAt || Date.now())) / 1000);
  return { ...s, uptimeSeconds: Math.max(0, uptime) };
}

export interface StartMcpTunnelOptions {
  port?: number;
  allowDangerous?: boolean;
  auditLogPath?: string;
  authMode?: McpAuthMode;
  /** Explicit allowed Origin values (defense in depth). */
  allowedOrigins?: string[];
  /** Allow requests without Origin (server-to-server). Default true. */
  allowNoOrigin?: boolean;
  /** Tunnel provider: "cloudflare" (default) or "openai". */
  tunnelProvider?: McpTunnelProvider;
  /** Required when tunnelProvider is "openai". Format: "tunnel_..." */
  tunnelId?: string;
  /** Runtime API key with Tunnels Read + Use permission for OpenAI control plane. */
  openAiApiKey?: string;
  /** Profile name for tunnel-client (default: "superagent-mcp"). */
  openAiProfile?: string;
  /** Directory containing profile YAML files for tunnel-client. */
  openAiProfileDir?: string;
  /** Port for healthz/readyz and admin UI (default: port + 1000). */
  openAiHealthPort?: number;
  /** Custom path to the tunnel-client binary. */
  openAiBinaryPath?: string;
  /** Explicit public HTTPS OAuth issuer for OpenAI tunnel (also via OPENAI_MCP_OAUTH_PUBLIC_URL). */
  oauthPublicBaseUrl?: string;
  /** Whether to run in stateless embedded stub mode for testing. */
  embeddedStub?: boolean;
}

/** A tunnel ID is not an OAuth issuer. Never infer the issuer from a forwarded Host header. */
export function resolveOpenAiOAuthPublicBaseUrl(configured?: string): string {
  const value = configured?.trim() || process.env.OPENAI_MCP_OAUTH_PUBLIC_URL?.trim();
  if (!value) {
    throw new Error("OpenAI OAuth tunnel requires an HTTPS public issuer. Supply --oauth-public-url https://your-public-host or OPENAI_MCP_OAUTH_PUBLIC_URL; do not use localhost.");
  }
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error("Invalid OpenAI OAuth public URL; use an absolute HTTPS origin."); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || !host ||
      host === "localhost" || host.endsWith(".localhost") ||
      host === "127.0.0.1" || host === "::1" || host === "[::1]" ||
      host.endsWith(".local") || host.endsWith(".internal") ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      parsed.pathname !== "/") {
    throw new Error("OpenAI OAuth public URL must be a public HTTPS origin without credentials, path, query or fragment.");
  }
  return parsed.origin;
}

export async function startMcpTunnel(opts: StartMcpTunnelOptions = {}): Promise<McpTunnelInfo> {
  const port = opts.port ?? DEFAULT_MCP_PORT;
  const yoloActive = getYoloModeState() !== "off";
  const dangerous = Boolean(opts.allowDangerous || yoloActive);
  const authMode: McpAuthMode = opts.authMode ?? "static-bearer";
  const requestedProvider = opts.tunnelProvider as string | undefined;
  if (requestedProvider !== undefined && requestedProvider !== "cloudflare" && requestedProvider !== "openai") {
    throw new Error(
      `Unsupported MCP tunnel provider "${requestedProvider}". Supported providers: cloudflare, openai.`
    );
  }

  // Honor an explicitly selected provider. Otherwise, infer OpenAI from its
  // configured tunnel ID; without that signal, retain the Cloudflare default.
  const savedOpenAiConfig = requestedProvider === "cloudflare" ? {} : getOpenAiMcpTunnelConfig();
  const configuredOpenAiTunnelId = process.env.OPENAI_MCP_TUNNEL_ID?.trim() || savedOpenAiConfig.tunnelId;
  const hasExplicitTunnelId = Boolean(opts.tunnelId?.trim());
  const tunnelProvider: McpTunnelProvider = requestedProvider === "openai"
    ? "openai"
    : requestedProvider === "cloudflare"
      ? "cloudflare"
      : hasExplicitTunnelId || configuredOpenAiTunnelId
        ? "openai"
        : "cloudflare";

  // -------------------------------------------------------------
  // OPENAI SECURE MCP TUNNEL PATH
  // -------------------------------------------------------------
  if (tunnelProvider === "openai") {
    // Dedicated SuperAgent env takes precedence; retain the tunnel-client
    // env variable as a backwards-compatible fallback.
    const rawTunnelId = opts.tunnelId?.trim()
      || process.env.OPENAI_MCP_TUNNEL_ID?.trim()
      || savedOpenAiConfig.tunnelId
      || process.env.CONTROL_PLANE_TUNNEL_ID?.trim();
    if (!rawTunnelId) {
      throw new Error(
        "OpenAI Secure MCP Tunnel requires a tunnel ID.\n" +
        "Create one in OpenAI Platform tunnel settings (https://platform.openai.com/settings/organization/tunnels)\n" +
        "then pass --tunnel-id <id> or set OPENAI_MCP_TUNNEL_ID (e.g. tunnel_0123456789abcdef0123456789abcdef)."
      );
    }
    const tunnelId = rawTunnelId.trim();
    if (!isValidTunnelId(tunnelId)) {
      throw new Error(
        `Invalid OpenAI Secure MCP Tunnel ID "${tunnelId}". ` +
        "Check OPENAI_MCP_TUNNEL_ID or pass --tunnel-id <id>; valid IDs contain at least 8 letters, numbers, _, -, . or : characters."
      );
    }

    // Fail before starting a server or external connection if issuer is unusable.
    const oauthPublicBaseUrl = authMode === "oauth"
      ? resolveOpenAiOAuthPublicBaseUrl(opts.oauthPublicBaseUrl)
      : undefined;
    let active = activeServers.get(port);
    let createdServer = false;

    if (active && active.oauthPublicBaseUrl !== oauthPublicBaseUrl) {
      throw new Error("OpenAI OAuth public issuer differs from the active MCP server; stop it before reconfiguration.");
    }
    if (active && active.tunnelProvider !== "openai") {
      throw new Error(
        `MCP server on port ${port} is already running with the ${active.tunnelProvider} tunnel provider; ` +
        "stop it before switching to OpenAI Secure MCP Tunnel."
      );
    }

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
              return { publicBaseUrl: oauthPublicBaseUrl!, bootstrapCodeHash: bc.codeHash };
            })()
          : undefined;

      const handle = await startMcpHttpServer({
        port,
        bearerToken,
        allowDangerous: dangerous,
        auditLogPath: opts.auditLogPath,
        authMode,
        oauth,
        publicBaseUrl: oauthPublicBaseUrl || `http://127.0.0.1:${port}`,
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
        ownsTunnel: false,
        bootstrapCode,
        tunnelProvider: "openai",
        openAiTunnelId: tunnelId,
        oauthPublicBaseUrl,
      };
      activeServers.set(port, active);
      createdServer = true;
    }

    let openAiStatus: OpenAiTunnelStatus;
    try {
      openAiStatus = await startOpenAiTunnel({
        tunnelId,
        mcpPort: port,
        apiKey: opts.openAiApiKey,
        profile: opts.openAiProfile,
        profileDir: opts.openAiProfileDir,
        binaryPath: opts.openAiBinaryPath,
        healthListenAddr: opts.openAiHealthPort ? `127.0.0.1:${opts.openAiHealthPort}` : undefined,
        embeddedStub: opts.embeddedStub,
        bearerToken: authMode === "oauth" ? undefined : active.bearerToken,
      });
      active.openAiStatus = openAiStatus;
    } catch (tunnelErr) {
      if (createdServer && activeServers.get(port) === active) {
        activeServers.delete(port);
        await active.handle.close().catch(() => {});
      }
      throw tunnelErr;
    }

    const publicUrl = `openai-tunnel://${tunnelId}`;
    writeMcpState({
      port,
      pid: process.pid,
      publicUrl,
      localUrl: active.handle.url,
      toolMode: dangerous ? "dangerous" : "safe",
      startedAt: active.startedAt,
      workspace: process.cwd(),
      authMode,
      tunnelProvider: "openai",
      openAiTunnelId: tunnelId,
      oauthPublicBaseUrl,
      adminUrl: openAiStatus.adminUrl,
    });

    return {
      publicUrl,
      bearerToken: authMode === "oauth" ? "" : active.bearerToken,
      localUrl: active.handle.url,
      auditLogPath: active.auditLogPath,
      dangerous,
      toolCount: getExposedMcpToolCount(dangerous),
      authMode,
      bootstrapCode: active.bootstrapCode,
      oauthDiscoveryUrl: authMode === "oauth" ? `${oauthPublicBaseUrl}/.well-known/oauth-authorization-server` : undefined,
      tunnelProvider: "openai",
      openAiTunnelId: tunnelId,
      adminUrl: openAiStatus.adminUrl,
      ready: openAiStatus.ready,
    };
  }

  // -------------------------------------------------------------
  // CLOUDFLARE QUICK TUNNEL PATH (Default)
  // -------------------------------------------------------------
  const activeServerForPort = activeServers.get(port);
  if (activeServerForPort && activeServerForPort.tunnelProvider !== "cloudflare") {
    throw new Error(
      `MCP server on port ${port} is already running with the ${activeServerForPort.tunnelProvider} tunnel provider; ` +
      "stop it before switching to Cloudflare Quick Tunnel."
    );
  }
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
        tunnelProvider: "cloudflare",
      };
      activeServers.set(port, active);
      createdServer = true;
    }
  } catch (error) {
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

  writeMcpState({
    port,
    pid: process.pid,
    publicUrl,
    localUrl,
    toolMode: dangerous ? "dangerous" : "safe",
    startedAt: active.startedAt,
    workspace: process.cwd(),
    authMode,
    tunnelProvider: "cloudflare",
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
    tunnelProvider: "cloudflare",
  };
}

export async function stopMcpTunnel(port = DEFAULT_MCP_PORT): Promise<void> {
  const active = activeServers.get(port);
  const state = readMcpStateFile(getMcpStateFile(port));
  const provider = active?.tunnelProvider || state?.tunnelProvider || "cloudflare";

  if (active) {
    activeServers.delete(port);
    await active.handle.close().catch(() => {});
    if (provider === "openai") {
      await stopOpenAiTunnel(port).catch(() => {});
    } else if (active.ownsTunnel) {
      await stopQuickTunnel(port, "mcp-http").catch(() => {});
    }
  } else if (provider === "openai") {
    await stopOpenAiTunnel(port).catch(() => {});
  }

  if (state?.pid === process.pid || !state) {
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
        tunnelProvider: active.tunnelProvider,
        openAiTunnelId: active.openAiTunnelId,
        oauthPublicBaseUrl: active.oauthPublicBaseUrl,
        adminUrl: state?.adminUrl,
      }),
    );
  }

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
        try { fs.unlinkSync(filePath); } catch {}
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
      "Run '/mcp tunnel start --provider cloudflare' for Cloudflare, or '/mcp tunnel start --provider openai --tunnel-id <id>' for OpenAI Secure MCP Tunnel.",
    ].join("\n");
  }

  const lines: string[] = [`Active MCP Servers (${servers.length}):`];
  servers.forEach((s, i) => {
    const authMode = s.authMode ?? "static-bearer";
    const toolMode = s.toolMode === "dangerous" ? "FULL" : "SAFE";
    const providerName = s.tunnelProvider === "openai" ? "OpenAI Secure MCP Tunnel" : "Cloudflare Quick Tunnel";
    lines.push(
      `${i + 1}. Port ${s.port} (PID: ${s.pid}, Uptime: ${s.uptimeSeconds}s)`,
      `   - Provider   : ${providerName}`,
      `   - Public URL : ${s.publicUrl}`,
      `   - Local URL  : ${s.localUrl}`,
      `   - Auth mode  : ${authMode} | Tool mode: ${toolMode}`,
    );
    if (s.openAiTunnelId) {
      lines.push(`   - Tunnel ID  : ${s.openAiTunnelId}`);
    }
    if (s.adminUrl) {
      lines.push(`   - Admin UI   : ${s.adminUrl}`);
    }
    if (s.workspace) {
      lines.push(`   - Workspace  : ${s.workspace}`);
    }
    lines.push(...formatPythonMcpClientHints({
      publicUrl: s.publicUrl,
      localUrl: s.localUrl,
      authMode,
    }));
  });
  lines.push(
    "",
    "Commands:",
    "  Stop MCP server (owner only): /mcp tunnel stop --port <port>",
    "  Refresh listing             : /mcp tunnel status",
  );
  return lines.join("\n");
}
