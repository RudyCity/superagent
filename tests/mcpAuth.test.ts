/**
 * mcpAuth.test.ts - tests for the MCP authentication abstraction.
 */
import { describe, it, expect } from "vitest";
import type http from "node:http";
import {
  constantTimeEqual,
  verifyStaticBearer,
  extractBearerToken,
  buildBearerChallenge,
  authorizeStaticBearer,
  sha256Hex,
} from "../src/core/mcp/mcpAuth.js";

function reqWithAuth(header: string | undefined): http.IncomingMessage {
  return { headers: header === undefined ? {} : { authorization: header } } as http.IncomingMessage;
}

describe("constantTimeEqual", () => {
  it("accepts equal strings", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
  });
  it("rejects different strings of equal length", () => {
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
  });
  it("rejects different-length strings", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("verifyStaticBearer", () => {
  const expected = "a".repeat(64);
  it("accepts the correct token", () => {
    expect(verifyStaticBearer(expected, expected)).toBe(true);
  });
  it("rejects a wrong token", () => {
    expect(verifyStaticBearer("b".repeat(64), expected)).toBe(false);
  });
  it("rejects null/empty provided", () => {
    expect(verifyStaticBearer(null, expected)).toBe(false);
    expect(verifyStaticBearer("", expected)).toBe(false);
  });
  it("rejects empty expected", () => {
    expect(verifyStaticBearer(expected, "")).toBe(false);
  });
});

describe("extractBearerToken", () => {
  it("extracts the token", () => {
    expect(extractBearerToken(reqWithAuth("Bearer tok123"))).toBe("tok123");
  });
  it("returns null when missing", () => {
    expect(extractBearerToken(reqWithAuth(undefined))).toBeNull();
  });
  it("returns null for non-bearer schemes", () => {
    expect(extractBearerToken(reqWithAuth("Basic abc"))).toBeNull();
  });
});

describe("buildBearerChallenge", () => {
  it("returns a standards-shaped 401 challenge with resource metadata URL", () => {
    const meta = "https://example.trycloudflare.com/.well-known/oauth-protected-resource";
    const c = buildBearerChallenge(meta);
    expect(c.statusCode).toBe(401);
    expect(c.headers["WWW-Authenticate"]).toContain("Bearer");
    expect(c.headers["WWW-Authenticate"]).toContain(`resource_metadata="${meta}"`);
    expect(c.headers["WWW-Authenticate"]).toContain('error="invalid_token"');
  });
});

describe("authorizeStaticBearer", () => {
  const token = "c".repeat(64);
  const meta = "https://example.trycloudflare.com/.well-known/oauth-protected-resource";
  it("authorizes a valid token and returns a typed identity", () => {
    const r = authorizeStaticBearer(reqWithAuth(`Bearer ${token}`), token, meta);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity.mode).toBe("static-bearer");
      expect(r.identity.subject).toBe("bearer");
      expect(r.identity.credentialHash).toBe(sha256Hex(token));
      expect(r.identity.credentialHash).not.toContain(token);
    }
  });
  it("challenges an invalid token", () => {
    const r = authorizeStaticBearer(reqWithAuth("Bearer wrong"), token, meta);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.challenge.statusCode).toBe(401);
      expect(r.challenge.headers["WWW-Authenticate"]).toContain(meta);
    }
  });
  it("challenges a missing header", () => {
    const r = authorizeStaticBearer(reqWithAuth(undefined), token, meta);
    expect(r.ok).toBe(false);
  });
});
