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
import { randomToken, type McpOAuthStoreContract } from "./mcpOAuthStore.js";
import { sha256Hex, constantTimeEqual } from "./mcpAuth.js";
import { isAllowedOAuthRedirectUri } from "./mcpOAuthRedirect.js";
import { recordMcpOAuthAudit, type McpOAuthAuditStage } from "./mcpOAuthAudit.js";

export const OAUTH_SCOPES = ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"];

export interface McpOAuthRoutesConfig {
  store: McpOAuthStoreContract;
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

function renderScopeChips(scopes: string[]): string {
  return scopes
    .map((s) => {
      let cls = "read";
      let label = "Safe tools";
      if (s.includes("admin")) {
        cls = "admin";
        label = "Admin grants";
      } else if (s.includes("write")) {
        cls = "write";
        label = "Workspace write";
      }
      return `<span class="scope-chip ${cls}"><code>${escapeHtml(s)}</code><small>${escapeHtml(label)}</small></span>`;
    })
    .join("");
}

function consentPage(req: PendingSummary): string {
  const isPrivileged = req.scope.includes("mcp:tools:admin");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Approve MCP access // SuperAgent</title>
  <style>
    :root {
      --bg: #080c14;
      --card-bg: #0f172a;
      --card-surface: #131d33;
      --border: #1e293b;
      --border-focus: #38bdf8;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --text-dim: #64748b;
      --primary: #10b981;
      --primary-hover: #059669;
      --primary-active: #047857;
      --primary-text: #022c22;
      --secondary-bg: #1e293b;
      --secondary-border: #334155;
      --secondary-hover: #29384d;
      --danger-hover: #e11d48;
      --danger-border: #9f1239;
      --warn-border: #d97706;
      --warn-bg: rgba(245, 158, 11, 0.08);
      --warn-title: #fbbf24;
      --warn-text: #fef3c7;
      --badge-bg: #1e293b;
      --badge-border: #334155;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    }

    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      background-image: radial-gradient(ellipse 70% 50% at 50% 0%, rgba(56, 189, 248, 0.06), transparent);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 1.5rem 1rem;
      line-height: 1.5;
      overflow-x: clip;
      -webkit-font-smoothing: antialiased;
    }

    .card {
      width: 100%;
      max-width: 520px;
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 16px;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.04);
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .card-header {
      padding: 1.75rem 1.75rem 1.25rem;
      border-bottom: 1px solid var(--border);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, transparent 100%);
    }

