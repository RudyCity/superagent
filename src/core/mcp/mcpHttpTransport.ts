/**
 * mcpHttpTransport.ts - MCP over Streamable HTTP (tunnel mode).
 *
 * Exposes the Superagent MCP server over HTTP so it can be reached through
 * a Cloudflare quick tunnel by remote MCP clients.
 *
 * SECURITY MODEL (read before changing):
 * - Binds ONLY to 127.0.0.1. The tunnel is the sole network exposure.
 * - Every request requires `Authorization: Bearer <token>` (constant-time
 *   comparison). Tokens are NEVER accepted via query params (they leak into
 *   logs) and NEVER written to disk/logs by this module.
 * - Tool allowlist: by default only read-only ("safe") tools are exposed.
 *   Dangerous tools (command execution, file writes, agent control, ...)
 *   require explicit opt-in (`allowDangerous: true`, i.e. `--allow-dangerous`).
 * - Every tool invocation is appended to an audit log (JSONL).
 * - Treat the tunnel URL as PUBLIC. Security comes solely from the bearer.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createSuperagentMcpServer,
  type McpServerOptions,
} from "./superagentMcpServer.js";
import { McpOAuthStore } from "./mcpOAuthStore.js";
import {
  handleOAuthRoute,
  protectedResourceMetadataUrl,
  type McpOAuthRoutesConfig,
} from "./mcpOAuthRoutes.js";
import {
  extractBearerToken,
  verifyStaticBearer,
  buildBearerChallenge,
  sha256Hex,
  type McpAuthMode,
  type McpIdentity,
} from "./mcpAuth.js";
import {
  McpSessionRegistry,
  type McpSessionEntry,
} from "./mcpSessionRegistry.js";

/**
 * Tool classification for the tunnel allowlist.
 * "safe"      = read-only observability; exposed by default.
 * "dangerous" = can execute commands, mutate files/state, control agents;
 *               requires explicit opt-in.
 */
export const MCP_TOOL_CLASSIFICATION: Record<string, "safe" | "dangerous"> = {
  // ---- safe: read-only ----
  superagent_list_active: "safe",
  superagent_get_process_status: "safe",
  superagent_get_status: "safe",
  superagent_get_logs: "safe",
  superagent_read_file: "safe",
  superagent_list_files: "safe",
  superagent_grep_search: "safe",
  superagent_find_files: "safe",
  superagent_get_config: "safe",
  superagent_get_workspace: "safe",
  superagent_get_current_task: "safe",
  superagent_get_instance_task: "safe",
  superagent_get_plan_and_tasks: "safe",
  superagent_memory_search: "safe",
  superagent_query_history: "safe",
  superagent_get_token_usage: "safe",
  superagent_server_health: "safe",
  superagent_export_session: "safe",
  // ---- dangerous: mutation / execution / control ----
  superagent_exec_command: "dangerous", // arbitrary command execution (RCE)
  superagent_write_file: "dangerous",
  superagent_interrupt: "dangerous",
  superagent_pause: "dangerous",
  superagent_resume: "dangerous",
  superagent_send_message: "dangerous",
  superagent_run_task: "dangerous",
  superagent_spawn_subagent: "dangerous",
  superagent_invoke: "dangerous",
  superagent_cli_bridge: "dangerous",
  superagent_await: "dangerous",
  superagent_merge: "dangerous",
  superagent_manage: "dangerous",
  superagent_manage_worktrees: "dangerous",
  superagent_update_tasks: "dangerous",
  superagent_memory_save: "dangerous", // persistent memory poisoning risk
  superagent_switch_preset: "dangerous",
  superagent_switch_provider: "dangerous",
  superagent_switch_workspace: "dangerous",
  superagent_compact_context: "dangerous",
  superagent_remote_chrome: "dangerous",
};

export function getDefaultSafeTools(): string[] {
  return Object.entries(MCP_TOOL_CLASSIFICATION)
    .filter(([, level]) => level === "safe")
    .map(([name]) => name);
}

