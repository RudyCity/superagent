import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";
import { registerProject } from "../src/core/project/projectRegistry.js";
import { grantProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { MCP_CONNECTION_PROJECT_ID } from "../src/core/project/projectAccessRequestStore.js";

describe("MCP Security Approval is separate from chat agent YOLO", () => {
  let root: string;
  let cfg: string;
  let previousConfig: string | undefined;
  const writer = { mode: "oauth" as const, subject: "mcp-writer",
    scopes: ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"] };

  function makeServer(getIdentity = () => writer, opts: Record<string, any> = {}) {
    return createSuperagentMcpServer({
      workspace: root, toolExposure: "full", authMode: "oauth",
      getIdentity, ...opts,
    });
  }
  async function names(server: ReturnType<typeof makeServer>) {
    const list = (server as any)._requestHandlers.get("tools/list");
    const data = await list({ method: "tools/list", params: {} }, {});
    return data.tools.map((tool: any) => tool.name) as string[];
  }
  async function invoke(server: ReturnType<typeof makeServer>, name: string, args: Record<string, unknown>) {
    const call = (server as any)._requestHandlers.get("tools/call");
    return call({ method: "tools/call", params: { name, arguments: args } }, {});
  }
  function fileArgs(filePath: string) {
    return { projectId: "mcp-workspace", cwd: root,
      files: [{ filePath, content: "approved via MCP", overwrite: true }] };
  }

  beforeEach(() => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    cfg = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-independent-"));
    root = path.join(cfg, "project");
    fs.mkdirSync(root);
    process.env.SUPERAGENT_CONFIG_DIR = cfg;
    setYoloMode(false);
    registerProject({ id: "mcp-workspace", name: "MCP Project", type: "local", root });
  });
  afterEach(() => {
    setYoloMode(false);
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    fs.rmSync(cfg, { recursive: true, force: true });
  });

  it("OAuth write-tool discovery does not depend on chat YOLO", async () => {
    const server = makeServer();
    try {
      expect(await names(server)).toContain("superagent_write_files");
      setYoloMode(true);
      expect(await names(server)).toContain("superagent_write_files");
      setFullYoloMode(true);
      expect(await names(server)).toContain("superagent_write_files");
      setYoloMode(false);
      expect(await names(server)).toContain("superagent_write_files");
    } finally { await server.close(); }
  });

  it("a limited tool allowlist remains a separate, enforced MCP control", async () => {
    const server = makeServer(() => writer, {
      allowedTools: ["superagent_list_projects", "superagent_request_project_access"],
    });
    try {
      expect(await names(server)).not.toContain("superagent_write_files");
      await expect(invoke(server, "superagent_write_files",
        fileArgs(path.join(root, "denied.txt")))).rejects.toThrow(/allowlist/);
    } finally { await server.close(); }
  });

  it("Security Approval project grant permits a scoped write with chat YOLO off", async () => {
    grantProjectAccess(writer, "mcp-workspace", ["read", "write"]);
    const server = makeServer();
    const file = path.join(root, "approved.txt");
    try {
      const result = await invoke(server, "superagent_write_files", fileArgs(file));
      expect(result.isError).not.toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("approved via MCP");
    } finally { await server.close(); }
  });

  it("Full YOLO never authorizes protected model configuration writes over MCP", async () => {
    setFullYoloMode(true);
    grantProjectAccess(writer, "mcp-workspace", ["read", "write"]);
    const server = makeServer();
    const file = path.join(root, "model-config.json");
    try {
      const attempt = await invoke(server, "superagent_write_files", fileArgs(file))
        .catch(error => ({ isError: true, content: [{ text: String(error) }] }));
      expect(attempt.isError).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
    } finally { await server.close(); }
  });

  it("read-only OAuth scope cannot be elevated through Security Approval or chat YOLO", async () => {
    setFullYoloMode(true);
    const reader = { mode: "oauth" as const, subject: "read-only",
      scopes: ["mcp:tools"] };
    grantProjectAccess(reader, "mcp-workspace", ["read", "write"]);
    const server = makeServer(() => reader);
    try {
      expect(await names(server)).not.toContain("superagent_write_files");
      await expect(invoke(server, "superagent_write_files",
        fileArgs(path.join(root, "denied.txt")))).rejects.toThrow(/mcp:tools:write/);
    } finally { await server.close(); }
  });

  it("non-project project administration requires the OAuth admin scope", async () => {
    // Project administration is a connection-level action: write scope is not
    // enough, and no project may be registered without mcp:tools:admin.
    const notAdmin = { ...writer, scopes: ["mcp:tools", "mcp:tools:write"] };
    const serverWithoutAdmin = makeServer(() => notAdmin);
    try {
      await expect(invoke(serverWithoutAdmin, "superagent_register_project", {
        projectId: "denied-by-scope", name: "Rejected administration", type: "local", root,
      })).rejects.toThrow(/mcp:tools:admin/);
    } finally { await serverWithoutAdmin.close(); }
  });

  it("MCP security grants persist when chat YOLO changes without a restart", async () => {
    grantProjectAccess(writer, "mcp-workspace", ["read", "write"]);
    const server = makeServer();
    try {
      setFullYoloMode(true);
      setYoloMode(false);
      const result = await invoke(server, "superagent_write_files",
        fileArgs(path.join(root, "independent.txt")));
      expect(result.isError).not.toBe(true);
    } finally { await server.close(); }
  });
});
