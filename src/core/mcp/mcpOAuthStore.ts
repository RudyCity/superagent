/**
 * mcpOAuthStore.ts - In-memory OAuth 2.1 state store for MCP tunnel OAuth mode.
 *
 * Holds pending authorization requests, authorization codes, access/refresh
 * token records, and client registrations. All codes and tokens are generated
 * with crypto.randomBytes and stored as SHA-256 hashes; the raw values are
 * returned to the caller exactly once and never persisted.
 *
 * SECURITY:
 * - Authorization codes are one-time use (replay is rejected).
 * - PKCE S256 is required; plain method is rejected.
 * - Nothing in this store is written to disk.
 */

import crypto from "node:crypto";
import { sha256Hex } from "./mcpAuth.js";

export interface PendingAuthorizationRequest {
  /** Internal request id (not exposed to the client). */
  requestId: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string[];
  /** Opaque client state, echoed back on redirect. */
  state: string;
  createdAt: number;
  expiresAt: number;
  /** Owner consent decision; code is issued only after approval. */
  approved: boolean;
  /** RFC 8707 resource URI indicator (canonical MCP resource). */
  resource?: string;
}

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string[];
  createdAt: number;
  expiresAt: number;
  used: boolean;
  /** RFC 8707 resource URI indicator. */
  resource?: string;
}

export interface TokenRecord {
  tokenHash: string;
  clientId: string;
  scope: string[];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  /** RFC 8707 resource / audience URI indicator. */
  resource?: string;
}

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  createdAt: number;
  clientName?: string;
  tokenEndpointAuthMethod?: string;
  grantTypes?: string[];
  responseTypes?: string[];
}

export const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;
export const AUTH_CODE_TTL_MS = 10 * 60 * 1000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Cryptographically random token (base64url). */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Verify a PKCE S256 code_verifier against the stored code_challenge. */
export function verifyPkceS256(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || !codeChallenge) return false;
  const computed = crypto.createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(codeChallenge, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export type AuthRequestParams = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope: string[];
  state: string;
  resource?: string;
};

export type ExchangeParams = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
  resource?: string;
};

export class McpOAuthStore {
  private authRequests = new Map<string, PendingAuthorizationRequest>();
  private codes = new Map<string, AuthorizationCodeRecord>();
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, TokenRecord>();
  private clients = new Map<string, RegisteredClient>();

  /** Register (or update) a client. Supports RFC 7591 dynamic registration metadata. */
  registerClient(
    clientId: string,
    redirectUris: string[],
    meta?: {
      clientName?: string;
      tokenEndpointAuthMethod?: string;
      grantTypes?: string[];
      responseTypes?: string[];
    }
  ): RegisteredClient {
    if (!clientId || !Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new Error("clientId and at least one redirectUri are required");
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || uri.includes("#")) {
        throw new Error("redirect_uri must be a valid URI without fragments");
      }
      if (!/^https:\/\//.test(uri) && !/^http:\/\/127\.0\.0\.1/.test(uri) && !/^http:\/\/localhost/.test(uri)) {
        throw new Error("redirect_uri must use https (or http loopback)");
      }
    }
    const client: RegisteredClient = {
      clientId,
      redirectUris,
      createdAt: Date.now(),
      clientName: meta?.clientName,
      tokenEndpointAuthMethod: meta?.tokenEndpointAuthMethod || "none",
      grantTypes: meta?.grantTypes || ["authorization_code", "refresh_token"],
      responseTypes: meta?.responseTypes || ["code"],
    };
    this.clients.set(clientId, client);
    return client;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /** Create a pending authorization request after validating client + redirect URI + optional resource. */
  createAuthorizationRequest(params: AuthRequestParams): PendingAuthorizationRequest {
    const client = this.clients.get(params.clientId);
    if (!client) throw new Error("unknown client_id");
    if (!client.redirectUris.includes(params.redirectUri)) {
      throw new Error("redirect_uri not registered for client");
    }
    if (params.codeChallengeMethod !== "S256") {
      throw new Error("only PKCE S256 is supported");
    }
    if (!params.codeChallenge) throw new Error("code_challenge is required");
    if (params.resource) {
      try {
        const u = new URL(params.resource);
        if (u.hash) throw new Error("resource URI must not contain a fragment");
      } catch {
        throw new Error("resource must be a valid absolute URI without a fragment");
      }
    }
    const now = Date.now();
    const req: PendingAuthorizationRequest = {
      requestId: randomToken(16),
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      scope: params.scope,
      state: params.state,
      resource: params.resource,
      createdAt: now,
      expiresAt: now + AUTH_REQUEST_TTL_MS,
      approved: false,
    };
    this.authRequests.set(req.requestId, req);
    return req;
  }