/** 256-bit bearer token (64 hex chars). Generate fresh per tunnel session. */
export function generateMcpBearerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function isAuthorized(req: http.IncomingMessage, expectedToken: string): boolean {
  return verifyStaticBearer(extractBearerToken(req), expectedToken);
}

function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args) ?? "<undefined>";
    return s.length > 500 ? s.slice(0, 500) + "\u2026(truncated)" : s;
  } catch {
    return "<unserializable>";
  }
}
export type McpAuditInfo = {
  tool: string;
  args: unknown;
  ok: boolean;
  error?: string;
  durationMs?: number;
};

/** Append-only JSONL audit logger. Never throws (must not break tool calls). */
export function createMcpAuditLogger(logPath: string): (info: McpAuditInfo) => void {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch {
    /* ignore */
  }
  return (info: McpAuditInfo) => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        tool: info.tool,
        args: summarizeArgs(info.args),
        ok: info.ok,
        error: info.error,
        durationMs: info.durationMs,
      });
      fs.appendFileSync(logPath, line + "\n", "utf8");
    } catch {
      /* audit logging must never break tool execution */
    }
  };
}

function readJsonBody(req: http.IncomingMessage, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on("data", (c: Buffer) => {
      if (rejected) return; // drain remaining bytes
      size += c.length;
      if (size > maxBytes) {
        rejected = true;
        // Do NOT destroy the socket: the caller sends a 413 response.
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Host/Origin validation policy (defense in depth).
 * Validation runs before auth and before any session is created.
 */
export interface McpHostOriginPolicy {
  /**
   * Explicit extra allowed Host header values (full "host[:port]").
   * Loopback (127.0.0.1, localhost) and the configured public tunnel hostname
   * are always allowed.
   */
  allowedHosts?: string[];
  /**
   * Explicit allowed Origin header values. When set, requests carrying an
   * Origin header must match; when unset, Origin is not validated.
   */
  allowedOrigins?: string[];
  /** Allow requests without an Origin header (server-to-server). Default true. */
  allowNoOrigin?: boolean;
}

/** Host validation: loopback always allowed; otherwise must match the public
 *  tunnel hostname or the explicit allowlist. */
export function isHostAllowed(
  hostHeader: string | undefined,
  publicHostname: string | undefined,
  allowedHosts: string[] | undefined
): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.trim().toLowerCase();
  const hostname = h.split(":")[0];
  if (hostname === "127.0.0.1" || hostname === "localhost") return true;
  if (publicHostname && hostname === publicHostname.toLowerCase()) return true;
  if (allowedHosts && allowedHosts.map((x) => x.trim().toLowerCase()).includes(h)) return true;
  return false;
}

/** Origin validation: absent Origin allowed only if allowNoOrigin; present
 *  Origin must be in the allowlist when one is configured. */
export function isOriginAllowed(
  origin: string | undefined,
  allowedOrigins: string[] | undefined,
  allowNoOrigin: boolean
): boolean {
  if (origin === undefined || origin === "") return allowNoOrigin;
  if (!allowedOrigins) return true;
  return allowedOrigins.map((x) => x.trim()).includes(origin.trim());
}

export interface McpOAuthServerConfig {
  /** Public base URL for metadata, e.g. https://xxx.trycloudflare.com */
  publicBaseUrl: string;
  /** SHA-256 hex of the one-time bootstrap approval code. */
  bootstrapCodeHash: string;
}

export interface McpHttpServerOptions {
  port: number;
  /**
   * Static bearer token. Required in static-bearer mode (the default);
   * ignored in oauth mode.
   */
  bearerToken?: string;
  allowDangerous: boolean;
  auditLogPath?: string;
  /** Auth mode: "static-bearer" (default) or "oauth". See ADR-006. */
  authMode?: McpAuthMode;
  /** Required when authMode is "oauth". */
  oauth?: McpOAuthServerConfig;
  /** Public base URL used for the WWW-Authenticate challenge metadata hint. */
  publicBaseUrl?: string;
  /** Max concurrent MCP sessions (default 32). */
  maxSessions?: number;
  /** Close sessions idle longer than this (default 30 min). */
  sessionIdleTimeoutMs?: number;
  /** Hard cap on session age (default 4 hours). */
  sessionMaxLifetimeMs?: number;
  /** Host/Origin validation policy (defense in depth). */
  hostOriginPolicy?: McpHostOriginPolicy;
}

export interface McpHttpServerHandle {
  /** Local URL of the MCP endpoint, e.g. http://127.0.0.1:9227/mcp */
  url: string;
  /** Actual bound port (useful when port 0 was requested). */
  port: number;
  close: () => Promise<void>;
  /** OAuth store (only set in oauth mode); used for status/diagnostics. */
  oauthStore?: McpOAuthStore;
}

export const MCP_HTTP_PATH = "/mcp";

export async function startMcpHttpServer(opts: McpHttpServerOptions): Promise<McpHttpServerHandle> {
  const authMode: McpAuthMode = opts.authMode ?? "static-bearer";

  let oauthStore: McpOAuthStore | undefined;
  let oauthRoutesConfig: McpOAuthRoutesConfig | undefined;
  if (authMode === "oauth") {
    if (!opts.oauth?.publicBaseUrl || !opts.oauth?.bootstrapCodeHash) {
      throw new Error("OAuth mode requires opts.oauth.publicBaseUrl and opts.oauth.bootstrapCodeHash.");
    }
    oauthStore = new McpOAuthStore();
    oauthRoutesConfig = {
      store: oauthStore,
      publicBaseUrl: opts.oauth.publicBaseUrl,
      bootstrapCodeHash: opts.oauth.bootstrapCodeHash,
    };
  } else {
    if (!opts.bearerToken || opts.bearerToken.length < 32) {
      throw new Error("MCP bearer token must be at least 32 characters (use generateMcpBearerToken()).");
    }
  }

  const metadataBase =
    opts.oauth?.publicBaseUrl ?? opts.publicBaseUrl ?? `http://127.0.0.1:${opts.port}`;

  // Defense in depth: Host/Origin policy, validated before auth and before
  // any session is created.
  const policy = opts.hostOriginPolicy ?? {};
  const allowNoOrigin = policy.allowNoOrigin !== false;
  let publicHostname: string | undefined;
  try {
    publicHostname = new URL(metadataBase).hostname;
  } catch {
    publicHostname = undefined;
  }

  const allowedTools = opts.allowDangerous ? undefined : getDefaultSafeTools();
  const auditLogPath = opts.auditLogPath || path.join(os.homedir(), ".superagent-r", "mcp-audit.log");
  const audit = createMcpAuditLogger(auditLogPath);

  // Per-session transports: no singleton remains. Every initialize creates a
  // fresh transport + MCP server pair, registered by mcp-session-id. A session
  // ID alone grants nothing: every request still requires valid credentials,
  // and a session is only usable with the identity it was created under.
  const registry = new McpSessionRegistry({
    maxSessions: opts.maxSessions,
    idleTimeoutMs: opts.sessionIdleTimeoutMs,
    maxLifetimeMs: opts.sessionMaxLifetimeMs,
  });

  const httpServer = http.createServer(async (req, res) => {
    try {
      // 1. Host validation (before everything else).
      if (!isHostAllowed(req.headers["host"], publicHostname, policy.allowedHosts)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid host" }));
        return;
      }
      // 2. Origin validation (before auth).
      if (!isOriginAllowed(req.headers["origin"], policy.allowedOrigins, allowNoOrigin)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "origin not allowed" }));
        return;
      }
      // OAuth discovery/authorization/token endpoints are public by design
      // (RFC 8414 / RFC 9728). They never require the MCP access token.
      if (oauthRoutesConfig) {
        const oauthResult = await handleOAuthRoute(req, oauthRoutesConfig);
        if (oauthResult.handled) {
          res.writeHead(oauthResult.statusCode, oauthResult.headers);
          res.end(oauthResult.body);
          return;
        }
      }
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      if (pathname !== MCP_HTTP_PATH) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      // Authenticate before touching any MCP state. Produces the identity
      // that new sessions are bound to.
      let identity: McpIdentity | null = null;
      if (authMode === "oauth" && oauthStore) {
        const token = extractBearerToken(req);
        const record = token ? oauthStore.verifyAccessToken(token) : null;
        if (record && token) {
          identity = {
            mode: "oauth",
            subject: record.clientId,
            scopes: record.scope,
            credentialHash: sha256Hex(token),
          };
        }
      } else if (isAuthorized(req, opts.bearerToken as string)) {
        const token = extractBearerToken(req) as string;
        identity = {
          mode: "static-bearer",
          subject: "bearer",
          scopes: [],
          credentialHash: sha256Hex(token),
        };
      }
      if (!identity) {
        const challenge = buildBearerChallenge(protectedResourceMetadataUrl(metadataBase));
        res.writeHead(challenge.statusCode, {
          "Content-Type": "application/json",
          ...challenge.headers,
        });
        res.end(JSON.stringify(challenge.body));
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const requestSessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;

      // Session binding: a session is only usable with the identity it was
      // created under (static-bearer: same token; oauth: same client).
      const isSessionBound = (session: McpSessionEntry): boolean => {
        const id = identity as McpIdentity;
        if (session.identity.mode !== id.mode) return false;
        if (id.mode === "static-bearer") {
          return session.identity.credentialHash === id.credentialHash;
        }
        return session.identity.subject === id.subject;
      };

      const readBody = async (): Promise<{ ok: true; body: unknown } | { ok: false }> => {
        try {
          return { ok: true, body: await readJsonBody(req) };
        } catch (e: any) {
          const tooLarge = e && typeof e.message === "string" && e.message.includes("too large");
          res.writeHead(tooLarge ? 413 : 400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: tooLarge ? "request body too large" : "invalid JSON body" }));
          return { ok: false };
        }
      };

      if (req.method === "DELETE") {
        if (!requestSessionId) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "mcp-session-id header required" }));
          return;
        }
        const removed = await registry.remove(requestSessionId);
        res.writeHead(removed ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(removed ? { ok: true } : { error: "unknown session" }));
        return;
      }

      if (requestSessionId) {
        const session = registry.get(requestSessionId);
        if (!session) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown mcp-session-id" }));
          return;
        }
        if (!isSessionBound(session)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session credential mismatch" }));
          return;
        }
        let body: unknown = undefined;
        if (req.method === "POST") {
          const r = await readBody();
          if (!r.ok) return;
          body = r.body;
        }
        registry.touch(requestSessionId);
        await session.transport.handleRequest(req, res, body);
        return;
      }

      // No session ID: this must be an initialize POST.
      if (req.method !== "POST") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "mcp-session-id header required for non-initialize requests" }));
        return;
      }
      if (registry.isFull()) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "too many concurrent MCP sessions" }));
        return;
      }
      const rb = await readBody();
      if (!rb.ok) return;
      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      const newServer = createSuperagentMcpServer({ allowedTools, onToolCall: audit } as McpServerOptions);
      await newServer.connect(newTransport);
      try {
        await newTransport.handleRequest(req, res, rb.body);
      } finally {
        const assignedId = newTransport.sessionId;
        if (assignedId) {
          try {
            registry.add({
              sessionId: assignedId,
              transport: newTransport,
              identity: identity as McpIdentity,
              createdAt: Date.now(),
              lastActivityAt: Date.now(),
            });
          } catch {
            try { await newTransport.close(); } catch { /* ignore */ }
            return;
          }
          newTransport.onclose = () => {
            void registry.remove(assignedId);
          };
        } else {
          try { await newTransport.close(); } catch { /* ignore */ }
        }
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    // SECURITY: bind loopback only. The Cloudflare tunnel is the sole network exposure.
    httpServer.listen(opts.port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const boundPort = (httpServer.address() as any)?.port ?? opts.port;
  return {
    url: `http://127.0.0.1:${boundPort}${MCP_HTTP_PATH}`,
    port: boundPort,
    oauthStore,
    close: () =>
      new Promise<void>((resolve) => {
        registry.closeAll().finally(() => {
          httpServer.close(() => resolve());
        });
      }),
  };
}
