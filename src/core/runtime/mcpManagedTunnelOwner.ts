import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import {
  DEFAULT_MCP_PORT,
  getMcpStateFile,
  listActiveMcpServers,
  readMcpStateFile,
  startMcpTunnel,
  stopMcpTunnel,
  type McpTunnelInfo,
  type StartMcpTunnelOptions,
} from "../mcp/mcpTunnel.js";
import { formatPythonMcpClientHints } from "../mcp/pythonMcpClientHints.js";
import { describeMcpOAuthStore } from "../mcp/mcpOAuthPersistentStore.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";
import { verifyWindowsProcessBirth } from "./mcpProcessBirth.js";

const OWNER_KIND = "managed_mcp_tunnel_owner" as const;
const OWNER_MODE = "managed-tunnel" as const;
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

export interface ManagedMcpTunnelLease {
  version: 1;
  kind: typeof OWNER_KIND;
  pid: number;
  port: number;
  nonce: string;
  createdAt: number;
  workspace: string;
}

export interface ManagedMcpTunnelOwnerStatus {
  version: 1;
  kind: "private_mcp_owner";
  pid: number;
  port: number;
  startedAt: number;
  mode: typeof OWNER_MODE;
  activeSessions: number;
  inFlightRequests: number;
  draining: boolean;
  inflightToolEffects: "unknown";
  safeToolsOnly: boolean;
  oauthEnabled: boolean;
  publicTunnelStarted: true;
}

export interface ManagedMcpTunnelStartResult {
  pid: number;
  info: McpTunnelInfo;
}

function ownerLeasePath(port: number): string {
  return path.join(os.homedir(), ".superagent-r", `mcp-owner-${port}.json`);
}

function assertPort(port: number): number {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 7888) {
    throw new Error("Invalid or protected MCP tunnel owner port");
  }
  return port;
}

function parsePort(args: string[]): number {
  const index = args.findIndex((arg) => arg === "--port" || arg === "--mcp-port" || arg === "-p");
  if (index < 0) return DEFAULT_MCP_PORT;
  return assertPort(Number(args[index + 1]));
}

function option(args: string[], ...names: string[]): string | undefined {
  const index = args.findIndex((arg) => names.includes(arg));
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value.trim() : undefined;
}

function parseStartOptions(args: string[]): StartMcpTunnelOptions {
  const port = parsePort(args);
  const providerValue = option(args, "--provider")?.toLowerCase();
  const tunnelId = option(args, "--tunnel-id");
  const wantOpenAi = args.includes("--openai") || args.includes("--openai-tunnel") || Boolean(tunnelId);
  let tunnelProvider: "cloudflare" | "openai" | undefined = wantOpenAi ? "openai" : undefined;
  if (providerValue) {
    if (providerValue !== "cloudflare" && providerValue !== "openai") {
      throw new Error(`Unsupported MCP tunnel provider "${providerValue}"`);
    }
    tunnelProvider = providerValue;
  }
  const authRaw = option(args, "--mcp-auth", "--auth")?.toLowerCase();
  let authMode: "static-bearer" | "oauth" | undefined;
  if (authRaw) {
    if (authRaw !== "static-bearer" && authRaw !== "oauth") {
      throw new Error(`Invalid --mcp-auth value "${authRaw}"`);
    }
    authMode = authRaw;
  }
  return {
    port,
    allowDangerous: args.includes("--allow-dangerous"),
    authMode,
    tunnelProvider,
    tunnelId,
    openAiApiKey: option(args, "--api-key", "--control-plane-key"),
    openAiProfile: option(args, "--profile"),
    oauthPublicBaseUrl: option(args, "--oauth-public-url"),
  };
}

function assertSafeLeaseFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) {
    throw new Error("Unsafe MCP tunnel owner lease");
  }
}

