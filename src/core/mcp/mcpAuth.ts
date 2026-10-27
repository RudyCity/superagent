/**
 * mcpAuth.ts - Authentication abstraction for the MCP tunnel server.
 *
 * Two explicit auth modes (see ADR-006):
 * - "static-bearer": one transient bearer token, constant-time comparison.
 * - "oauth": OAuth 2.1 access tokens issued by the local authorization server
 *   (see mcpOAuthStore.ts).
 *
 * SECURITY: no credential is ever written to disk or logs by this module.
 * Only SHA-256 hashes of credentials are exposed for log correlation.
 */

import crypto from "node:crypto";
import type http from "node:http";

export type McpAuthMode = "static-bearer" | "oauth";

export interface McpIdentity {
  mode: McpAuthMode;
  /** static-bearer: "bearer"; oauth: the OAuth client_id */
  subject: string;
  scopes: string[];
  /** sha256 hex of the credential, for log correlation (never the credential) */
  credentialHash: string;
}

export interface McpAuthChallenge {
  statusCode: 401;
  headers: Record<string, string>;
  body: unknown;
}

export type McpAuthResult =
  | { ok: true; identity: McpIdentity }
  | { ok: false; challenge: McpAuthChallenge };

/** SHA-256 hex digest (for credential hashes in logs, never the credential). */
export function sha256Hex(data: string): string {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Authorization scheme classification for diagnostics. It never contains the
 * credential: only whether a header was present and whether it used the Bearer
 * scheme. Scheme matching is case-insensitive per RFC 6750.
 */
export type McpAuthHeaderKind = "absent" | "bearer" | "other";

/**
 * Extract the raw bearer token from an Authorization header (no validation).
 * The scheme is case-insensitive (RFC 6750) and extra whitespace is tolerated,
 * because clients differ on "Bearer" vs "bearer" and on spacing.
 */
export function extractBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const m = /^bearer[ \t]+(\S(?:.*\S)?)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Classify an Authorization header without exposing the credential. */
export function classifyAuthHeader(req: http.IncomingMessage): McpAuthHeaderKind {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.trim()) return "absent";
  return /^\s*bearer(?:[ \t]|$)/i.test(header) ? "bearer" : "other";
}

/** Constant-time string comparison (length check is not secret). */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Verify a static bearer token in constant time. */
export function verifyStaticBearer(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  return constantTimeEqual(provided, expected);
}

/**
 * Standards-shaped Bearer challenge (RFC 6750 + RFC 9728).
 * Points the client at the protected-resource metadata URL for discovery.
 */
export function buildBearerChallenge(protectedResourceMetadataUrl: string): McpAuthChallenge {
  const wwwAuth =
    "Bearer resource_metadata=\"" +
    protectedResourceMetadataUrl +
    '\", error="invalid_token", ' +
    'error_description="Valid Bearer token required"';
  return {
    statusCode: 401,
    headers: { "WWW-Authenticate": wwwAuth },
    body: {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32000, message: "Unauthorized: valid Bearer token required" },
    },
  };
}

/** Authorize a request in static-bearer mode. */
export function authorizeStaticBearer(
  req: http.IncomingMessage,
  expectedToken: string,
  protectedResourceMetadataUrl: string
): McpAuthResult {
  const provided = extractBearerToken(req);
  if (verifyStaticBearer(provided, expectedToken)) {
    return {
      ok: true,
      identity: {
        mode: "static-bearer",
        subject: "bearer",
        scopes: [],
        credentialHash: sha256Hex(provided as string),
      },
    };
  }
  return { ok: false, challenge: buildBearerChallenge(protectedResourceMetadataUrl) };
}
