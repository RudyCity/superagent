/**
 * Private, replaceable MCP backend. The owning process keeps the public
 * Cloudflare Tunnel and stable ingress socket alive while this process changes.
 *
 * No public listener, Core server, Chrome bridge or tunnel-client is started.
 * Startup credentials travel only over the trusted child IPC channel.
 */
import { startMcpHttpServer, type McpHttpServerHandle } from "../mcp/mcpHttpTransport.js";
import { createPersistentMcpOAuthStore } from "../mcp/mcpOAuthPersistentStore.js";
import { startMcpDelegateForwardingSubscription } from "./delegateForwardingLifecycle.js";
import { resolveDelegateCorePort } from "./delegateCoreEndpoint.js";

export interface ReloadableBackendOptions {
  port: number;
  publicBaseUrl: string;
  authMode: "oauth" | "static-bearer";
  allowDangerous: boolean;
  bearerToken: string;
  bootstrapCodeHash?: string;
  auditLogPath?: string;
}

export type BackendWorkerRequest = {
  type: "mcp-reload-worker-start";
  options: ReloadableBackendOptions;
};

export type BackendWorkerReply =
  | { type: "mcp-reload-worker-ready"; port: number; oauthStatePersistent: boolean }
  | { type: "mcp-reload-worker-error"; message: string }
  | { type: "mcp-reload-worker-bootstrap-rotated"; requestId: string }
  | { type: "mcp-reload-worker-bootstrap-consumed"; hash: string }
  | { type: "mcp-reload-worker-session-closed"; sessionId: string };

export const DISABLED_BOOTSTRAP_HASH = "0".repeat(64);
export type BootstrapRotateRequest = {
  type: "mcp-reload-worker-bootstrap-rotate";
  requestId: string;
  codeHash: string;
};

export function validateReloadableBackendOptions(
  value: unknown,
): value is ReloadableBackendOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<ReloadableBackendOptions>;
  if (!Number.isSafeInteger(v.port) || v.port! < 1024 || v.port! > 65535) return false;
  if (typeof v.publicBaseUrl !== "string" || v.publicBaseUrl.length > 2048) return false;
  try {
    const u = new URL(v.publicBaseUrl);
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password ||
        u.pathname !== "/" || u.search || u.hash) return false;
  } catch { return false; }
  if (v.authMode !== "oauth" && v.authMode !== "static-bearer") return false;
  if (typeof v.allowDangerous !== "boolean") return false;
  if (typeof v.bearerToken !== "string" || v.bearerToken.length < 32 ||
      v.bearerToken.length > 256) return false;
  if (v.authMode === "oauth" && !/^[a-f0-9]{64}$/.test(v.bootstrapCodeHash || "")) return false;
  return !v.auditLogPath || typeof v.auditLogPath === "string";
}

export async function startReloadableMcpBackend(
  opts: ReloadableBackendOptions,
  onConsumed?: (hash: string) => void,
  onSessionClosed?: (sessionId: string) => void,
): Promise<{
  handle: McpHttpServerHandle;
  oauthStatePersistent: boolean;
  rotateBootstrapHash: (hash: string) => void;
}> {
  if (!validateReloadableBackendOptions(opts)) throw new Error("Invalid private MCP backend options");
  const issuer = new URL(opts.publicBaseUrl).origin;
  const oauth = opts.authMode === "oauth"
    ? createPersistentMcpOAuthStore({ issuer }) : undefined;
  let liveBootstrapHash = opts.bootstrapCodeHash || DISABLED_BOOTSTRAP_HASH;
  const handle = await startMcpHttpServer({
    port: 0,
    allowDangerous: opts.allowDangerous,
    authMode: opts.authMode,
    bearerToken: opts.authMode === "static-bearer" ? opts.bearerToken : undefined,
    oauthStore: oauth?.store,
    oauth: oauth ? {
      publicBaseUrl: issuer,
      bootstrapCodeHash: opts.bootstrapCodeHash!,
      getBootstrapCodeHash: () => liveBootstrapHash,
      consumeBootstrapCode: usedHash => {
        if (liveBootstrapHash !== usedHash) return;
        liveBootstrapHash = DISABLED_BOOTSTRAP_HASH;
        onConsumed?.(usedHash);
      },
    } : undefined,
    auditLogPath: opts.auditLogPath,
    hostOriginPolicy: { allowNoOrigin: true },
    onSessionClosed,
  });
  return {
    handle, oauthStatePersistent: oauth?.persistent ?? true,
    rotateBootstrapHash(hash: string) {
      if (opts.authMode !== "oauth" || !/^[a-f0-9]{64}$/.test(hash)) {
        throw new Error("MCP_BOOTSTRAP_ROTATION_INVALID_MODE_OR_HASH");
      }
      liveBootstrapHash = hash;
    },
  };
}

export async function runReloadableMcpBackendWorker(): Promise<never> {
  if (process.env.SUPERAGENT_MCP_RELOAD_WORKER !== "1" || !process.send) {
    throw new Error("Private MCP backend worker requires trusted owner IPC");
  }
  let started = false;
  let closing = false;
  let handle: McpHttpServerHandle | undefined;
  let rotateBootstrapHash: ((hash:string) => void) | undefined;
  let delegateForwarding: ReturnType<typeof startMcpDelegateForwardingSubscription> | undefined;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    delegateForwarding?.close();
    try { await handle?.close(); } catch {}
    process.exit(0);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  process.on("message", (message: unknown) => {
    const rotate = message as Partial<BootstrapRotateRequest> | null;
    if (started && rotate?.type === "mcp-reload-worker-bootstrap-rotate") {
      if (!rotateBootstrapHash || typeof rotate.requestId !== "string" ||
          !/^[a-f0-9]{16}$/.test(rotate.requestId) ||
          typeof rotate.codeHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(rotate.codeHash)) return;
      rotateBootstrapHash(rotate.codeHash);
      process.send?.({
        type: "mcp-reload-worker-bootstrap-rotated",
        requestId: rotate.requestId,
      } satisfies BackendWorkerReply);
      return;
    }
    if (started) return;
    const m = message as Partial<BackendWorkerRequest> | null;
    if (m?.type !== "mcp-reload-worker-start") return;
    started = true;
    void (async () => {
      try {
        delegateForwarding = startMcpDelegateForwardingSubscription(resolveDelegateCorePort(), {
          retryMs: 1000,
          initialDeadlineMs: 1200,
        });
        // Delegate forwarding is optional for the MCP backend itself: if Core is
        // temporarily unavailable, other MCP tools still start and the signer
        // subscription keeps retrying in the background.
        await delegateForwarding.firstReady;
        const result = await startReloadableMcpBackend(
          m.options as ReloadableBackendOptions,
          hash => process.send?.({
            type: "mcp-reload-worker-bootstrap-consumed", hash,
          } satisfies BackendWorkerReply),
          sessionId => process.send?.({
            type: "mcp-reload-worker-session-closed", sessionId,
          } satisfies BackendWorkerReply),
        );
        handle = result.handle;
        rotateBootstrapHash = result.rotateBootstrapHash;
        process.send?.({
          type: "mcp-reload-worker-ready",
          port: handle.port,
          oauthStatePersistent: result.oauthStatePersistent,
        } satisfies BackendWorkerReply);
      } catch (error) {
        process.send?.({
          type: "mcp-reload-worker-error",
          message: error instanceof Error ? error.message.slice(0, 240) : "MCP backend startup failed",
        } satisfies BackendWorkerReply);
        await shutdown();
      }
    })();
  });
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}
