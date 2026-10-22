import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { registerProject, removeProject } from "../src/core/project/projectRegistry.js";
import { grantProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";

const roots: string[] = [];
afterEach(() => {
  delete process.env.SUPERAGENT_CONFIG_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Brain MCP OAuth identity scope", () => {
  it("reuses a transport-scoped Brain when no sessionId is provided", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-transport-")); roots.push(root);
    process.env.SUPERAGENT_CONFIG_DIR = root;
    const server = createSuperagentMcpServer({
      authMode: "oauth", allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "session-owner", scopes: ["mcp:tools", "mcp:tools:write"] }),
    });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const invoke = (action: string, extra: Record<string, unknown> = {}) => call({
      method: "tools/call", params: { name: "superagent_brain", arguments: { action, ...extra } },
    });
    const current = JSON.parse((await invoke("current")).content[0].text);
    expect(current.sessionId).toBeTruthy();
    const written = await invoke("write", { filePath: "scratch/note.txt", content: "transport" });
    expect(written.isError).not.toBe(true);
    expect(JSON.parse((await invoke("inspect")).content[0].text).sessionId).toBe(current.sessionId);
    expect(JSON.parse((await invoke("read", { filePath: "scratch/note.txt" })).content[0].text).content).toBe("transport");
    await server.close();
  });
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
    // The default compact gateway advertises discoverable tools, not the full catalog.
    const advertised = (await list({ method: "tools/list", params: {} })).tools;
    expect(advertised.some((t: any) => t.name === "superagent_tool_search")).toBe(true);
    const discovered = await call({ method: "tools/call", params: {
      name: "superagent_tool_search", arguments: { query: "superagent_brain" },
    } });
    expect(JSON.stringify(discovered)).toContain("superagent_brain");
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

  it("publishes only after project write grant, without overwriting existing files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "brain-publish-")); roots.push(root);
    process.env.SUPERAGENT_CONFIG_DIR = root;
    const nestedWorkspace = path.join(root, "anchor", "nested");
    const target = path.join(root, "target");
    fs.mkdirSync(nestedWorkspace, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const projectId = "brain-publish-test";
    registerProject({ id: projectId, type: "local", name: "Publish target", root: target });
    setFullYoloMode(false);
    setYoloMode(false);
    const identity = { mode: "oauth" as const, subject: "publish-user", scopes: ["mcp:tools", "mcp:tools:write"] };
    const server = createSuperagentMcpServer({
      authMode: "oauth", allowDangerous: true, workspace: nestedWorkspace,
      getIdentity: () => identity,
    });
    const call = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    const invoke = (name: string, args: Record<string, unknown>) => call({
      method: "tools/call", params: { name, arguments: args },
    });
    expect((await invoke("superagent_brain", { action: "create", sessionId: "publish_session" })).isError).not.toBe(true);
    expect((await invoke("superagent_brain", {
      action: "write", sessionId: "publish_session",
      filePath: "artifacts/report.md", content: "# Tested",
    })).isError).not.toBe(true);
    const publishArgs = {
      projectId, sessionId: "publish_session", filePath: "artifacts/report.md",
      destinationPath: "reports/report.md",
    };
    const blocked = await invoke("superagent_brain_publish", { ...publishArgs, action: "prepare" });
    expect(blocked.isError).toBe(true);
    expect(fs.existsSync(path.join(target, "reports", "report.md"))).toBe(false);
    grantProjectAccess(identity, projectId, ["write"]);
    const prepared = await invoke("superagent_brain_publish", { ...publishArgs, action: "prepare" });
    expect(prepared.isError).not.toBe(true);
    const challenge = JSON.parse(prepared.content[0].text).challenge;
    expect(typeof challenge).toBe("string");
    expect(fs.existsSync(path.join(target, "reports", "report.md"))).toBe(false);
    const confirmed = await invoke("superagent_brain_publish", {
      projectId, sessionId: "publish_session", action: "confirm", challenge,
    });
    expect(confirmed.isError).not.toBe(true);
    expect(fs.readFileSync(path.join(target, "reports", "report.md"), "utf8")).toBe("# Tested");
    expect((await invoke("superagent_brain_publish", { projectId, sessionId: "publish_session", action: "confirm", challenge })).isError).toBe(true);
    expect((await invoke("superagent_brain_publish", { ...publishArgs, action: "prepare" })).isError).toBe(true);
    expect((await invoke("superagent_brain_publish", { ...publishArgs, action: "prepare", destinationPath: "../outside.md" })).isError).toBe(true);
    await server.close();
    removeProject(projectId);
    setYoloMode(false);
  });
});
