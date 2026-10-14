/**
 * mcpOAuthRoutes.ts - OAuth 2.1 discovery, authorization, and token endpoints
 * for MCP tunnel OAuth mode (see ADR-006).
 *
 * Public (no token required):
 * - GET /.well-known/oauth-protected-resource  (RFC 9728)
 * - GET /.well-known/oauth-authorization-server (RFC 8414)
 * - GET /oauth/authorize  (owner-consent page)
 * - POST /oauth/authorize (approve/deny with one-time bootstrap code)
 * - POST /oauth/token     (authorization_code exchange + refresh rotation)
 *
 * SECURITY:
 * - The bootstrap approval code is generated once at OAuth-mode startup,
 *   printed ONCE to the terminal, and only its SHA-256 hash is stored.
 * - Authorization codes are one-time use; PKCE S256 is mandatory.
 * - Nothing here persists credentials to disk.
 */

import type http from "node:http";
import { McpOAuthStore, randomToken } from "./mcpOAuthStore.js";
import { sha256Hex, constantTimeEqual } from "./mcpAuth.js";
import { recordMcpOAuthAudit, type McpOAuthAuditStage } from "./mcpOAuthAudit.js";

export const OAUTH_SCOPES = ["mcp:tools", "mcp:tools:write"];

export interface McpOAuthRoutesConfig {
  store: McpOAuthStore;
  /** Public base URL, e.g. https://xxx.trycloudflare.com (no trailing slash). */
  publicBaseUrl: string;
  /** SHA-256 hex of the one-time bootstrap approval code. */
  bootstrapCodeHash: string;
  /** If true (default), unknown clients are auto-registered on first authorize.
   *  Owner approval via the bootstrap code remains mandatory. */
  autoRegisterClients?: boolean;
}

