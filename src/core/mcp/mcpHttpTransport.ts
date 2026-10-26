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
import { summarizeArgs, argShape } from "./mcpLogSanitizer.js";
import { recordMcpOAuthAudit } from "./mcpOAuthAudit.js";
import {
  MCP_TOOL_CLASSIFICATION as MCP_TOOL_CLASSIFICATION_SRC,
  DISABLED_MCP_TOOLS,
  MCP_TOOL_DEFINITIONS,
} from "./superagentMcpServer.js";
/** Re-exported for backward compatibility; canonical in superagentMcpServer.ts. */
export const MCP_TOOL_CLASSIFICATION = MCP_TOOL_CLASSIFICATION_SRC;



export function getDefaultSafeTools(): string[] {
  return MCP_TOOL_DEFINITIONS
    .map((tool) => tool.name)
    .filter((name) => MCP_TOOL_CLASSIFICATION[name] === "safe" && !DISABLED_MCP_TOOLS.has(name));
}

/** 256-bit bearer token (64 hex chars). Generate fresh per tunnel session. */
export function generateMcpBearerToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function isAuthorized(req: http.IncomingMessage, expectedToken: string): boolean {
  return verifyStaticBearer(extractBearerToken(req), expectedToken);
}

// summarizeArgs moved to mcpLogSanitizer.ts (redacting version).
export type McpAuditInfo = {
  tool: string;
  args: unknown;
  ok: boolean;
  error?: string;
  durationMs?: number;
  /** SHA-256 prefix of the session credential (never the credential). */
  sessionHash?: string;
  correlationId?: string;
  principalHash?: string;
  projectId?: string | null;
  providerKind?: string | null;
  requiredCapability?: string;
  authorizationDecision?: "allowed" | "denied" | "not_applicable";
  errorCode?: string;
};

function sanitizeAuditError(error: string): string {
  return String(error)
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|password|secret|api[-_ ]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/ssh:\/\/[^\s]+/gi, "ssh://[REDACTED]")
    .slice(0, 240);
}

export interface McpAuditLoggerOptions {
  /** Maximum current-file size before rotating, in bytes. Defaults to 10 MiB. */
  maxBytes?: number;
  /** Number of numbered archives to retain beside the current log. Defaults to 5. */
  maxArchives?: number;
}

/** Append-only JSONL audit logger with bounded per-file growth and numbered archives. */
export function createMcpAuditLogger(logPath: string, options: McpAuditLoggerOptions = {}): (info: McpAuditInfo) => void {
  const maxBytes = Math.max(128, Math.floor(options.maxBytes ?? 10 * 1024 * 1024));
  const maxArchives = Math.max(0, Math.min(20, Math.floor(options.maxArchives ?? 5)));
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(logPath, "a", 0o600);
    fs.closeSync(fd);
  } catch {
    /* ignore; logger remains non-throwing and retries during append */
  }

  const rotateIfNeeded = (nextLineBytes: number) => {
    if (maxArchives <= 0 || !fs.existsSync(logPath)) return;
    const currentSize = fs.statSync(logPath).size;
    if (currentSize === 0 || currentSize + nextLineBytes <= maxBytes) return;
    for (let index = maxArchives; index >= 1; index -= 1) {
      const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
      const destination = `${logPath}.${index}`;
      if (!fs.existsSync(source)) continue;
      if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
      fs.renameSync(source, destination);
    }
  };

  return (info: McpAuditInfo) => {
    try {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        tool: info.tool,
        args: summarizeArgs(info.args),
        argShape: argShape(info.args),
        ok: info.ok,
        error: info.errorCode || (info.error ? sanitizeAuditError(info.error) : undefined),
        errorCode: info.errorCode,
        durationMs: info.durationMs,
        sessionHash: info.sessionHash,
        correlationId: info.correlationId,
        principalHash: info.principalHash,
        projectId: info.projectId,
        providerKind: info.providerKind,
        requiredCapability: info.requiredCapability,
        authorizationDecision: info.authorizationDecision,
      });
      const record = line + "\n";
      rotateIfNeeded(Buffer.byteLength(record, "utf8"));
      fs.appendFileSync(logPath, record, { encoding: "utf8", mode: 0o600 });
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
 * Normalizes the incoming Accept header to ensure compatibility with
 * @modelcontextprotocol/sdk Streamable HTTP requirements (requires both
 * application/json and text/event-stream).
 */
export function normalizeAcceptHeader(req: http.IncomingMessage): void {
  const desired = "application/json, text/event-stream";
  const rawAccept = req.headers["accept"];
  if (!rawAccept || rawAccept === "*/*" || !rawAccept.includes("text/event-stream") || !rawAccept.includes("application/json")) {
    req.headers["accept"] = desired;
    let found = false;
    if (Array.isArray(req.rawHeaders)) {
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === "accept") {
          req.rawHeaders[i + 1] = desired;
          found = true;
        }
      }
      if (!found) {
        req.rawHeaders.push("Accept", desired);
      }
    }
  }
}

