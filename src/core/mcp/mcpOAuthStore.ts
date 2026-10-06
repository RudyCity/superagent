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
}

export interface TokenRecord {
  tokenHash: string;
  clientId: string;
  scope: string[];
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface RegisteredClient {
  clientId: string;
  redirectUris: string[];
  createdAt: number;
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
};

export type ExchangeParams = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
};

export class McpOAuthStore {
  private authRequests = new Map<string, PendingAuthorizationRequest>();
  private codes = new Map<string, AuthorizationCodeRecord>();
  private accessTokens = new Map<string, TokenRecord>();
  private refreshTokens = new Map<string, TokenRecord>();
  private clients = new Map<string, RegisteredClient>();

  /** Register (or update) a client. Registration is closed by default; the
   *  server calls this for the documented client metadata flow. */
  registerClient(clientId: string, redirectUris: string[]): RegisteredClient {
    if (!clientId || redirectUris.length === 0) {
      throw new Error("clientId and at least one redirectUri are required");
    }
    const client: RegisteredClient = { clientId, redirectUris, createdAt: Date.now() };
    this.clients.set(clientId, client);
    return client;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /** Create a pending authorization request after validating client + redirect URI. */
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
    const now = Date.now();
    const req: PendingAuthorizationRequest = {
      requestId: randomToken(16),
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: "S256",
      scope: params.scope,
      state: params.state,
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
      createdAt: now,
      expiresAt: now + AUTH_CODE_TTL_MS,
      used: false,
    });
    this.authRequests.delete(requestId);
    return { ok: true, code };
  }

  /**
   * Exchange an authorization code for tokens. One-time use: replay is rejected.
   * Validates client_id, redirect_uri, and PKCE code_verifier.
   */
  exchangeCode(
    params: ExchangeParams
  ): { ok: true; accessToken: string; refreshToken: string; scope: string[] } | { ok: false; error: string } {
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
    rec.used = true;
    const now = Date.now();
    const accessToken = randomToken(32);
    const refreshToken = randomToken(32);
    this.accessTokens.set(sha256Hex(accessToken), {
      tokenHash: sha256Hex(accessToken),
      clientId: rec.clientId,
      scope: rec.scope,
      createdAt: now,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      revoked: false,
    });
    this.refreshTokens.set(sha256Hex(refreshToken), {
      tokenHash: sha256Hex(refreshToken),
      clientId: rec.clientId,
      scope: rec.scope,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      revoked: false,
    });
    return { ok: true, accessToken, refreshToken, scope: rec.scope };
  }

  /** Verify an access token; returns the record or null. */
  verifyAccessToken(token: string): TokenRecord | null {
    if (!token) return null;
    const rec = this.accessTokens.get(sha256Hex(token));
    if (!rec || rec.revoked || Date.now() > rec.expiresAt) return null;
    return rec;
  }

  /**
   * Rotate a refresh token: the old one is revoked and a fresh pair is issued.
   * Reuse of a rotated token is rejected.
   */
  rotateRefreshToken(
    refreshToken: string
  ): { ok: true; accessToken: string; refreshToken: string; scope: string[] } | { ok: false; error: string } {
    if (!refreshToken) return { ok: false, error: "refresh_token required" };
    const rec = this.refreshTokens.get(sha256Hex(refreshToken));
    if (!rec) return { ok: false, error: "invalid refresh token" };
    if (rec.revoked) return { ok: false, error: "refresh token already rotated" };
    if (Date.now() > rec.expiresAt) return { ok: false, error: "refresh token expired" };
    rec.revoked = true;
    const now = Date.now();
    const accessToken = randomToken(32);
    const newRefreshToken = randomToken(32);
    this.accessTokens.set(sha256Hex(accessToken), {
      tokenHash: sha256Hex(accessToken),
      clientId: rec.clientId,
      scope: rec.scope,
      createdAt: now,
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
      revoked: false,
    });
    this.refreshTokens.set(sha256Hex(newRefreshToken), {
      tokenHash: sha256Hex(newRefreshToken),
      clientId: rec.clientId,
      scope: rec.scope,
      createdAt: now,
      expiresAt: now + REFRESH_TOKEN_TTL_MS,
      revoked: false,
    });
    return { ok: true, accessToken, refreshToken: newRefreshToken, scope: rec.scope };
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