export function readManagedMcpTunnelLease(port: number): ManagedMcpTunnelLease | null {
  const file = ownerLeasePath(assertPort(port));
  try {
    assertSafeLeaseFile(file);
    const lease = JSON.parse(fs.readFileSync(file, "utf8")) as ManagedMcpTunnelLease;
    if (
      lease.version !== 1 || lease.kind !== OWNER_KIND ||
      !Number.isSafeInteger(lease.pid) || lease.pid < 1 ||
      lease.port !== port || !/^[a-f0-9]{64}$/.test(lease.nonce) ||
      !Number.isSafeInteger(lease.createdAt) || lease.createdAt <= 0 ||
      typeof lease.workspace !== "string" || lease.workspace.length < 1 || lease.workspace.length > 4096
    ) {
      throw new Error("Invalid MCP tunnel owner lease");
    }
    return lease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeManagedMcpTunnelLease(lease: ManagedMcpTunnelLease): void {
  const dir = path.dirname(ownerLeasePath(lease.port));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(ownerLeasePath(lease.port), JSON.stringify(lease) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

function cleanManagedMcpTunnelLease(lease: ManagedMcpTunnelLease): void {
  try {
    const current = readManagedMcpTunnelLease(lease.port);
    if (current?.pid === lease.pid && current.nonce === lease.nonce && current.createdAt === lease.createdAt) {
      fs.rmSync(ownerLeasePath(lease.port), { force: true });
    }
  } catch {
    // Preserve malformed/untrusted state for operator review.
  }
}

function requestOwner(
  lease: ManagedMcpTunnelLease,
  operation: "status" | "drain" | "stop" | "stop?force=1",
): Promise<{ statusCode: number; body: Record<string, unknown> | null }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (statusCode: number, body: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode, body });
    };
    const req = http.request({
      hostname: "127.0.0.1",
      port: lease.port,
      path: `/_internal/owner/${operation}`,
      method: operation === "status" ? "GET" : "POST",
      timeout: 1800,
      headers: {
        Authorization: "Bearer " + lease.nonce,
        Accept: "application/json",
        Host: `127.0.0.1:${lease.port}`,
      },
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        text += chunk;
        if (text.length > 4096) req.destroy();
      });
      res.once("end", () => {
        let body: Record<string, unknown> | null = null;
        try { body = text ? JSON.parse(text) as Record<string, unknown> : null; } catch {}
        finish(res.statusCode || 0, body);
      });
    });
    req.once("timeout", () => req.destroy());
    req.once("error", () => finish(0, null));
    req.end();
  });
}

function parseOwnerStatus(
  lease: ManagedMcpTunnelLease,
  result: { statusCode: number; body: Record<string, unknown> | null },
): ManagedMcpTunnelOwnerStatus | null {
  const body = result.body;
  if (result.statusCode !== 200 || !body) return null;
  if (
    body.version !== 1 || body.kind !== "private_mcp_owner" ||
    body.pid !== lease.pid || body.port !== lease.port || body.startedAt !== lease.createdAt ||
    body.mode !== OWNER_MODE || body.publicTunnelStarted !== true ||
    typeof body.draining !== "boolean" ||
    !Number.isSafeInteger(body.activeSessions) || Number(body.activeSessions) < 0 ||
    !Number.isSafeInteger(body.inFlightRequests) || Number(body.inFlightRequests) < 0 ||
    body.inflightToolEffects !== "unknown" ||
    typeof body.safeToolsOnly !== "boolean" || typeof body.oauthEnabled !== "boolean"
  ) return null;
  return body as unknown as ManagedMcpTunnelOwnerStatus;
}

export async function probeManagedMcpTunnelOwner(
  lease: ManagedMcpTunnelLease,
  operation: "status" | "drain" = "status",
): Promise<ManagedMcpTunnelOwnerStatus | null> {
  return parseOwnerStatus(lease, await requestOwner(lease, operation));
}

function verifyManagedOwnerIdentity(lease: ManagedMcpTunnelLease): void {
  const state = readMcpStateFile(getMcpStateFile(lease.port));
  const listenerPid = readListenerOwners()?.get(lease.port);
  if (!state || state.pid !== lease.pid || listenerPid !== lease.pid) {
    throw new Error("MCP tunnel owner identity does not match state and kernel listener");
  }
  if (process.platform === "win32" && verifyWindowsProcessBirth(lease.pid, lease.createdAt) !== "matched") {
    throw new Error("MCP tunnel owner process birth could not be verified");
  }
}