export function isInitializePayload(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  if (Array.isArray(body)) {
    return body.some((item) => item && typeof item === "object" && (item as any).method === "initialize");
  }
  return (body as any).method === "initialize";
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
  /** Optional compact stable MCP gateway catalog for clients with static tool schemas. */
  toolExposure?: "full" | "gateway";
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
  /**
   * INTERNAL loopback owner management, opt-in only. Never enabled for a
   * public OAuth issuer or reused as an MCP client bearer. Only used by the
   * private, staged owner lifecycle.
   */
  ownerControlToken?: string;
  /** Immutable generation start timestamp, verified against private lease. */
  ownerStartedAt?: number;
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
  if (opts.ownerControlToken && (!/^[a-f0-9]{64}$/.test(opts.ownerControlToken) ||
      opts.ownerControlToken === opts.bearerToken || authMode !== "static-bearer" ||
      opts.allowDangerous !== false ||
      !Number.isSafeInteger(opts.ownerStartedAt) || opts.ownerStartedAt! <= 0)) {
    throw new Error("Private owner control must be isolated from MCP client authentication");
  }
  // Existing MCP/OAuth instances without ownerControlToken are unchanged.
  let ownerDraining = false;
  let inFlightMcpRequests = 0;

  const httpServer = http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
      // The opt-in private owner must count in-progress initialize and tool
      // requests; zero registered sessions does not imply a quiescent host.
      if (opts.ownerControlToken && (pathname === MCP_HTTP_PATH || pathname === "/")) {
        inFlightMcpRequests++;
        let finished = false;
        const settle = () => {
          if (!finished) { finished = true; inFlightMcpRequests--; }
        };
        res.once("finish", settle);
        res.once("close", settle);
      }
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
      if (pathname === "/_internal/owner/status" || pathname === "/_internal/owner/drain") {
        // Route must remain completely undiscoverable on legacy instances.
        // The listener itself is always bound to 127.0.0.1.
        if (!opts.ownerControlToken) {
          res.writeHead(404, { "Cache-Control": "no-store" });
          res.end();
          return;
        }
        if (!isAuthorized(req, opts.ownerControlToken)) {
          res.writeHead(401, { "Cache-Control": "no-store" });
          res.end();
          return;
        }
        const expectedMethod = pathname.endsWith("/status") ? "GET" : "POST";
        if (req.method !== expectedMethod) {
          res.writeHead(405, { "Cache-Control": "no-store" });
          res.end();
          return;
        }
        if (expectedMethod === "POST") ownerDraining = true;
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({
          version: 1, kind: "private_mcp_owner",
          port: opts.port, pid: process.pid, startedAt: opts.ownerStartedAt,
          mode: "static-bearer-local",
          draining: ownerDraining, activeSessions: registry.size,
          inFlightRequests: inFlightMcpRequests,
          // Number of unresolved external tool effects is NOT tracked by
          // the transport and must never be incorrectly reported as zero.
          inflightToolEffects: "unknown",
          safeToolsOnly: opts.allowDangerous === false,
          oauthEnabled: authMode === "oauth",
          publicTunnelStarted: false,
        }));
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
      if (pathname !== MCP_HTTP_PATH && pathname !== "/") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      normalizeAcceptHeader(req);
      if (req.method !== "POST" && req.method !== "GET" && req.method !== "HEAD" && req.method !== "DELETE") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      // Authenticate before touching any MCP state. Produces the identity
      // that new sessions are bound to.
      let identity: McpIdentity | null = null;
      if (authMode === "oauth" && oauthStore) {
        const token = extractBearerToken(req);
        const canonicalResource = `${metadataBase}/mcp`;
        const record = token ? oauthStore.verifyAccessToken(token, canonicalResource) : null;
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
          "Cache-Control": "no-store",
          ...challenge.headers,
        });
        if (req.method === "HEAD" || req.method === "POST") {
          recordMcpOAuthAudit({
            stage: "mcp.endpoint_probe",
            method: req.method,
            statusCode: 401,
          });
        }
        // HEAD must never return a body, while keeping authentication discovery
        // available through the WWW-Authenticate response header.
        res.end(req.method === "HEAD" ? undefined : JSON.stringify(challenge.body));
        return;
      }

      // A client may probe the protected endpoint before starting OAuth. Return
      // headers only, with no MCP session allocation or tool dispatch.
      if (req.method === "HEAD") {
        res.writeHead(204, {
          "Cache-Control": "no-store",
          "Content-Length": "0",
        });
        recordMcpOAuthAudit({
          stage: "mcp.endpoint_probe",
          method: "HEAD",
          statusCode: 204,
        });
        res.end();
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const requestSessionId = typeof sessionIdHeader === "string" ? sessionIdHeader : undefined;
      if (ownerDraining && req.method === "POST" && !requestSessionId) {
        // No new stateless calls or initialize requests after drain. Requests
        // for already-bound sessions can finish normally until deleted/expired.
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
        res.end(JSON.stringify({ error: "MCP owner draining: new requests disabled" }));
        return;
      }

      // Session servers capture the initialization identity in getIdentity().
      // Bind them to the *exact* current credential, not just OAuth client_id:
      // a refreshed token must initialize a fresh session, and a read-scoped
      // token from the same client must never inherit an old write-scoped one.
      const isSessionBound = (session: McpSessionEntry): boolean => {
        const id = identity as McpIdentity;
        return session.identity.mode === id.mode
          && session.identity.subject === id.subject
          && session.identity.credentialHash === id.credentialHash;
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
        const toRemove = registry.get(requestSessionId);
        if (toRemove && !isSessionBound(toRemove)) {
          res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "session credential mismatch" }));
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
        const diagnosticStage = getMcpDiagnosticStage(body);
        const diagnosticStart = performance.now();
        try {
          await session.transport.handleRequest(req, res, body);
        } finally {
          if (diagnosticStage) {
            recordMcpOAuthAudit({
              stage: diagnosticStage,
              method: "POST",
              statusCode: res.statusCode || 200,
              durationMs: performance.now() - diagnosticStart,
            });
          }
        }
        return;
      }

      // No active session in registry: this must be a POST request.
      if (req.method !== "POST") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "mcp-session-id header required for non-initialize requests" }));
        return;
      }
      const rb = await readBody();
      if (!rb.ok) return;

      const isInit = isInitializePayload(rb.body);
      if (isInit) {
        if (ownerDraining) {
          res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
          res.end(JSON.stringify({ error: "MCP owner draining: new sessions disabled" }));
          return;
        }
        if (registry.isFull()) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "too many concurrent MCP sessions" }));
          return;
        }
        const newTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        const sessionCtx: { sessionHash?: string } = {
          sessionHash: (identity as McpIdentity).credentialHash.slice(0, 16),
        };
        const sessionAudit = (info: McpAuditInfo) => audit({ ...info, sessionHash: sessionCtx.sessionHash });
        const newServer = createSuperagentMcpServer({
          toolExposure: opts.toolExposure,
          allowedTools,
          onToolCall: sessionAudit,
          authMode,
          allowDangerous: opts.allowDangerous,
          getIdentity: () => identity,
          workspace: process.cwd(),
        } as McpServerOptions);
        await newServer.connect(newTransport);
        try {
          const diagnosticStage = getMcpDiagnosticStage(rb.body);
          const diagnosticStart = performance.now();
          try {
            await newTransport.handleRequest(req, res, rb.body);
          } finally {
            if (diagnosticStage) {
              recordMcpOAuthAudit({
                stage: diagnosticStage,
                method: "POST",
                statusCode: res.statusCode || 200,
                durationMs: performance.now() - diagnosticStart,
              });
            }
          }
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
        return;
      }

      // Stateless execution: handles direct POST requests without prior initialization
      // (e.g. tools/call, tools/list) as well as graceful recovery from stale/evicted session IDs.
      const statelessTransport = new StreamableHTTPServerTransport();
      const sessionCtx: { sessionHash?: string } = {
        sessionHash: (identity as McpIdentity).credentialHash.slice(0, 16),
      };
      const sessionAudit = (info: McpAuditInfo) => audit({ ...info, sessionHash: sessionCtx.sessionHash });
      const statelessServer = createSuperagentMcpServer({
        toolExposure: opts.toolExposure,
        allowedTools,
        onToolCall: sessionAudit,
        authMode,
        allowDangerous: opts.allowDangerous,
        getIdentity: () => identity,
        workspace: process.cwd(),
      } as McpServerOptions);
      await statelessServer.connect(statelessTransport);
      try {
        const diagnosticStage = getMcpDiagnosticStage(rb.body);
        const diagnosticStart = performance.now();
        try {
          await statelessTransport.handleRequest(req, res, rb.body);
        } finally {
          if (diagnosticStage) {
            recordMcpOAuthAudit({
              stage: diagnosticStage,
              method: "POST",
              statusCode: res.statusCode || 200,
              durationMs: performance.now() - diagnosticStart,
            });
          }
        }
      } finally {
        try { await statelessTransport.close(); } catch { /* ignore */ }
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
        void (async () => {
          try { await registry.closeAll(); } catch {}
          try {
            const { standaloneSshProjectProvider } = await import("./tools/standaloneSshProjectTools.js");
            await standaloneSshProjectProvider.closeAll();
          } catch {}
          httpServer.close(() => resolve());
        })();
      }),
  };
}

function getMcpDiagnosticStage(body: unknown): "mcp.initialize" | "mcp.tools_list" | "mcp.tools_call" | null {
  if (!body || typeof body !== "object") return null;
  const messages = Array.isArray(body) ? body : [body];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const method = (message as { method?: unknown }).method;
    if (method === "initialize") return "mcp.initialize";
    if (method === "tools/list") return "mcp.tools_list";
    if (method === "tools/call") return "mcp.tools_call";
  }
  return null;
}