export interface McpOAuthRouteResult {
  handled: boolean;
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function json(statusCode: number, body: unknown): McpOAuthRouteResult {
  return {
    handled: true,
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function html(statusCode: number, body: string): McpOAuthRouteResult {
  return {
    handled: true,
    statusCode,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body,
  };
}

function notHandled(): McpOAuthRouteResult {
  return { handled: false, statusCode: 404, headers: {}, body: "" };
}

export function protectedResourceMetadataUrl(publicBaseUrl: string): string {
  return `${publicBaseUrl}/.well-known/oauth-protected-resource`;
}

function readBody(req: http.IncomingMessage, maxBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split("&")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    out[decodeURIComponent(part.slice(0, idx).replace(/\+/g, " "))] =
      decodeURIComponent(part.slice(idx + 1).replace(/\+/g, " "));
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function consentPage(req: PendingSummary): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Approve MCP access</title></head><body>
<h1>Approve MCP tunnel access</h1>
<p>Client <b>${escapeHtml(req.clientId)}</b> requests MCP access with scopes: <b>${escapeHtml(req.scope.join(" "))}</b>.</p>
<p>Redirect: <code>${escapeHtml(req.redirectUri)}</code></p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="request_id" value="${escapeHtml(req.requestId)}">
<label>One-time bootstrap code (printed at tunnel startup):<br>
<input type="password" name="bootstrap_code" autocomplete="off"></label><br><br>
<button type="submit" name="decision" value="approve">Approve</button>
<button type="submit" name="decision" value="deny">Deny</button>
</form></body></html>`;
}

type PendingSummary = {
  requestId: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
};

async function handleOAuthRouteInternal(
  req: http.IncomingMessage,
  config: McpOAuthRoutesConfig
): Promise<McpOAuthRouteResult> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const autoRegister = config.autoRegisterClients !== false;

  // ---- RFC 9728 protected-resource metadata (public) ----
  // Accept both origin-level and path-specific discovery conventions.
  if (
    req.method === "GET" &&
    (pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/mcp")
  ) {
    return json(200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    });
  }

  // ---- RFC 8414 authorization-server metadata / OIDC discovery (public) ----
  if (req.method === "GET" && (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/openid-configuration")) {
    return json(200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: OAUTH_SCOPES,
      token_endpoint_auth_methods_supported: ["none"],
      resource_indicators_supported: true,
    });
  }

  // ---- RFC 7591 Dynamic Client Registration endpoint (public) ----
  if (req.method === "POST" && pathname === "/oauth/register") {
    const ctype = (req.headers["content-type"] || "").toString();
    let params: Record<string, any>;
    try {
      const raw = await readBody(req);
      params = ctype.includes("application/json") ? JSON.parse(raw) : parseForm(raw);
    } catch {
      return json(400, { error: "invalid_request", error_description: "unreadable registration body" });
    }
    const redirectUris: string[] = Array.isArray(params["redirect_uris"])
      ? params["redirect_uris"]
      : typeof params["redirect_uris"] === "string"
      ? [params["redirect_uris"]]
      : [];
    if (!redirectUris.length) {
      return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris array is required" });
    }
    for (const r of redirectUris) {
      if (typeof r !== "string" || (!/^https:\/\//.test(r) && !/^http:\/\/127\.0\.0\.1/.test(r) && !/^http:\/\/localhost/.test(r)) || r.includes("#")) {
        return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be https or loopback URIs without fragments" });
      }
    }
    const clientId = typeof params["client_id"] === "string" && params["client_id"].trim()
      ? params["client_id"].trim()
      : `client_${randomToken(16)}`;
    const clientName = typeof params["client_name"] === "string" ? params["client_name"] : clientId;
    try {
      config.store.registerClient(clientId, redirectUris, {
        clientName,
        tokenEndpointAuthMethod: "none",
        grantTypes: ["authorization_code", "refresh_token"],
        responseTypes: ["code"],
      });
      return {
        handled: true,
        statusCode: 201,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Pragma": "no-cache",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_name: clientName,
          redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      };
    } catch (e: any) {
      return json(400, { error: "invalid_client_metadata", error_description: e.message || "registration failed" });
    }
  }

  // ---- Authorization endpoint: show owner-consent page ----
  if (req.method === "GET" && pathname === "/oauth/authorize") {
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const codeChallenge = url.searchParams.get("code_challenge") || "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
    const state = url.searchParams.get("state") || "";
    const scope = (url.searchParams.get("scope") || "mcp:tools").split(/\s+/).filter(Boolean);
    const requestedResource = url.searchParams.get("resource") || undefined;
    if (!clientId || !redirectUri || !codeChallenge) {
      return json(400, { error: "invalid_request", error_description: "client_id, redirect_uri, and code_challenge are required" });
    }
    if (!/^https:\/\//.test(redirectUri) && !/^http:\/\/127\.0\.0\.1/.test(redirectUri) && !/^http:\/\/localhost/.test(redirectUri)) {
      return json(400, { error: "invalid_request", error_description: "redirect_uri must be https (or http loopback)" });
    }
    if (redirectUri.includes("#")) {
      return json(400, { error: "invalid_request", error_description: "redirect_uri must not contain fragments" });
    }
    // RFC 8707 Resource validation:
    const canonicalResource = `${base}/mcp`;
    if (requestedResource) {
      try {
        const u = new URL(requestedResource);
        if (u.hash) {
          return json(400, { error: "invalid_target", error_description: "resource URI must not contain a fragment" });
        }
      } catch {
        return json(400, { error: "invalid_target", error_description: "resource must be a valid absolute URI" });
      }
      const cleanResource = requestedResource.replace(/\/$/, "");
      const cleanCanonical = canonicalResource.replace(/\/$/, "");
      const cleanBase = base.replace(/\/$/, "");
      if (cleanResource !== cleanCanonical && cleanResource !== cleanBase) {
        return json(400, { error: "invalid_target", error_description: "requested resource is not supported by this server" });
      }
    }
    try {
      if (autoRegister && !config.store.getClient(clientId)) {
        config.store.registerClient(clientId, [redirectUri]);
      }
      const pending = config.store.createAuthorizationRequest({
        clientId,
        redirectUri,
        codeChallenge,
        codeChallengeMethod,
        scope,
        state,
        resource: requestedResource || canonicalResource,
      });
      return html(200, consentPage({
        requestId: pending.requestId,
        clientId: pending.clientId,
        redirectUri: pending.redirectUri,
        scope: pending.scope,
      }));
    } catch (e: any) {
      return json(400, { error: "invalid_request", error_description: e.message || "invalid authorization request" });
    }
  }

  // ---- Authorization endpoint: owner approve/deny ----
  if (req.method === "POST" && pathname === "/oauth/authorize") {
    let form: Record<string, string>;
    try {
      form = parseForm(await readBody(req));
    } catch {
      return json(400, { error: "invalid_request", error_description: "unreadable form body" });
    }
    const pending = config.store.getAuthorizationRequest(form["request_id"] || "");
    if (!pending) {
      return json(400, { error: "invalid_request", error_description: "unknown or expired authorization request" });
    }
    // Verify the one-time bootstrap code in constant time.
    if (!constantTimeEqual(sha256Hex(form["bootstrap_code"] || ""), config.bootstrapCodeHash)) {
      return json(403, { error: "access_denied", error_description: "invalid bootstrap approval code" });
    }
    const approved = form["decision"] === "approve";
    const result = config.store.approveAuthorizationRequest(pending.requestId, approved);
    if (!result.ok) {
      return json(400, { error: "access_denied", error_description: result.error });
    }
    const redirect = new URL(pending.redirectUri);
    redirect.searchParams.set("code", result.code);
    if (pending.state) redirect.searchParams.set("state", pending.state);
    return { handled: true, statusCode: 302, headers: { Location: redirect.toString() }, body: "" };
  }

  // ---- Token endpoint ----
  if (req.method === "POST" && pathname === "/oauth/token") {
    const ctype = (req.headers["content-type"] || "").toString();
    let params: Record<string, string>;
    try {
      const raw = await readBody(req);
      params = ctype.includes("application/json") ? JSON.parse(raw) : parseForm(raw);
    } catch {
      return json(400, { error: "invalid_request", error_description: "unreadable token request body" });
    }
    if (params["grant_type"] === "authorization_code") {
      const r = config.store.exchangeCode({
        code: params["code"] || "",
        clientId: params["client_id"] || "",
        redirectUri: params["redirect_uri"] || "",
        codeVerifier: params["code_verifier"] || "",
        resource: params["resource"] || undefined,
      });
      if (!r.ok) {
        const isTargetErr = r.error.includes("resource mismatch");
        return json(400, {
          error: isTargetErr ? "invalid_target" : "invalid_grant",
          error_description: r.error,
        });
      }
      return {
        handled: true,
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Pragma": "no-cache",
        },
        body: JSON.stringify({
          access_token: r.accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: r.refreshToken,
          scope: r.scope.join(" "),
          ...(r.resource ? { resource: r.resource } : {}),
        }),
      };
    }
    if (params["grant_type"] === "refresh_token") {
      const r = config.store.rotateRefreshToken(
        params["refresh_token"] || "",
        params["resource"] || undefined
      );
      if (!r.ok) {
        const isTargetErr = r.error.includes("resource mismatch");
        return json(400, {
          error: isTargetErr ? "invalid_target" : "invalid_grant",
          error_description: r.error,
        });
      }
      return {
        handled: true,
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Pragma": "no-cache",
        },
        body: JSON.stringify({
          access_token: r.accessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: r.refreshToken,
          scope: r.scope.join(" "),
          ...(r.resource ? { resource: r.resource } : {}),
        }),
      };
    }
    return json(400, { error: "unsupported_grant_type", error_description: "grant_type must be authorization_code or refresh_token" });
  }

  return notHandled();
}

function auditStageForRequest(req: http.IncomingMessage): McpOAuthAuditStage | null {
  const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (
    req.method === "GET" &&
    (pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/mcp")
  ) return "oauth.protected_resource_metadata";
  if (
    req.method === "GET" &&
    (pathname === "/.well-known/oauth-authorization-server" ||
      pathname === "/.well-known/openid-configuration")
  ) return "oauth.authorization_server_metadata";
  if (req.method === "POST" && pathname === "/oauth/register") return "oauth.client_registration";
  if (req.method === "GET" && pathname === "/oauth/authorize") return "oauth.authorization_request";
  if (req.method === "POST" && pathname === "/oauth/authorize") return "oauth.authorization_decision";
  if (req.method === "POST" && pathname === "/oauth/token") return "oauth.token_request";
  return null;
}

/**
 * Record OAuth route outcomes with an explicit allow-list. The URL/query,
 * request body, client ID, state, authorization code, and tokens are omitted.
 */
export async function handleOAuthRoute(
  req: http.IncomingMessage,
  config: McpOAuthRoutesConfig
): Promise<McpOAuthRouteResult> {
  const stage = auditStageForRequest(req);
  const start = performance.now();
  try {
    const result = await handleOAuthRouteInternal(req, config);
    if (result.handled && stage) {
      recordMcpOAuthAudit({
        stage,
        method: req.method as "GET" | "POST",
        statusCode: result.statusCode,
        durationMs: performance.now() - start,
      });
    }
    return result;
  } catch (error) {
    if (stage) {
      recordMcpOAuthAudit({
        stage,
        method: req.method as "GET" | "POST",
        statusCode: 500,
        durationMs: performance.now() - start,
      });
    }
    throw error;
  }
}

/** Generate a one-time bootstrap approval code; returns { code, codeHash }.
 *  The code is printed ONCE by the caller; only the hash is stored. */
export function generateBootstrapCode(): { code: string; codeHash: string } {
  const code = randomToken(24);
  return { code, codeHash: sha256Hex(code) };
}
