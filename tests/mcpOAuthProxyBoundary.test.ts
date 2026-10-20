import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startMcpHttpServer, type McpHttpServerHandle } from "../src/core/mcp/mcpHttpTransport.js";
import { generateBootstrapCode } from "../src/core/mcp/mcpOAuthRoutes.js";

const PUBLIC_ISSUER = "https://issuer.example.test";
const BAD_FORWARDED = "attacker.example.invalid";

describe("Hermes Phase 5 reverse-proxy OAuth metadata boundary", () => {
  let server: McpHttpServerHandle;
  let logDir: string;
  const url = (resource: string) => "http://127.0.0.1:" + server.port + resource;
  beforeAll(async () => {
    logDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-public-issuer-proxy-"));
    const approval = generateBootstrapCode();
    server = await startMcpHttpServer({
      port: 0, authMode: "oauth", allowDangerous: false,
      oauth: { publicBaseUrl: PUBLIC_ISSUER, bootstrapCodeHash: approval.codeHash },
      publicBaseUrl: PUBLIC_ISSUER,
      auditLogPath: path.join(logDir, "audit.jsonl"),
    });
  });
  afterAll(async () => {
    await server?.close();
    if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
  });
  const forwarded = {
    Host: "issuer.example.test",
    "X-Forwarded-Host": BAD_FORWARDED,
    "X-Forwarded-Proto": "http",
    "X-Forwarded-Port": "80",
  };
  it("publishes the configured public issuer and ignores injected forwarded origin metadata", async () => {
    const resource = await fetch(url("/.well-known/oauth-protected-resource/mcp"), {
      headers: forwarded,
    });
    expect(resource.status).toBe(200);
    const resourceData = await resource.json() as Record<string, unknown>;
    expect(resourceData.resource).toBe(PUBLIC_ISSUER + "/mcp");
    expect(resourceData.authorization_servers).toEqual([PUBLIC_ISSUER]);
    const authorizationServer = await fetch(url("/.well-known/oauth-authorization-server"), {
      headers: forwarded,
    });
    expect(authorizationServer.status).toBe(200);
    const meta = await authorizationServer.json() as Record<string, unknown>;
    expect(meta.issuer).toBe(PUBLIC_ISSUER);
    expect(meta.authorization_endpoint).toBe(PUBLIC_ISSUER + "/oauth/authorize");
    expect(meta.token_endpoint).toBe(PUBLIC_ISSUER + "/oauth/token");
    expect(JSON.stringify(meta)).not.toContain(BAD_FORWARDED);
    expect(JSON.stringify(resourceData)).not.toContain(BAD_FORWARDED);
  });
  it("rejects an unknown Host even if X-Forwarded-Host claims the trusted issuer", async () => {
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(url("/.well-known/oauth-authorization-server"), {
        method: "GET",
        headers: { Host: BAD_FORWARDED, "X-Forwarded-Host": "issuer.example.test" },
      }, res => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", chunk => body += chunk);
        res.on("end", () => resolve({ status: res.statusCode || 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
    expect(result.status).toBe(400);
    expect(result.body).not.toContain(PUBLIC_ISSUER);
  });
  it("returns a public OAuth bearer challenge for unauthenticated MCP, without allocating sessions", async () => {
    const unauthenticated = await fetch(url("/mcp"), {
      method: "HEAD", headers: forwarded,
    });
    expect(unauthenticated.status).toBe(401);
    const challenge = unauthenticated.headers.get("www-authenticate") || "";
    expect(challenge).toContain(PUBLIC_ISSUER + "/.well-known/oauth-protected-resource");
    expect(challenge).not.toContain("127.0.0.1");
    expect(challenge).not.toContain(BAD_FORWARDED);
    expect(unauthenticated.headers.get("mcp-session-id")).toBeNull();
    expect(await unauthenticated.text()).toBe("");
  });
});
