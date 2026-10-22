import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.SUPERAGENT_CONFIG_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Brain MCP OAuth identity scope", () => {
  it("publishes brain definition and respects read-only token permissions", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-oauth-")); roots.push(root);
    process.env.SUPERAGENT_CONFIG_DIR = root;
    let scopes = ["mcp:tools"];
    const server = createSuperagentMcpServer({
      authMode: "oauth", allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "reader", scopes }),
    });
    const handlers = (server as any)._requestHandlers;
    const list = handlers.get(ListToolsRequestSchema.shape.method.value);
    expect((await list({ method: "tools/list", params: {} })).tools.some((t: any) => t.name === "superagent_brain")).toBe(false);
    const call = handlers.get(CallToolRequestSchema.shape.method.value);
    await expect(call({ method: "tools/call", params: { name: "superagent_brain", arguments: { action: "create", sessionId: "one" } } })).rejects.toThrow(/mcp:tools:write/);
    scopes = ["mcp:tools", "mcp:tools:write"];
    expect((await list({ method: "tools/list", params: {} })).tools.some((t: any) => t.name === "superagent_brain")).toBe(true);
    const created = await call({ method: "tools/call", params: { name: "superagent_brain", arguments: { action: "create", sessionId: "one" } } });
    expect(created.isError).not.toBe(true);
    await server.close();
  });
  it("separates OAuth principals through request handlers", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-identity-")); roots.push(root);
    process.env.SUPERAGENT_CONFIG_DIR = root;
    let subject = "alice";
    const server = createSuperagentMcpServer({
      authMode: "oauth", allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject, scopes: ["mcp:tools", "mcp:tools:write"] }),
    });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const invoke = (action: string, other: Record<string, unknown> = {}) => call({
      method: "tools/call", params: { name: "superagent_brain", arguments: { action, sessionId: "sess_one", ...other } },
    });
    expect((await invoke("create")).isError).not.toBe(true);
    expect((await invoke("write", { filePath: "artifacts/report.txt", content: "confidential" })).isError).not.toBe(true);
    subject = "bob";
    expect((await invoke("inspect")).isError).toBe(true);
    expect((await invoke("read", { filePath: "artifacts/report.txt" })).isError).toBe(true);
    await server.close();
  });
});
