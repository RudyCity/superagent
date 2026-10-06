/**
 * mcpOAuthRoutes.test.ts - tests for OAuth discovery, authorization, and token routes.
 */
import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
import { McpOAuthStore, randomToken } from "../src/core/mcp/mcpOAuthStore.js";
import {
  handleOAuthRoute,
  generateBootstrapCode,
  type McpOAuthRoutesConfig,
} from "../src/core/mcp/mcpOAuthRoutes.js";
import { sha256Hex } from "../src/core/mcp/mcpAuth.js";

const BASE = "https://example.trycloudflare.com";
const CLIENT_ID = "chatgpt-test";
const REDIRECT_URI = "https://chatgpt.example/oauth/callback";

function makeConfig(store: McpOAuthStore, bootstrapCode: string): McpOAuthRoutesConfig {
  return {
    store,
    publicBaseUrl: BASE,
    bootstrapCodeHash: sha256Hex(bootstrapCode),
  };
}

function getReq(path: string): http.IncomingMessage {
  return { method: "GET", url: path, headers: {} } as unknown as http.IncomingMessage;
}

function postReq(path: string, body: string, contentType = "application/x-www-form-urlencoded"): http.IncomingMessage {
  const stream = new Readable({
    read() {
      this.push(body);
      this.push(null);
    },
  }) as unknown as http.IncomingMessage;
  stream.method = "POST";
  stream.url = path;
  stream.headers = { "content-type": contentType };
  return stream;
}

function pkcePair() {
  const verifier = randomToken(32);
  const challenge = crypto.createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

/** Run the full authorize -> approve -> token flow; returns tokens. */
async function fullFlow(store: McpOAuthStore, config: McpOAuthRoutesConfig, bootstrapCode: string) {
  const { verifier, challenge } = pkcePair();
  const authUrl =
    `/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=st123&scope=mcp%3Atools`;
  const page = await handleOAuthRoute(getReq(authUrl), config);
  expect(page.handled).toBe(true);
  expect(page.statusCode).toBe(200);
  // extract request_id from the consent form
  const m = /name="request_id" value="([^"]+)"/.exec(page.body);
  expect(m).not.toBeNull();
  const approve = await handleOAuthRoute(
    postReq("/oauth/authorize", `request_id=${m![1]}&bootstrap_code=${bootstrapCode}&decision=approve`),
    config
  );
  expect(approve.statusCode).toBe(302);
  const code = new URL(approve.headers["Location"]).searchParams.get("code");
  expect(code).toBeTruthy();
  const tokenRes = await handleOAuthRoute(
    postReq(
      "/oauth/token",
      `grant_type=authorization_code&code=${code}&client_id=${CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_verifier=${verifier}`
    ),
    config
  );
  expect(tokenRes.statusCode).toBe(200);
  const tokens = JSON.parse(tokenRes.body);
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.refresh_token).toBeTruthy();
  return { tokens, verifier, code: code as string };
}

describe("discovery endpoints", () => {
  let store: McpOAuthStore;
  let config: McpOAuthRoutesConfig;
  beforeEach(() => {
    store = new McpOAuthStore();
    config = makeConfig(store, "bootstrap");
  });

  it("serves protected-resource metadata without a token", async () => {
    const r = await handleOAuthRoute(getReq("/.well-known/oauth-protected-resource"), config);
    expect(r.handled).toBe(true);
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.resource).toBe(`${BASE}/mcp`);
    expect(body.authorization_servers).toContain(BASE);
  });

  it("serves authorization-server metadata without a token", async () => {
    const r = await handleOAuthRoute(getReq("/.well-known/oauth-authorization-server"), config);
    expect(r.handled).toBe(true);
    const body = JSON.parse(r.body);
    expect(body.issuer).toBe(BASE);
    expect(body.authorization_endpoint).toBe(`${BASE}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${BASE}/oauth/token`);
    expect(body.code_challenge_methods_supported).toContain("S256");
  });

  it("does not handle unrelated paths", async () => {
    const r = await handleOAuthRoute(getReq("/mcp"), config);
    expect(r.handled).toBe(false);
  });
});

