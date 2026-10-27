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
  classifyAuthHeader,
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
  it("accepts a lowercase scheme (RFC 6750 schemes are case-insensitive)", () => {
    expect(extractBearerToken(reqWithAuth("bearer tok123"))).toBe("tok123");
    expect(extractBearerToken(reqWithAuth("BEARER tok123"))).toBe("tok123");
  });
  it("tolerates extra whitespace and tabs", () => {
    expect(extractBearerToken(reqWithAuth("Bearer    tok123"))).toBe("tok123");
    expect(extractBearerToken(reqWithAuth("  bearer\ttok123  "))).toBe("tok123");
  });
  it("never returns a valid token for concatenated duplicate headers", () => {
    const extracted = extractBearerToken(reqWithAuth("Bearer a, Bearer b"));
    expect(verifyStaticBearer(extracted, "a")).toBe(false);
    expect(verifyStaticBearer(extracted, "b")).toBe(false);
  });
});

describe("classifyAuthHeader", () => {
  it("reports an absent header", () => {
    expect(classifyAuthHeader(reqWithAuth(undefined))).toBe("absent");
    expect(classifyAuthHeader(reqWithAuth("   "))).toBe("absent");
  });
  it("reports the bearer scheme case-insensitively", () => {
    expect(classifyAuthHeader(reqWithAuth("Bearer abc"))).toBe("bearer");
    expect(classifyAuthHeader(reqWithAuth("bearer abc"))).toBe("bearer");
  });
  it("reports other schemes", () => {
    expect(classifyAuthHeader(reqWithAuth("Basic abc"))).toBe("other");
    expect(classifyAuthHeader(reqWithAuth("bearertoken"))).toBe("other");
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
