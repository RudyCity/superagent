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

export async function handleOAuthRoute(
  req: http.IncomingMessage,
  config: McpOAuthRoutesConfig
): Promise<McpOAuthRouteResult> {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const base = config.publicBaseUrl.replace(/\/$/, "");
  const autoRegister = config.autoRegisterClients !== false;

  // ---- RFC 9728 protected-resource metadata (public) ----
  if (req.method === "GET" && pathname === "/.well-known/oauth-protected-resource") {
    return json(200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
    });
  }

  // ---- RFC 8414 authorization-server metadata (public) ----
  if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
    return json(200, {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: OAUTH_SCOPES,
      token_endpoint_auth_methods_supported: ["none"],
    });
  }

  // ---- Authorization endpoint: show owner-consent page ----
  if (req.method === "GET" && pathname === "/oauth/authorize") {
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const codeChallenge = url.searchParams.get("code_challenge") || "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
    const state = url.searchParams.get("state") || "";
    const scope = (url.searchParams.get("scope") || "mcp:tools").split(/\s+/).filter(Boolean);
    if (!clientId || !redirectUri || !codeChallenge) {
      return json(400, { error: "invalid_request", error_description: "client_id, redirect_uri, and code_challenge are required" });
    }
    if (!/^https:\/\//.test(redirectUri) && !/^http:\/\/127\.0\.0\.1/.test(redirectUri)) {
      return json(400, { error: "invalid_request", error_description: "redirect_uri must be https (or http loopback)" });
    }
    try {
      if (autoRegister && !config.store.getClient(clientId)) {
        config.store.registerClient(clientId, [redirectUri]);
      }
      const pending = config.store.createAuthorizationRequest({
        clientId, redirectUri, codeChallenge, codeChallengeMethod, scope, state,
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
      });
      if (!r.ok) return json(400, { error: "invalid_grant", error_description: r.error });
      return json(200, {
        access_token: r.accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: r.refreshToken,
        scope: r.scope.join(" "),
      });
    }
    if (params["grant_type"] === "refresh_token") {
      const r = config.store.rotateRefreshToken(params["refresh_token"] || "");
      if (!r.ok) return json(400, { error: "invalid_grant", error_description: r.error });
      return json(200, {
        access_token: r.accessToken,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: r.refreshToken,
        scope: r.scope.join(" "),
      });
    }
    return json(400, { error: "unsupported_grant_type", error_description: "grant_type must be authorization_code or refresh_token" });
  }

  return notHandled();
}

/** Generate a one-time bootstrap approval code; returns { code, codeHash }.
 *  The code is printed ONCE by the caller; only the hash is stored. */
export function generateBootstrapCode(): { code: string; codeHash: string } {
  const code = randomToken(24);
  return { code, codeHash: sha256Hex(code) };
}
