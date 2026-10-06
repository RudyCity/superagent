/**
 * mcpSecurity.test.ts - defense-in-depth request validation for the MCP HTTP server.
 *
 * Covers: Host validation, Origin validation, oversized bodies, unsupported
 * methods, wrong paths, and unauthorized requests. Validation runs before auth
 * and before any session is created.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import {
  startMcpHttpServer,
  generateMcpBearerToken,
  isHostAllowed,
  isOriginAllowed,
  MCP_HTTP_PATH,
  type McpHttpServerHandle,
} from "../src/core/mcp/mcpHttpTransport.js";

describe("isHostAllowed", () => {
  it("allows loopback", () => {
    expect(isHostAllowed("127.0.0.1:9227", undefined, undefined)).toBe(true);
    expect(isHostAllowed("localhost:9227", undefined, undefined)).toBe(true);
  });
  it("allows the public tunnel hostname", () => {
    expect(isHostAllowed("abc.trycloudflare.com", "abc.trycloudflare.com", undefined)).toBe(true);
  });
  it("rejects unexpected hosts", () => {
    expect(isHostAllowed("evil.com", "abc.trycloudflare.com", undefined)).toBe(false);
    expect(isHostAllowed(undefined, "abc.trycloudflare.com", undefined)).toBe(false);
  });
  it("honors the explicit allowlist", () => {
    expect(isHostAllowed("internal.corp:8080", undefined, ["internal.corp:8080"])).toBe(true);
  });
});

describe("isOriginAllowed", () => {
  it("allows missing origin when permitted", () => {
    expect(isOriginAllowed(undefined, ["https://a.com"], true)).toBe(true);
    expect(isOriginAllowed(undefined, ["https://a.com"], false)).toBe(false);
  });
  it("validates present origin against the allowlist", () => {
    expect(isOriginAllowed("https://a.com", ["https://a.com"], true)).toBe(true);
    expect(isOriginAllowed("https://evil.com", ["https://a.com"], true)).toBe(false);
  });
  it("skips validation when no allowlist is configured", () => {
    expect(isOriginAllowed("https://anything.com", undefined, true)).toBe(true);
  });
});

describe("mcpSecurity http", () => {
  let handle: McpHttpServerHandle;
  let token: string;

  const rawRequest = (
    path: string,
    method: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: handle.port,
          path,
          method,
          headers: { ...headers, "Content-Length": body ? Buffer.byteLength(body) : 0 },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") })
          );
        }
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });

  const authHeaders = (extra: Record<string, string> = {}) => ({
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extra,
  });

  beforeAll(async () => {
    token = generateMcpBearerToken();
    handle = await startMcpHttpServer({
      port: 0,
      bearerToken: token,
      allowDangerous: false,
      publicBaseUrl: "https://abc.trycloudflare.com",
      hostOriginPolicy: { allowedOrigins: ["https://chatgpt.com"] },
    });
  }, 30000);

  afterAll(async () => {
    await handle.close();
  });

  it("rejects an unexpected Host header before auth", async () => {
    const r = await rawRequest(MCP_HTTP_PATH, "POST", { ...authHeaders(), Host: "evil.com" }, "{}");
    expect(r.status).toBe(400);
    expect(r.text).toContain("invalid host");
  });

  it("accepts the public tunnel Host", async () => {
    const init = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    });
    const r = await rawRequest(MCP_HTTP_PATH, "POST", { ...authHeaders(), Host: "abc.trycloudflare.com" }, init);
    // A valid initialize must get past Host validation (200), not a host rejection.
    expect(r.status).toBe(200);
    expect(r.text).not.toContain("invalid host");
  });

  it("rejects a disallowed Origin before auth", async () => {
    const r = await rawRequest(
      MCP_HTTP_PATH,
      "POST",
      { ...authHeaders(), Origin: "https://evil.com" },
      "{}"
    );
    expect(r.status).toBe(403);
    expect(r.text).toContain("origin not allowed");
  });

  it("accepts an allowlisted Origin", async () => {
    const r = await rawRequest(
      MCP_HTTP_PATH,
      "POST",
      { ...authHeaders(), Origin: "https://chatgpt.com" },
      "{}"
    );
    expect(r.status).not.toBe(403);
  });

  it("allows requests without Origin (server-to-server)", async () => {
    const r = await rawRequest(MCP_HTTP_PATH, "POST", authHeaders(), "{}");
    expect(r.status).not.toBe(403);
  });

  it("rejects oversized bodies with 413", async () => {
    const big = "x".repeat(17 * 1024 * 1024);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { data: big } });
    const r = await rawRequest(MCP_HTTP_PATH, "POST", authHeaders(), body);
    expect(r.status).toBe(413);
  });

  it("rejects unsupported methods with 405", async () => {
    const r = await rawRequest(MCP_HTTP_PATH, "PUT", authHeaders(), "{}");
    expect(r.status).toBe(405);
  });

  it("rejects wrong paths with 404", async () => {
    const r = await rawRequest("/nope", "GET", authHeaders());
    expect(r.status).toBe(404);
  });

  it("returns WWW-Authenticate challenge for unauthorized requests", async () => {
    const r = await rawRequest(MCP_HTTP_PATH, "POST", { "Content-Type": "application/json" }, "{}");
    expect(r.status).toBe(401);
    const www = r.headers["www-authenticate"] || "";
    expect(www).toContain("Bearer");
    expect(www).toContain("oauth-protected-resource");
  });
});