  getAuthorizationRequest(requestId: string): PendingAuthorizationRequest | undefined {
    return this.authRequests.get(requestId);
  }

  /**
   * Owner approves (or denies) a pending request. On approval a one-time
   * authorization code is issued and the raw code is returned exactly once.
   */
  approveAuthorizationRequest(
    requestId: string,
    approved: boolean
  ): { ok: true; code: string } | { ok: false; error: string } {
    const req = this.authRequests.get(requestId);
    if (!req) return { ok: false, error: "unknown authorization request" };
    if (Date.now() > req.expiresAt) {
      this.authRequests.delete(requestId);
      return { ok: false, error: "authorization request expired" };
    }
    if (!approved) {
      this.authRequests.delete(requestId);
      return { ok: false, error: "owner denied the authorization request" };
    }
    req.approved = true;
    const code = randomToken(32);
    const now = Date.now();
    this.codes.set(sha256Hex(code), {
      codeHash: sha256Hex(code),
      clientId: req.clientId,
      redirectUri: req.redirectUri,
      codeChallenge: req.codeChallenge,
      scope: req.scope,
      resource: req.resource,
      createdAt: now,
      expiresAt: now + AUTH_CODE_TTL_MS,
      used: false,
    });
    this.authRequests.delete(requestId);
    return { ok: true, code };
  }

  /**
   * Exchange an authorization code for tokens. One-time use: replay is rejected.
   * Validates client_id, redirect_uri, PKCE code_verifier, and resource indicators.
   */
  exchangeCode(
    params: ExchangeParams
  ): { ok: true; accessToken: string; refreshToken: string; scope: string[]; resource?: string } | { ok: false; error: string } {
    const rec = this.codes.get(sha256Hex(params.code));
    if (!rec) return { ok: false, error: "invalid authorization code" };
    if (rec.used) return { ok: false, error: "authorization code already used" };
    if (Date.now() > rec.expiresAt) {
      this.codes.delete(sha256Hex(params.code));
      return { ok: false, error: "authorization code expired" };
    }
    if (rec.clientId !== params.clientId) return { ok: false, error: "client_id mismatch" };
    if (rec.redirectUri !== params.redirectUri) return { ok: false, error: "redirect_uri mismatch" };
    if (!verifyPkceS256(params.codeVerifier, rec.codeChallenge)) {
      return { ok: false, error: "PKCE verification failed" };
    }
    // RFC 8707: If resource parameter is passed on exchange, it must match the authorized resource
    if (params.resource && rec.resource && params.resource !== rec.resource) {
      return { ok: false, error: "resource mismatch" };
    }
    rec.used = true;
    const now = Date.now();
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    const boundResource = params.resource || rec.resource;
    this.accessTokens.set(sha256Hex(accessToken), {
      tokenHash: sha256Hex(accessToken),
      clientId: rec.clientId,
      scope: rec.scope,
      resource: boundResource,
      createdAt: now,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      revoked: false,
    });
    this.refreshTokens.set(sha256Hex(refreshToken), {
      tokenHash: sha256Hex(refreshToken),
      clientId: rec.clientId,
      scope: rec.scope,
      resource: boundResource,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      revoked: false,
    });
    return { ok: true, accessToken, refreshToken, scope: rec.scope, resource: boundResource };
  }