export async function startManagedMcpTunnelOwner(
  args: string[],
  cliEntry = process.argv[1] || "",
): Promise<ManagedMcpTunnelStartResult> {
  const port = parsePort(args);
  if (listActiveMcpServers().some((server) => server.port === port) || readListenerOwners()?.has(port)) {
    throw new Error(`MCP port ${port} is already active; refusing duplicate owner`);
  }
  if (readManagedMcpTunnelLease(port)) {
    throw new Error(`MCP port ${port} has an existing managed-owner lease; inspect it before retrying`);
  }
  const entry = path.resolve(cliEntry);
  const stat = fs.lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Managed MCP tunnel requires a real SuperAgent CLI entry file");
  }
  const useWindowsTrampoline = process.platform === "win32";
  const child = fork(entry, ["mcp", useWindowsTrampoline ? "tunnel-launcher" : "tunnel-owner", ...args], {
    execPath: process.execPath,
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    ...({ windowsHide: true } as any),
    env: {
      ...process.env,
      ...(useWindowsTrampoline
        ? { SUPERAGENT_MCP_TUNNEL_LAUNCHER_CHILD: "1" }
        : { SUPERAGENT_MCP_TUNNEL_OWNER_CHILD: "1" }),
    },
  });
  if (!child.pid) throw new Error("Managed MCP tunnel owner launcher returned no PID");

  return await new Promise<ManagedMcpTunnelStartResult>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error, result?: ManagedMcpTunnelStartResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners("message");
      child.removeAllListeners("error");
      child.removeAllListeners("exit");
      try { child.disconnect(); } catch {}
      child.unref();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => {
      done(new Error(`MCP owner launcher PID ${child.pid} did not report ready state within startup timeout; inspect status before retrying`));
    }, START_TIMEOUT_MS);
    child.once("error", (error) => done(error));
    child.once("exit", (code) => {
      if (!settled) done(new Error(`MCP owner launcher exited before ready (code ${code ?? "unknown"})`));
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const m = message as { type?: string; pid?: number; info?: McpTunnelInfo; error?: string };
      if (m.type === "mcp-tunnel-owner-error") {
        done(new Error(m.error || "Managed MCP tunnel owner failed"));
        return;
      }
      if (m.type !== "mcp-tunnel-owner-ready" || !Number.isSafeInteger(m.pid) || !m.pid || !m.info) return;
      if (!useWindowsTrampoline && m.pid !== child.pid) {
        done(new Error("MCP owner ready PID did not match spawned process"));
        return;
      }
      const ownerPid = m.pid;
      const lease = readManagedMcpTunnelLease(port);
      if (!lease || lease.pid !== ownerPid) {
        done(new Error("MCP owner reported ready without a matching private lease"));
        return;
      }
      try {
        verifyManagedOwnerIdentity(lease);
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      done(undefined, { pid: ownerPid, info: m.info });
    });
  });
}

/**
 * Windows-only short-lived trampoline. The Core may invoke /mcp tunnel start,
 * but the long-lived owner must not remain in Core's live process tree:
 *
 * Core -> launcher (temporary) -> MCP owner (long-lived)
 *
 * The launcher waits for the owner's authenticated ready lease, forwards the
 * one-time startup payload over IPC, disconnects from the owner and exits.
 * Windows then sees the owner with a dead launcher parent rather than Core as
 * its direct parent, so later Core tree cleanup cannot sweep the MCP owner.
 */
