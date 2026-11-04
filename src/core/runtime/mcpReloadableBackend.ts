/**
 * Private, replaceable MCP backend. The owning process keeps the public
 * Cloudflare Tunnel and stable ingress socket alive while this process changes.
 *
 * No public listener, Core server, Chrome bridge or tunnel-client is started.
 * Startup credentials travel only over the trusted child IPC channel.
 */
import { startMcpHttpServer, type McpHttpServerHandle } from "../mcp/mcpHttpTransport.js";
import { createPersistentMcpOAuthStore } from "../mcp/mcpOAuthPersistentStore.js";

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
  | { type: "mcp-reload-worker-error"; message: string };

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
): Promise<{ handle: McpHttpServerHandle; oauthStatePersistent: boolean }> {
  if (!validateReloadableBackendOptions(opts)) throw new Error("Invalid private MCP backend options");
  const issuer = new URL(opts.publicBaseUrl).origin;
  const oauth = opts.authMode === "oauth"
    ? createPersistentMcpOAuthStore({ issuer }) : undefined;
  const handle = await startMcpHttpServer({
    port: 0,
    allowDangerous: opts.allowDangerous,
    authMode: opts.authMode,
    bearerToken: opts.authMode === "static-bearer" ? opts.bearerToken : undefined,
    oauthStore: oauth?.store,
    oauth: oauth ? { publicBaseUrl: issuer, bootstrapCodeHash: opts.bootstrapCodeHash! } : undefined,
    auditLogPath: opts.auditLogPath,
    hostOriginPolicy: { allowNoOrigin: true },
  });
  return { handle, oauthStatePersistent: oauth?.persistent ?? true };
}

export async function runReloadableMcpBackendWorker(): Promise<never> {
  if (process.env.SUPERAGENT_MCP_RELOAD_WORKER !== "1" || !process.send) {
    throw new Error("Private MCP backend worker requires trusted owner IPC");
  }
  let started = false;
  let closing = false;
  let handle: McpHttpServerHandle | undefined;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try { await handle?.close(); } catch {}
    process.exit(0);
  };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  process.on("message", (message: unknown) => {
    if (started) return;
    const m = message as Partial<BackendWorkerRequest> | null;
    if (m?.type !== "mcp-reload-worker-start") return;
    started = true;
    void (async () => {
      try {
        const result = await startReloadableMcpBackend(m.options as ReloadableBackendOptions);
        handle = result.handle;
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