  /** Verify an access token; validates revocation, expiry, and optional target resource. */
  verifyAccessToken(token: string, expectedResource?: string): TokenRecord | null {
    if (!token) return null;
    const rec = this.accessTokens.get(sha256Hex(token));
    if (!rec || rec.revoked || Date.now() > rec.expiresAt) return null;
    if (expectedResource && rec.resource) {
      const normExpected = expectedResource.replace(/\/$/, "");
      const normActual = rec.resource.replace(/\/$/, "");
      const matches =
        normActual === normExpected ||
        normExpected === `${normActual}/mcp` ||
        normActual === `${normExpected}/mcp`;
      if (!matches) {
        return null;
      }
    }
    return rec;
  }

  /**
   * Rotate a refresh token: the old one is revoked and a fresh pair is issued.
   * Preserves target resource binding across rotations; rejects resource switching.
   */
  rotateRefreshToken(
    refreshToken: string,
    requestedResource?: string
  ): { ok: true; accessToken: string; refreshToken: string; scope: string[]; resource?: string } | { ok: false; error: string } {
    if (!refreshToken) return { ok: false, error: "refresh_token required" };
    const rec = this.refreshTokens.get(sha256Hex(refreshToken));
    if (!rec) return { ok: false, error: "invalid refresh token" };
    if (rec.revoked) return { ok: false, error: "refresh token already rotated" };
    if (Date.now() > rec.expiresAt) return { ok: false, error: "refresh token expired" };
    if (requestedResource && rec.resource) {
      const normRequested = requestedResource.replace(/\/$/, "");
      const normActual = rec.resource.replace(/\/$/, "");
      const matches =
        normActual === normRequested ||
        normRequested === `${normActual}/mcp` ||
        normActual === `${normRequested}/mcp`;
      if (!matches) {
        return { ok: false, error: "resource mismatch" };
      }
    }
    rec.revoked = true;
    const now = Date.now();
    const accessToken = randomToken(32);
    const newRefreshToken = randomToken(32);
    this.accessTokens.set(sha256Hex(accessToken), {
      tokenHash: sha256Hex(accessToken),
      clientId: rec.clientId,
      scope: rec.scope,
      resource: rec.resource,
      createdAt: now,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      revoked: false,
    });
    this.refreshTokens.set(sha256Hex(newRefreshToken), {
      tokenHash: sha256Hex(newRefreshToken),
      clientId: rec.clientId,
      scope: rec.scope,
      resource: rec.resource,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      revoked: false,
    });
    return { ok: true, accessToken, refreshToken: newRefreshToken, scope: rec.scope, resource: rec.resource };
  }

  /** Revoke a token by its raw value (access or refresh). */
  revokeToken(token: string): boolean {
    const h = sha256Hex(token);
    const rec = this.accessTokens.get(h) ?? this.refreshTokens.get(h);
    if (!rec) return false;
    rec.revoked = true;
    return true;
  }

  /** Remove expired records; returns the number removed. */
  cleanupExpired(): number {
    const now = Date.now();
    let removed = 0;
    for (const [k, r] of this.authRequests) {
      if (now > r.expiresAt) { this.authRequests.delete(k); removed++; }
    }
    for (const [k, r] of this.codes) {
      if (now > r.expiresAt) { this.codes.delete(k); removed++; }
    }
    for (const [k, r] of this.accessTokens) {
      if (now > r.expiresAt) { this.accessTokens.delete(k); removed++; }
    }
    for (const [k, r] of this.refreshTokens) {
      if (now > r.expiresAt) { this.refreshTokens.delete(k); removed++; }
    }
    return removed;
  }

  /** Test hook: clear all state. */
  clear(): void {
    this.authRequests.clear();
    this.codes.clear();
    this.accessTokens.clear();
    this.refreshTokens.clear();
    this.clients.clear();
  }
}