    .brand-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.875rem;
    }

    .brand {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #94a3b8;
    }

    .brand svg {
      width: 16px;
      height: 16px;
      color: #38bdf8;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      font-weight: 500;
      padding: 0.2rem 0.55rem;
      border-radius: 9999px;
      background: rgba(16, 185, 129, 0.12);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #34d399;
    }

    .status-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 6px #10b981;
    }

    h1 {
      font-size: 1.375rem;
      font-weight: 700;
      line-height: 1.3;
      color: var(--text);
      letter-spacing: -0.02em;
      margin-bottom: 0.35rem;
    }

    .subtitle {
      font-size: 0.875rem;
      color: var(--text-muted);
      line-height: 1.45;
    }

    .card-body {
      padding: 1.5rem 1.75rem;
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .meta-card {
      background: var(--card-surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.875rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.875rem;
    }

    .meta-row {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }

    .meta-label {
      font-size: 0.6875rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
    }

    .meta-val {
      font-size: 0.875rem;
      color: var(--text);
      word-break: break-all;
    }

    .meta-val.mono {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      color: #e2e8f0;
    }

    .meta-val code {
      font-family: var(--font-mono);
      font-size: 0.8125rem;
      color: #7dd3fc;
      background: rgba(14, 165, 233, 0.08);
      padding: 0.15rem 0.35rem;
      border-radius: 4px;
    }

    .scopes-container {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      margin-top: 0.15rem;
    }

    .scope-chip {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      font-family: var(--font-mono);
      font-size: 0.75rem;
      padding: 0.25rem 0.55rem;
      border-radius: 6px;
      background: var(--badge-bg);
      border: 1px solid var(--badge-border);
      color: #93c5fd;
    }

    .scope-chip small {
      font-family: var(--font-sans);
      font-size: 0.6875rem;
      color: var(--text-muted);
      opacity: 0.9;
    }

    .scope-chip.admin {
      background: rgba(245, 158, 11, 0.12);
      border-color: rgba(245, 158, 11, 0.35);
      color: #fbbf24;
    }

    .scope-chip.admin small {
      color: #fde68a;
    }

    .scope-chip.write {
      background: rgba(56, 189, 248, 0.1);
      border-color: rgba(56, 189, 248, 0.3);
      color: #38bdf8;
    }

    .scope-chip.read {
      background: rgba(16, 185, 129, 0.1);
      border-color: rgba(16, 185, 129, 0.25);
      color: #34d399;
    }

    .alert-privileged {
      background: var(--warn-bg);
      border: 1px solid var(--warn-border);
      border-radius: 10px;
      padding: 0.875rem 1rem;
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
    }

    .alert-icon {
      flex-shrink: 0;
      margin-top: 1px;
      color: var(--warn-title);
    }

    .alert-icon svg {
      width: 18px;
      height: 18px;
    }

    .alert-body {
      font-size: 0.8125rem;
      line-height: 1.45;
      color: var(--warn-text);
    }

    .alert-body strong {
      color: var(--warn-title);
      font-weight: 600;
    }

    form {
      display: flex;
      flex-direction: column;
      gap: 1.25rem;
    }

    .form-group {
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }

    .form-label {
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-muted);
    }

    .input-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    input[type="password"],
    input[type="text"] {
      width: 100%;
      height: 44px;
      padding: 0 2.5rem 0 0.875rem;
      background: #090e18;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--text);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      letter-spacing: 0.05em;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }

    input:focus {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.2);
    }

    .toggle-btn {
      position: absolute;
      right: 0.5rem;
      background: transparent;
      border: none;
      color: var(--text-dim);
      padding: 0.35rem;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 4px;
      transition: color 0.15s ease;
    }

    .toggle-btn:hover {
      color: var(--text);
    }

    .toggle-btn:focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 1px;
    }

    .toggle-btn svg {
      width: 16px;
      height: 16px;
    }

    .form-hint {
      font-size: 0.75rem;
      color: var(--text-dim);
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1.4fr;
      gap: 0.75rem;
      margin-top: 0.25rem;
    }

    .btn {
      height: 44px;
      min-height: 44px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      border-radius: 8px;
      font-family: var(--font-sans);
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      text-decoration: none;
      user-select: none;
    }

    .btn:active {
      transform: translateY(1px);
    }

    .btn-deny {
      background: var(--secondary-bg);
      border-color: var(--secondary-border);
      color: var(--text);
    }

    .btn-deny:hover {
      background: #27354a;
      border-color: var(--danger-border);
      color: #fecdd3;
    }

    .btn-deny:focus-visible {
      outline: 2px solid #f43f5e;
      outline-offset: 2px;
    }

    .btn-approve {
      background: var(--primary);
      color: var(--primary-text);
      box-shadow: 0 2px 8px rgba(16, 185, 129, 0.25);
    }

    .btn-approve:hover {
      background: var(--primary-hover);
      box-shadow: 0 4px 12px rgba(16, 185, 129, 0.35);
    }

    .btn-approve:focus-visible {
      outline: 2px solid #34d399;
      outline-offset: 2px;
    }

    .card-footer {
      padding: 0.875rem 1.75rem;
      background: rgba(0, 0, 0, 0.2);
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      font-size: 0.75rem;
      color: var(--text-dim);
    }

    .card-footer svg {
      width: 14px;
      height: 14px;
      color: #10b981;
    }

    @media (max-width: 480px) {
      .card-header {
        padding: 1.25rem 1.25rem 1rem;
      }
      .card-body {
        padding: 1.25rem;
      }
      .actions {
        grid-template-columns: 1fr;
      }
      .btn-deny {
        order: 2;
      }
      .btn-approve {
        order: 1;
      }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="card-header">
      <div class="brand-bar">
        <div class="brand">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>SuperAgent</span>
        </div>
        <div class="status-badge">
          <span class="status-dot"></span>
          <span>OAuth 2.1 PKCE</span>
        </div>
      </div>
      <h1>Approve MCP tunnel access</h1>
      <p class="subtitle">Client <b>${escapeHtml(req.clientId)}</b> requests MCP access with scopes: <b>${escapeHtml(req.scope.join(" "))}</b>.</p>
    </div>

    <div class="card-body">
      <div class="meta-card">
        <div class="meta-row">
          <span class="meta-label">Requesting Client</span>
          <span class="meta-val mono"><b>${escapeHtml(req.clientId)}</b></span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Redirect URI</span>
          <span class="meta-val mono"><p>Redirect: <code>${escapeHtml(req.redirectUri)}</code></p></span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Requested Scopes</span>
          <div class="scopes-container">
            ${renderScopeChips(req.scope)}
          </div>
        </div>
      </div>

      ${isPrivileged ? `
      <div class="alert-privileged" role="alert">
        <div class="alert-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <div class="alert-body">
          <p><strong>Privileged request:</strong> administrative scope allows changes to project registration and access grants. Approve only a trusted client.</p>
        </div>
      </div>` : ""}

      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="request_id" value="${escapeHtml(req.requestId)}">
        <div class="form-group">
          <label for="bootstrap_code" class="form-label">One-time bootstrap code (printed at tunnel startup):</label>
          <div class="input-wrapper">
            <input type="password" id="bootstrap_code" name="bootstrap_code" autocomplete="off" placeholder="Enter bootstrap code..." required autofocus>
            <button type="button" class="toggle-btn" id="toggle-pwd" aria-label="Toggle code visibility" title="Show or hide code">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <span class="form-hint">Security key generated at tunnel startup and printed to your terminal.</span>
        </div>

        <div class="actions">
          <button type="submit" name="decision" value="deny" class="btn btn-deny">Deny</button>
          <button type="submit" name="decision" value="approve" class="btn btn-approve">Approve</button>
        </div>
      </form>
    </div>

    <div class="card-footer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      <span>Protected by SuperAgent Secure MCP Gateway</span>
    </div>
  </div>

  <script>
    (function() {
      var btn = document.getElementById('toggle-pwd');
      var input = document.getElementById('bootstrap_code');
      if (!btn || !input) return;
      btn.addEventListener('click', function() {
        var isPwd = input.type === 'password';
        input.type = isPwd ? 'text' : 'password';
        btn.setAttribute('aria-label', isPwd ? 'Hide code' : 'Show code');
        btn.innerHTML = isPwd
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" y1="2" x2="22" y2="22"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
      });
    })();
  </script>
</body>
</html>`;
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
    if (redirectUris.length>16 || redirectUris.some(r=>!isAllowedOAuthRedirectUri(r))) {
      return json(400, { error: "invalid_redirect_uri", error_description: "redirect_uris must be https or exact http loopback URIs without fragments" });
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
    if (scope.some(item => !OAUTH_SCOPES.includes(item))) {
      return json(400, { error: "invalid_scope", error_description: "requested scope is not supported" });
    }
    if (scope.includes("mcp:tools:admin") && !scope.includes("mcp:tools:write")) {
      return json(400, { error: "invalid_scope", error_description: "mcp:tools:admin requires mcp:tools:write" });
    }
    const requestedResource = url.searchParams.get("resource") || undefined;
    if (!clientId || !redirectUri || !codeChallenge) {
      return json(400, { error: "invalid_request", error_description: "client_id, redirect_uri, and code_challenge are required" });
    }
    if (!isAllowedOAuthRedirectUri(redirectUri)) {
      return json(400, { error: "invalid_request", error_description: "redirect_uri must be https or exact http loopback without fragments" });
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
