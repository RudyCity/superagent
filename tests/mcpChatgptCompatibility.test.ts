/**
 * mcpChatgptCompatibility.test.ts - ChatGPT-facing tool metadata and gating.
 *
 * Verifies: safe tools advertise read-only behavior, dangerous tools are
 * hidden by default, per-tool security metadata matches the auth mode, and
 * auth-protected tools do not execute without a valid identity.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { createSuperagentMcpServer, getToolAnnotations, getToolSecuritySchemes } from "../src/core/mcp/superagentMcpServer.js";
import {
  startMcpHttpServer,
  generateMcpBearerToken,
  MCP_HTTP_PATH,
  type McpHttpServerHandle,
} from "../src/core/mcp/mcpHttpTransport.js";

async function listTools(server: ReturnType<typeof createSuperagentMcpServer>): Promise<any[]> {
  const handler = (server as any)._requestHandlers.get("tools/list");
  const res: any = await handler({ method: "tools/list", params: {} });
  return res.tools || [];
}

describe("tool annotations", () => {
  it("safe tools advertise read-only behavior", async () => {
    const server = createSuperagentMcpServer();
    const tools = await listTools(server);
    const readFile = tools.find((t) => t.name === "superagent_read_file");
    expect(readFile).toBeDefined();
    expect(readFile.annotations?.readOnlyHint).toBe(true);
    expect(readFile.annotations?.destructiveHint).toBe(false);
  });

  it("dangerous tools advertise destructive behavior", () => {
    const ann = getToolAnnotations("superagent_exec_command");
    expect(ann?.destructiveHint).toBe(true);
    expect(ann?.readOnlyHint).toBe(false);
  });

  it("dangerous tools are hidden by default allowlist", async () => {
    const { getDefaultSafeTools } = await import("../src/core/mcp/mcpHttpTransport.js");
    const server = createSuperagentMcpServer({ allowedTools: getDefaultSafeTools() });
    const tools = await listTools(server);
    const names = tools.map((t) => t.name);
    expect(names).not.toContain("superagent_exec_command");
    expect(names).not.toContain("superagent_write_file");
    expect(names).toContain("superagent_read_file");
  });
});

describe("per-tool security metadata", () => {
  it("static-bearer mode advertises bearer scheme", () => {
    const schemes = getToolSecuritySchemes("superagent_read_file", "static-bearer");
    expect(schemes[0].type).toBe("http");
    expect(schemes[0].scheme).toBe("bearer");
  });

  it("oauth mode advertises oauth2 scopes (read vs write)", () => {
    const safe = getToolSecuritySchemes("superagent_read_file", "oauth");
    expect(safe[0].type).toBe("oauth2");
    expect(safe[0].scopes).toContain("mcp:tools");
    expect(safe[0].scopes).not.toContain("mcp:tools:write");
    const dangerous = getToolSecuritySchemes("superagent_exec_command", "oauth");
    expect(dangerous[0].scopes).toContain("mcp:tools:write");
  });

  it("tools/list includes annotations and securitySchemes via _meta", async () => {
    const server = createSuperagentMcpServer({ authMode: "oauth" });
    const tools = await listTools(server);
    const readFile = tools.find((t) => t.name === "superagent_read_file");
    expect(readFile.annotations?.readOnlyHint).toBe(true);
    expect(readFile._meta?.securitySchemes?.[0]?.type).toBe("oauth2");
  });
});

describe("auth-protected tools do not execute without identity", () => {
  let handle: McpHttpServerHandle;
  let token: string;

  beforeAll(async () => {
    token = generateMcpBearerToken();
    handle = await startMcpHttpServer({ port: 0, bearerToken: token, allowDangerous: false });
  }, 30000);

  afterAll(async () => {
    await handle.close();
  });

  it("rejects tool calls without a token", async () => {
    const res = await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "superagent_read_file", arguments: {} } }),
    });
    expect(res.status).toBe(401);
    await res.text();
  });

  it("denied dangerous tools return actionable errors", async () => {
    // initialize first to get a session
    const init = await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
    });
    const sid = init.headers.get("mcp-session-id");
    await init.text();
    expect(sid).toBeTruthy();
    const call = await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "mcp-session-id": sid as string,
      },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "superagent_exec_command", arguments: { command: "echo hi" } },
      }),
    });
    const text = await call.text();
    expect(text).toContain("--allow-dangerous");
    await fetch(`http://127.0.0.1:${handle.port}${MCP_HTTP_PATH}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "mcp-session-id": sid as string },
    });
  });
});