describe("authorization flow", () => {
  let store: McpOAuthStore;
  let config: McpOAuthRoutesConfig;
  const bootstrap = "bootstrap-secret";
  beforeEach(() => {
    store = new McpOAuthStore();
    config = makeConfig(store, bootstrap);
  });

  it("completes PKCE end-to-end", async () => {
    const { tokens } = await fullFlow(store, config, bootstrap);
    expect(store.verifyAccessToken(tokens.access_token)).not.toBeNull();
  });

  it("rejects wrong bootstrap code on approval", async () => {
    const { challenge } = pkcePair();
    const page = await handleOAuthRoute(
      getReq(`/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`),
      config
    );
    const m = /name="request_id" value="([^"]+)"/.exec(page.body);
    const deny = await handleOAuthRoute(
      postReq("/oauth/authorize", `request_id=${m![1]}&bootstrap_code=wrong&decision=approve`),
      config
    );
    expect(deny.statusCode).toBe(403);
  });

  it("rejects authorization-code replay at the token endpoint", async () => {
    const { verifier, code } = await fullFlow(store, config, bootstrap);
    const replay = await handleOAuthRoute(
      postReq(
        "/oauth/token",
        `grant_type=authorization_code&code=${code}&client_id=${CLIENT_ID}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_verifier=${verifier}`
      ),
      config
    );
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.body).error).toBe("invalid_grant");
  });

  it("rejects PKCE mismatch at the token endpoint", async () => {
    const { challenge } = pkcePair();
    const page = await handleOAuthRoute(
      getReq(`/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`),
      config
    );
    const m = /name="request_id" value="([^"]+)"/.exec(page.body);
    const approve = await handleOAuthRoute(
      postReq("/oauth/authorize", `request_id=${m![1]}&bootstrap_code=${bootstrap}&decision=approve`),
      config
    );
    const code = new URL(approve.headers["Location"]).searchParams.get("code");
    const bad = await handleOAuthRoute(
      postReq(
        "/oauth/token",
        `grant_type=authorization_code&code=${code}&client_id=${CLIENT_ID}` +
          `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_verifier=nope`
      ),
      config
    );
    expect(bad.statusCode).toBe(400);
  });

  it("rejects malformed redirect_uri", async () => {
    const { challenge } = pkcePair();
    const r = await handleOAuthRoute(
      getReq(`/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent("javascript:alert(1)")}&code_challenge=${challenge}&code_challenge_method=S256`),
      config
    );
    expect(r.statusCode).toBe(400);
  });

  it("rejects expired authorization requests", async () => {
    const { challenge } = pkcePair();
    const page = await handleOAuthRoute(
      getReq(`/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256`),
      config
    );
    const m = /name="request_id" value="([^"]+)"/.exec(page.body);
    for (const r of (store as any).authRequests.values()) r.expiresAt = Date.now() - 1;
    const expired = await handleOAuthRoute(
      postReq("/oauth/authorize", `request_id=${m![1]}&bootstrap_code=${bootstrap}&decision=approve`),
      config
    );
    expect(expired.statusCode).toBe(400);
  });

  it("rotates refresh tokens", async () => {
    const { tokens } = await fullFlow(store, config, bootstrap);
    const r = await handleOAuthRoute(
      postReq("/oauth/token", `grant_type=refresh_token&refresh_token=${tokens.refresh_token}`),
      config
    );
    expect(r.statusCode).toBe(200);
    const rotated = JSON.parse(r.body);
    expect(rotated.access_token).not.toBe(tokens.access_token);
  });
});

describe("generateBootstrapCode", () => {
  it("returns a code whose hash verifies", () => {
    const { code, codeHash } = generateBootstrapCode();
    expect(code.length).toBeGreaterThan(20);
    expect(codeHash).toBe(sha256Hex(code));
  });
});
