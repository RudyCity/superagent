/**
 * mcpOAuthStore.test.ts - tests for the in-memory OAuth 2.1 state store.
 */
import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import {
  McpOAuthStore,
  verifyPkceS256,
  randomToken,
} from "../src/core/mcp/mcpOAuthStore.js";

const CLIENT_ID = "test-client";
const REDIRECT_URI = "https://client.example/callback";

function pkcePair() {
  const verifier = randomToken(32);
  const challenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

function approvedCode(store: McpOAuthStore, scope = ["mcp:tools"]) {
  store.registerClient(CLIENT_ID, [REDIRECT_URI]);
  const { verifier, challenge } = pkcePair();
  const req = store.createAuthorizationRequest({
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    scope,
    state: "xyz",
  });
  const approved = store.approveAuthorizationRequest(req.requestId, true);
  if (!approved.ok) throw new Error("approval failed");
  return { code: approved.code, verifier };
}

describe("verifyPkceS256", () => {
  it("accepts a matching verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkceS256(verifier, challenge)).toBe(true);
  });
  it("rejects a mismatched verifier", () => {
    const { challenge } = pkcePair();
    expect(verifyPkceS256("wrong-verifier", challenge)).toBe(false);
  });
  it("rejects empty inputs", () => {
    expect(verifyPkceS256("", "abc")).toBe(false);
    expect(verifyPkceS256("abc", "")).toBe(false);
  });
});

describe("authorization request validation", () => {
  let store: McpOAuthStore;
  beforeEach(() => { store = new McpOAuthStore(); });

  it("rejects unknown client_id", () => {
    expect(() =>
      store.createAuthorizationRequest({
        clientId: "nope", redirectUri: REDIRECT_URI,
        codeChallenge: "c", codeChallengeMethod: "S256", scope: [], state: "s",
      })
    ).toThrow("unknown client_id");
  });

  it("rejects unregistered redirect_uri", () => {
    store.registerClient(CLIENT_ID, [REDIRECT_URI]);
    expect(() =>
      store.createAuthorizationRequest({
        clientId: CLIENT_ID, redirectUri: "https://evil.example/cb",
        codeChallenge: "c", codeChallengeMethod: "S256", scope: [], state: "s",
      })
    ).toThrow("redirect_uri");
  });

  it("rejects non-S256 PKCE", () => {
    store.registerClient(CLIENT_ID, [REDIRECT_URI]);
    expect(() =>
      store.createAuthorizationRequest({
        clientId: CLIENT_ID, redirectUri: REDIRECT_URI,
        codeChallenge: "c", codeChallengeMethod: "plain", scope: [], state: "s",
      })
    ).toThrow("S256");
  });
});

describe("code exchange", () => {
  let store: McpOAuthStore;
  beforeEach(() => { store = new McpOAuthStore(); });

  it("exchanges a valid code for tokens", () => {
    const { code, verifier } = approvedCode(store);
    const r = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.accessToken.length).toBeGreaterThan(20);
      expect(r.refreshToken.length).toBeGreaterThan(20);
      expect(r.scope).toEqual(["mcp:tools"]);
      expect(store.verifyAccessToken(r.accessToken)).not.toBeNull();
    }
  });

  it("rejects code replay (one-time use)", () => {
    const { code, verifier } = approvedCode(store);
    const first = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    expect(first.ok).toBe(true);
    const second = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    expect(second.ok).toBe(false);
  });

  it("rejects PKCE mismatch", () => {
    const { code } = approvedCode(store);
    const r = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: "wrong" });
    expect(r.ok).toBe(false);
  });

  it("rejects client_id mismatch", () => {
    const { code, verifier } = approvedCode(store);
    const r = store.exchangeCode({ code, clientId: "other", redirectUri: REDIRECT_URI, codeVerifier: verifier });
    expect(r.ok).toBe(false);
  });

  it("rejects redirect_uri mismatch", () => {
    const { code, verifier } = approvedCode(store);
    const r = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: "https://evil.example/cb", codeVerifier: verifier });
    expect(r.ok).toBe(false);
  });

  it("rejects expired codes", () => {
    const { code, verifier } = approvedCode(store);
    // force expiry by manipulating the stored record
    for (const r of (store as any).codes.values()) r.expiresAt = Date.now() - 1;
    const r = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    expect(r.ok).toBe(false);
  });
});

describe("token lifecycle", () => {
  let store: McpOAuthStore;
  beforeEach(() => { store = new McpOAuthStore(); });

  it("rejects expired access tokens", () => {
    const { code, verifier } = approvedCode(store);
    const r = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    if (!r.ok) throw new Error("exchange failed");
    for (const t of (store as any).accessTokens.values()) t.expiresAt = Date.now() - 1;
    expect(store.verifyAccessToken(r.accessToken)).toBeNull();
  });

  it("rotates refresh tokens and rejects reuse", () => {
    const { code, verifier } = approvedCode(store);
    const r = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    if (!r.ok) throw new Error("exchange failed");
    const rot = store.rotateRefreshToken(r.refreshToken);
    expect(rot.ok).toBe(true);
    const reuse = store.rotateRefreshToken(r.refreshToken);
    expect(reuse.ok).toBe(false);
  });

  it("revokes tokens", () => {
    const { code, verifier } = approvedCode(store);
    const r = store.exchangeCode({ code, clientId: CLIENT_ID, redirectUri: REDIRECT_URI, codeVerifier: verifier });
    if (!r.ok) throw new Error("exchange failed");
    expect(store.revokeToken(r.accessToken)).toBe(true);
    expect(store.verifyAccessToken(r.accessToken)).toBeNull();
  });
});
