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
import { describeMcpOAuthStore } from "../mcp/mcpOAuthPersistentStore.js";
import { getOpenAiMcpTunnelConfig } from "../mcp/openaiMcpTunnelConfig.js";
import { startReloadableMcpTunnelOwner, type ReloadableMcpOwnerHandle } from "./mcpReloadableOwner.js";
import { readListenerOwners } from "./coreMcpOwnershipAudit.js";
import { verifyWindowsProcessBirth } from "./mcpProcessBirth.js";
import { copyTextToClipboard, isProcessRunning } from "../remoteAgent/cloudflareTunnel.js";
import { readMcpTunnelAnchorLease, probeMcpTunnelAnchor } from "./mcpTunnelAnchorLease.js";

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
  inFlightToolCalls?: number;
  draining: boolean;
  inflightToolEffects: "unknown";
  safeToolsOnly: boolean;
  oauthEnabled: boolean;
  publicTunnelStarted: true;
  reloadable?: boolean;
  backendPid?: number | null;
  backendGenerations?: number;
  backendHealthy?: boolean;
  backendGenerationDetails?: Array<Record<string, unknown>>;
  sessionTelemetry?: Record<string, unknown>;
  memoryTelemetry?: Record<string, unknown>;
  autoRecovery?: Record<string, unknown>;
}

export interface ManagedMcpTunnelStartResult {
  pid: number;
  info: McpTunnelInfo;
  workspace?: string;
}