export async function runManagedMcpTunnelLauncher(args: string[]): Promise<never> {
  if (process.platform !== "win32" ||
      process.env.SUPERAGENT_MCP_TUNNEL_LAUNCHER_CHILD !== "1" ||
      typeof process.send !== "function") {
    throw new Error("mcp tunnel-launcher is an internal Windows child-process command");
  }
  const entry = path.resolve(process.argv[1] || "");
  const stat = fs.lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("MCP tunnel launcher requires a real SuperAgent CLI entry file");
  }
  const owner = fork(entry, ["mcp", "tunnel-owner", ...args], {
    execPath: process.execPath,
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    ...({ windowsHide: true } as any),
    env: {
      ...process.env,
      SUPERAGENT_MCP_TUNNEL_LAUNCHER_CHILD: "0",
      SUPERAGENT_MCP_TUNNEL_OWNER_CHILD: "1",
    },
  });
  if (!owner.pid) throw new Error("MCP tunnel launcher could not create owner PID");

  let settled = false;
  const finish = (message: unknown, exitCode: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    owner.removeAllListeners("message");
    owner.removeAllListeners("error");
    owner.removeAllListeners("exit");
    try { owner.disconnect(); } catch {}
    owner.unref();
    const exit = () => process.exit(exitCode);
    if (typeof process.send === "function" && process.connected) {
      process.send(message, () => exit());
      const fallback = setTimeout(exit, 500);
      fallback.unref();
    } else {
      exit();
    }
  };
  const timer = setTimeout(() => {
    finish({
      type: "mcp-tunnel-owner-error",
      pid: owner.pid,
      error: "MCP owner did not report ready before launcher timeout",
    }, 1);
  }, START_TIMEOUT_MS);
  owner.once("error", (error) => finish({
    type: "mcp-tunnel-owner-error",
    pid: owner.pid,
    error: error.message,
  }, 1));
  owner.once("exit", (code) => {
    if (!settled) finish({
      type: "mcp-tunnel-owner-error",
      pid: owner.pid,
      error: `MCP owner exited before ready (code ${code ?? "unknown"})`,
    }, 1);
  });
  owner.on("message", (message: unknown) => {
    if (!message || typeof message !== "object") return;
    const m = message as { type?: string; pid?: number };
    if (m.type !== "mcp-tunnel-owner-ready" && m.type !== "mcp-tunnel-owner-error") return;
    if (m.pid !== owner.pid) {
      finish({
        type: "mcp-tunnel-owner-error",
        pid: owner.pid,
        error: "MCP owner launcher received mismatched child PID",
      }, 1);
      return;
    }
    finish(message, m.type === "mcp-tunnel-owner-ready" ? 0 : 1);
  });
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}

export async function runManagedMcpTunnelOwner(args: string[]): Promise<never> {
  if (process.env.SUPERAGENT_MCP_TUNNEL_OWNER_CHILD !== "1" || typeof process.send !== "function") {
    throw new Error("mcp tunnel-owner is an internal child-process command");
  }
  const options = parseStartOptions(args);
  const port = assertPort(options.port ?? DEFAULT_MCP_PORT);
  const nonce = crypto.randomBytes(32).toString("hex");
  const createdAt = Date.now();
  const lease: ManagedMcpTunnelLease = {
    version: 1,
    kind: OWNER_KIND,
    pid: process.pid,
    port,
    nonce,
    createdAt,
    workspace: process.cwd(),
  };
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try { await stopMcpTunnel(port); }
    finally {
      cleanManagedMcpTunnelLease(lease);
      process.exit(0);
    }
  };
  try {
    const info = await startMcpTunnel({
      ...options,
      ownerControlToken: nonce,
      ownerStartedAt: createdAt,
      ownerControlMode: OWNER_MODE,
      ownerPublicTunnelStarted: true,
      ownerStopHandler: shutdown,
    });
    try {
      writeManagedMcpTunnelLease(lease);
    } catch (error) {
      await stopMcpTunnel(port).catch(() => {});
      throw error;
    }
    process.once("SIGINT", () => { void shutdown(); });
    process.once("SIGTERM", () => { void shutdown(); });
    process.send?.({ type: "mcp-tunnel-owner-ready", pid: process.pid, info });
  } catch (error) {
    process.send?.({
      type: "mcp-tunnel-owner-error",
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
    });
    cleanManagedMcpTunnelLease(lease);
    process.exit(1);
  }
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}

export async function stopManagedMcpTunnelOwner(
  port: number,
  options?: { force?: boolean },
): Promise<{
  stopped: boolean;
  draining: boolean;
  activeSessions: number;
  inFlightRequests: number;
}> {
  assertPort(port);
  const lease = readManagedMcpTunnelLease(port);
  if (!lease) throw new Error(`MCP tunnel on port ${port} is not a managed independent owner`);
  verifyManagedOwnerIdentity(lease);
  let status = await probeManagedMcpTunnelOwner(lease);
  if (!status) throw new Error("Managed MCP tunnel owner did not authenticate");
  if (!status.draining) {
    status = await probeManagedMcpTunnelOwner(lease, "drain");
    if (!status?.draining) throw new Error("Managed MCP tunnel owner did not acknowledge drain");
  }
  if (!options?.force && (status.activeSessions > 0 || status.inFlightRequests > 0)) {
    return {
      stopped: false,
      draining: true,
      activeSessions: status.activeSessions,
      inFlightRequests: status.inFlightRequests,
    };
  }
  const stopOperation = options?.force ? "stop?force=1" : "stop";
  const stop = await requestOwner(lease, stopOperation);
  if (stop.statusCode !== 200 && !options?.force) {
    throw new Error(`Managed MCP tunnel owner refused stop (HTTP ${stop.statusCode || "unreachable"})`);
  }
  const deadline = Date.now() + (options?.force ? 2000 : STOP_TIMEOUT_MS);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const listenerPid = readListenerOwners()?.get(port);
    if (!listenerPid && !fs.existsSync(ownerLeasePath(port))) {
      return { stopped: true, draining: true, activeSessions: 0, inFlightRequests: 0 };
    }
  }
  if (options?.force) {
    try { process.kill(lease.pid, "SIGTERM"); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
    const listenerPid = readListenerOwners()?.get(port);
    if (listenerPid === lease.pid) {
      try { process.kill(lease.pid, "SIGKILL"); } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    cleanManagedMcpTunnelLease(lease);
    return { stopped: true, draining: true, activeSessions: 0, inFlightRequests: 0 };
  }
  throw new Error("Managed MCP tunnel owner did not complete graceful stop");
}

export function formatManagedMcpTunnelStartup(result: ManagedMcpTunnelStartResult): string {
  const { info, pid } = result;
  const lines = info.tunnelProvider === "openai"
    ? [
        "OpenAI Secure MCP Tunnel Online!",
        `- Owner PID    : ${pid} (independent process)`,
        `- Tunnel ID    : ${info.openAiTunnelId}`,
        `- Local MCP URL: ${info.localUrl}`,
        info.adminUrl ? `- Admin UI     : ${info.adminUrl}` : "",
        `- Auth Mode    : ${info.authMode}`,
        `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
      ]
    : [
        "MCP via Cloudflare Tunnel Online!",
        `- Owner PID    : ${pid} (independent process)`,
        `- Endpoint     : ${info.publicUrl}`,
        `- Local URL    : ${info.localUrl}`,
        `- Auth Mode    : ${info.authMode}`,
      ];

  if (info.authMode === "oauth") {
    lines.push(
      `- Discovery    : ${info.oauthDiscoveryUrl}`,
      `- OAuth state  : ${describeMcpOAuthStore({ persistent: info.oauthStatePersistent === true, reason: info.oauthStateReason })}`,
      ...(info.tunnelProvider === "cloudflare"
        ? [`- Scopes       : mcp:tools${info.dangerous ? " mcp:tools:write" : ""}`,
           `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
           `- Audit Log    : ${info.auditLogPath}`]
        : []),
      "",
      "One-time bootstrap approval code (shown ONCE, never stored):",
      `  - ${info.bootstrapCode}`,
    );
    if (info.tunnelProvider === "cloudflare") {
      lines.push(
        "",
        "Client setup (e.g. ChatGPT / Gemini):",
        `  1. Set MCP server URL to: ${info.publicUrl}`,
        "  2. Authentication: OAuth",
        "  3. Open browser authorization page when prompted and paste the bootstrap code above to approve.",
      );
    }
  } else {
    lines.push(
      `- Bearer Token : ${info.bearerToken}`,
      `- Tool Mode    : ${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`,
    );
  }
  lines.push(...formatPythonMcpClientHints(info));
  if (info.tunnelProvider === "openai") {
    lines.push(
      "",
      "Responses API tool definition:",
      JSON.stringify({
        model: "gpt-4o",
        input: "Use the private MCP server to answer my request.",
        tools: [{ type: "mcp", server_label: "superagent_mcp", tunnel_id: info.openAiTunnelId }],
      }, null, 2),
    );
  }
  lines.push(
    "",
    `MCP owner PID ${pid} is detached from Core. Use /mcp tunnel stop --port ${new URL(info.localUrl).port || DEFAULT_MCP_PORT} to drain and stop it.`,
  );
  return lines.filter((line) => line !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}