function ownerLeasePath(port: number): string {
  // An explicit private staging profile must isolate its owner lease too.
  // Without an override this preserves the historic ~/.superagent-r path.
  const root=process.env.SUPERAGENT_CONFIG_DIR?.trim();
  return path.join(root?path.resolve(root):path.join(os.homedir(),".superagent-r"),
    `mcp-owner-${port}.json`);
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

async function resolveExternalMcpAnchor(args:string[],ownerPort:number):Promise<string|undefined>{
  if(!args.includes("--anchor-port"))return undefined;
  const raw=option(args,"--anchor-port");
  const port=Number(raw);
  if(!raw||!Number.isSafeInteger(port)||port<1024||port>65535||
     port===ownerPort||port===7888)throw Error("MCP_EXTERNAL_ANCHOR_PORT_INVALID");
  const lease=readMcpTunnelAnchorLease(port);
  if(!lease)throw Error("MCP_EXTERNAL_ANCHOR_LEASE_MISSING");
  const proof=await probeMcpTunnelAnchor(lease);
  if(proof.currentOwnerPort===ownerPort)
    throw Error("MCP_EXTERNAL_ANCHOR_ALREADY_TARGETS_OWNER");
  if(proof.currentOwnerPort!==null){
    // OAuth issuer state is single-writer. Before the new owner can even
    // initialize its OAuth store, require a drained, session-free old owner.
    // A second writer would otherwise invalidate the durable MAC snapshot.
    const oldLease=readManagedMcpTunnelLease(proof.currentOwnerPort);
    if(!oldLease||oldLease.pid!==proof.currentOwnerPid)
      throw Error("MCP_EXTERNAL_ANCHOR_OLD_OWNER_UNVERIFIED");
    await verifyManagedOwnerIdentity(oldLease);
    const old=await probeManagedMcpTunnelOwner(oldLease) as
      (ManagedMcpTunnelOwnerStatus & {publicUrl?:string;ingressMode?:string;
        backendHealthy?:boolean;oauthStatePersistent?:boolean})|null;
    if(!old||!old.draining||old.activeSessions!==0||old.inFlightRequests!==0||
       old.backendHealthy!==true||old.publicUrl!==proof.publicUrl||
       old.ingressMode!=="external-anchor"||
       (old.oauthEnabled&&!old.oauthStatePersistent))
      throw Error("MCP_EXTERNAL_ANCHOR_OLD_OWNER_NOT_QUIESCENT");
  }
  return new URL(proof.publicUrl).origin;
}
function parseStartOptions(args: string[]): StartMcpTunnelOptions {
  const port = parsePort(args);
  const providerValue = option(args, "--provider")?.toLowerCase();
  const tunnelId = option(args, "--tunnel-id");
  const wantOpenAi = args.includes("--openai") || args.includes("--openai-tunnel") || Boolean(tunnelId);
  let tunnelProvider: "cloudflare" | "openai" | undefined = wantOpenAi ? "openai" : undefined;
  if (providerValue) {
    if (providerValue !== "cloudflare" && providerValue !== "openai") {
      throw new Error(`Unsupported MCP tunnel provider "${providerValue}". Supported providers: cloudflare, openai.`);
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

export function cleanManagedMcpTunnelLease(lease: ManagedMcpTunnelLease): void {
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
  operation: "status" | "drain" | "stop" | "stop?force=1" | "reload" | "bootstrap/rotate",
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
      timeout: operation === "reload" ? 60_000 : operation === "bootstrap/rotate" ? 7_000 : 1800,
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
        // Status now carries bounded aggregate memory/session telemetry. Keep
        // the private response capped while leaving room for several generations.
        if (text.length > 16 * 1024) req.destroy();
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
    (body.inFlightToolCalls !== undefined &&
      (!Number.isSafeInteger(body.inFlightToolCalls) || Number(body.inFlightToolCalls) < 0)) ||
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

export async function verifyManagedOwnerIdentity(
  lease: ManagedMcpTunnelLease,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? (process.platform === "win32" ? 8_000 : 2_000);
  const pollIntervalMs = options?.pollIntervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;

  let lastError: Error | null = null;
  while (true) {
    const state = readMcpStateFile(getMcpStateFile(lease.port));
    const listenerPid = readListenerOwners()?.get(lease.port);

    if (state && state.pid === lease.pid && listenerPid === lease.pid) {
      if (process.platform === "win32") {
        const birth = verifyWindowsProcessBirth(lease.pid, lease.createdAt);
        if (birth === "matched") {
          return;
        }
        lastError = new Error("MCP tunnel owner process birth could not be verified");
      } else {
        return;
      }
    } else {
      lastError = new Error("MCP tunnel owner identity does not match state and kernel listener");
    }

    if (Date.now() >= deadline || !isProcessRunning(lease.pid)) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw lastError ?? new Error("MCP tunnel owner identity does not match state and kernel listener");
}

export async function startManagedMcpTunnelOwner(
  args: string[],
  cliEntry = process.argv[1] || "",
  workspace = process.cwd(),
): Promise<ManagedMcpTunnelStartResult> {
  const parsedOptions = parseStartOptions(args);
  const port = assertPort(parsedOptions.port ?? DEFAULT_MCP_PORT);
  if(args.includes("--anchor-port")){
    if(parsedOptions.tunnelProvider==="openai"||parsedOptions.tunnelId)
      throw Error("MCP_EXTERNAL_ANCHOR_CLOUDFLARE_ONLY");
    await resolveExternalMcpAnchor(args,port);
  }
  if (listActiveMcpServers().some((server) => server.port === port) || readListenerOwners()?.has(port)) {
    throw new Error(`MCP port ${port} is already active; refusing duplicate owner`);
  }
  const existingLease = readManagedMcpTunnelLease(port);
  if (existingLease) {
    const isRunning = isProcessRunning(existingLease.pid);
    const hasListener = readListenerOwners()?.has(port);
    if (!isRunning && !hasListener) {
      cleanManagedMcpTunnelLease(existingLease);
    } else {
      throw new Error(`MCP port ${port} has an existing managed-owner lease; inspect it before retrying`);
    }
  }
  const entry = path.resolve(cliEntry);
  const workspacePath = path.resolve(workspace);
  const workspaceStat = fs.lstatSync(workspacePath);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
    throw new Error("Managed MCP tunnel requires a real workspace directory");
  }
  const stat = fs.lstatSync(entry);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Managed MCP tunnel requires a real SuperAgent CLI entry file");
  }
  const useWindowsTrampoline = process.platform === "win32";
  const child = fork(entry, ["mcp", useWindowsTrampoline ? "tunnel-launcher" : "tunnel-owner", ...args], {
    execPath: process.execPath,
    cwd: workspacePath,
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
    let verifying = false;
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
      if (settled) return;
      if (useWindowsTrampoline && code === 0) {
        if (verifying) return;
        setTimeout(() => {
          if (!settled && !verifying) {
            done(new Error("MCP owner launcher exited before ready (code 0)"));
          }
        }, 500);
        return;
      }
      done(new Error(`MCP owner launcher exited before ready (code ${code ?? "unknown"})`));
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
      verifying = true;
      try { child.send({ type: "mcp-tunnel-launcher-ack" }); } catch {}
      const ownerPid = m.pid;
      const lease = readManagedMcpTunnelLease(port);
      if (!lease || lease.pid !== ownerPid) {
        done(new Error("MCP owner reported ready without a matching private lease"));
        return;
      }
      void (async () => {
        try {
          await verifyManagedOwnerIdentity(lease);
          done(undefined, { pid: ownerPid, info: m.info!, workspace: lease.workspace });
        } catch (error) {
          try { await requestOwner(lease, "stop?force=1"); } catch {}
          try {
            if (isProcessRunning(ownerPid)) {
              process.kill(ownerPid, "SIGTERM");
            }
          } catch {}
          cleanManagedMcpTunnelLease(lease);
          done(error instanceof Error ? error : new Error(String(error)));
        }
      })();
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
      if (exitCode === 0) {
        const ackTimer = setTimeout(exit, 1500);
        ackTimer.unref();
        process.once("message", (msg: unknown) => {
          if (msg && typeof msg === "object" && (msg as any).type === "mcp-tunnel-launcher-ack") {
            clearTimeout(ackTimer);
            exit();
          }
        });
        process.send(message);
      } else {
        process.send(message, () => exit());
        const fallback = setTimeout(exit, 500);
        fallback.unref();
      }
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
  let reloadable: ReloadableMcpOwnerHandle | undefined;
  let legacyStarted = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      if (reloadable) await reloadable.close();
      else await stopMcpTunnel(port);
    }
    finally {
      cleanManagedMcpTunnelLease(lease);
      process.exit(0);
    }
  };
  try {
    // Cloudflare gets a durable ingress and a replaceable MCP backend.
    // OpenAI Secure MCP Tunnel keeps its legacy lifecycle until its control
    // plane transport supports independent backend swapping.
    const openAiConfigured = Boolean(
      process.env.OPENAI_MCP_TUNNEL_ID || getOpenAiMcpTunnelConfig().tunnelId,
    );
    const externalPublicBaseUrl=await resolveExternalMcpAnchor(args,port);
    if(externalPublicBaseUrl&&(options.tunnelProvider==="openai"||options.tunnelId))
      throw Error("MCP_EXTERNAL_ANCHOR_CLOUDFLARE_ONLY");
    const useReloadable = Boolean(externalPublicBaseUrl) || options.tunnelProvider === "cloudflare" ||
      (!options.tunnelProvider && !options.tunnelId && !openAiConfigured);
    let info: McpTunnelInfo;
    if (useReloadable) {
      reloadable = await startReloadableMcpTunnelOwner({
        port, nonce, createdAt, cliEntry: process.argv[1] || "",
        authMode: options.authMode || "static-bearer",
        allowDangerous: Boolean(options.allowDangerous),
        auditLogPath: options.auditLogPath,
        externalPublicBaseUrl,
        onStop: shutdown,
      });
      info = reloadable.info;
    } else {
      info = await startMcpTunnel({
        ...options,
        ownerControlToken: nonce,
        ownerStartedAt: createdAt,
        ownerControlMode: OWNER_MODE,
        ownerPublicTunnelStarted: true,
        ownerStopHandler: shutdown,
      });
      legacyStarted = true;
    }
    try {
      writeManagedMcpTunnelLease(lease);
    } catch (error) {
      if (reloadable) await reloadable.close().catch(() => {});
      else if (legacyStarted) await stopMcpTunnel(port).catch(() => {});
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

/**
 * Reload compiled MCP backend without restarting its public tunnel or owner.
 * Fail closed for legacy owners and any public URL/identity change.
 */
/**
 * Privileged operator-only bootstrap pairing code rotation. The public MCP
 * endpoint/issuer, existing OAuth refresh/access grants and Cloudflare process
 * are unchanged. Code plaintext is returned only through the authenticated
 * private loopback owner control response; never persisted.
 */
export async function regenerateManagedMcpBootstrapCode(port: number): Promise<{
  publicUrl: string; code: string; backendPid: number;
}> {
  assertPort(port);
  const lease = readManagedMcpTunnelLease(port);
  if (!lease) throw new Error("MCP_BOOTSTRAP_NO_MANAGED_OWNER");
  await verifyManagedOwnerIdentity(lease, {timeoutMs: 3000});
  const before = await probeManagedMcpTunnelOwner(lease);
  const state = readMcpStateFile(getMcpStateFile(port));
  if (!before || (before as any).reloadable !== true ||
      !state?.publicUrl || state.pid !== lease.pid) {
    throw new Error("MCP_BOOTSTRAP_LEGACY_OWNER: hot rotation requires a reloadable Cloudflare owner");
  }
  if (!before.oauthEnabled || state.authMode !== "oauth") {
    throw new Error("MCP_BOOTSTRAP_OAUTH_REQUIRED");
  }
  if (before.draining) throw new Error("MCP_BOOTSTRAP_OWNER_DRAINING");
  const response = await requestOwner(lease, "bootstrap/rotate");
  const result = response.body;
  if (response.statusCode !== 200 || result?.success !== true ||
      typeof result.code !== "string" ||
      !/^[a-zA-Z0-9_-]{24,128}$/.test(result.code) ||
      result.url !== state.publicUrl || !Number.isSafeInteger(result.backendPid)) {
    throw new Error(typeof result?.error === "string" && /^MCP_[A-Z0-9_]+$/.test(result.error)
      ? result.error : "MCP_BOOTSTRAP_ROTATION_NOT_CONFIRMED");
  }
  const after = await probeManagedMcpTunnelOwner(lease);
  const sameState = readMcpStateFile(getMcpStateFile(port));
  if (!after || after.pid !== before.pid || after.startedAt !== before.startedAt ||
      sameState?.publicUrl !== state.publicUrl) {
    throw new Error("MCP_BOOTSTRAP_URL_OR_OWNER_CHANGED");
  }
  return {publicUrl:state.publicUrl, code:result.code, backendPid:Number(result.backendPid)};
}

export async function reloadManagedMcpTunnelBackend(port: number): Promise<{
  success: true; port: number; publicUrl: string;
  backendPid: number; previousBackendPid: number | null;
}> {
  assertPort(port);
  const lease = readManagedMcpTunnelLease(port);
  if (!lease) throw new Error("MCP_RELOAD_NO_MANAGED_OWNER");
  await verifyManagedOwnerIdentity(lease, {timeoutMs: 3000});
  const before = await probeManagedMcpTunnelOwner(lease);
  const state = readMcpStateFile(getMcpStateFile(port));
  if (!before || !state?.publicUrl || state.pid !== lease.pid ||
      (before as any).reloadable !== true) {
    throw new Error(
      "MCP_RELOAD_LEGACY_OWNER: this owner cannot preserve its URL on restart; one-time migration required",
    );
  }
  if (before.draining) throw new Error("MCP_RELOAD_OWNER_DRAINING");
  const reply = await requestOwner(lease, "reload");
  const data = reply.body;
  if (reply.statusCode !== 200 || data?.success !== true ||
      !Number.isSafeInteger(data.pid) || Number(data.pid) <= 0) {
    throw new Error(typeof data?.error === "string" ? data.error : "MCP_RELOAD_FAILED");
  }
  const after = await probeManagedMcpTunnelOwner(lease);
  const sameState = readMcpStateFile(getMcpStateFile(port));
  if (!after || after.pid !== before.pid || after.startedAt !== before.startedAt ||
      sameState?.publicUrl !== state.publicUrl || data.url !== state.publicUrl) {
    throw new Error("MCP_RELOAD_IDENTITY_OR_PUBLIC_URL_CHANGED");
  }
  return {
    success: true, port, publicUrl: state.publicUrl,
    backendPid: Number(data.pid),
    previousBackendPid: Number.isSafeInteger(data.previousPid) ? Number(data.previousPid) : null,
  };
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

  const isRunning = isProcessRunning(lease.pid);
  const listenerPid = readListenerOwners()?.get(port);

  if (!isRunning && !listenerPid) {
    cleanManagedMcpTunnelLease(lease);
    return { stopped: true, draining: true, activeSessions: 0, inFlightRequests: 0 };
  }

  if (options?.force && !isRunning) {
    cleanManagedMcpTunnelLease(lease);
    return { stopped: true, draining: true, activeSessions: 0, inFlightRequests: 0 };
  }

  await verifyManagedOwnerIdentity(lease, { timeoutMs: 3_000 });
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

export function buildManagedMcpExtensionSetup(info: McpTunnelInfo): string | null {
  if (info.tunnelProvider !== "cloudflare") return null;
  if (info.authMode === "oauth") {
    return [
      `MCP URL   : ${info.publicUrl}`,
      "Auth      : OAuth",
      `Bootstrap : ${info.bootstrapCode}`,
    ].join("\n");
  }
  return [
    `MCP URL : ${info.publicUrl}`,
    "Auth    : Bearer",
    `Bearer  : ${info.bearerToken}`,
  ].join("\n");
}

export async function copyManagedMcpExtensionSetupToClipboard(
  result: ManagedMcpTunnelStartResult,
): Promise<boolean> {
  const setup = buildManagedMcpExtensionSetup(result.info);
  return setup ? copyTextToClipboard(setup) : false;
}

export function formatManagedMcpTunnelStartup(
  result: ManagedMcpTunnelStartResult,
  options?: { extensionSetupCopied?: boolean },
): string {
  const { info, pid } = result;
  const provider = info.tunnelProvider === "openai" ? "OpenAI Secure MCP Tunnel" : "Cloudflare Quick Tunnel";
  const toolMode = `${info.dangerous ? "FULL" : "SAFE"} (${info.toolCount} tools)`;
  const stopPort = new URL(info.localUrl).port || String(DEFAULT_MCP_PORT);
  const workspace = result.workspace || process.cwd();
  const currentProject = path.basename(workspace) || workspace;
  const extensionSetup = buildManagedMcpExtensionSetup(info);
  const lines = [
    `${provider} Online!`,
    `- Owner           : PID ${pid}`,
    `- Current Project : ${currentProject}`,
    `- Workspace Path  : ${workspace}`,
    `- Local Endpoint  : ${info.localUrl}`,
    ...(info.tunnelProvider === "openai"
      ? [`- Tunnel ID       : ${info.openAiTunnelId}`]
      : [`- MCP Endpoint    : ${info.publicUrl}`]),
    `- Auth / Tools    : ${info.authMode} / ${toolMode}`,
  ];

  if (info.authMode === "oauth") {
    lines.push(
      `- OAuth state     : ${describeMcpOAuthStore({ persistent: info.oauthStatePersistent === true, reason: info.oauthStateReason })}`,
    );
  }

  if (info.tunnelProvider === "cloudflare") {
    lines.push(
      "- Heartbeat       : active (25s keep-alive ping)",
    );
  }

  if (extensionSetup) {
    lines.push(
      "",
      options?.extensionSetupCopied
        ? "COPY FOR EXTENSION — copied to clipboard:"
        : "COPY FOR EXTENSION:",
      ...extensionSetup.split("\n").map((line) => `  ${line}`),
      "  Do not paste this credential block into AI chat.",
    );
  } else {
    lines.push(
      "",
      "Client setup:",
      `  Tunnel ID : ${info.openAiTunnelId}`,
      "  Auth      : OpenAI tunnel transport",
    );
  }

  lines.push(
    "",
    "Agent handoff (safe to paste):",
    "  Use the connected SuperAgent MCP server. Discover projects and tools first. Never request, echo, or store MCP credentials in chat.",
    "",
    ...(info.tunnelProvider === "cloudflare" ? [
      `Reload backend (same URL): /mcp tunnel reload --port ${stopPort}`,
      `MCP lifecycle log: /mcp tunnel logs --port ${stopPort} --tail 20`,
    ] : ["OpenAI Secure MCP Tunnel: backend-only reload unavailable"]),
    `Full owner/tunnel restart (URL may change): /mcp tunnel restart --port ${stopPort} --full`,
    `Stop: /mcp tunnel stop --port ${stopPort}`,
    "Advanced client/Python details: /mcp tunnel status",
  );
  return lines.filter((line) => line !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}
