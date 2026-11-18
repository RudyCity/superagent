import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { setFullYoloMode, setYoloMode, isPathWithinMcpScope, isToolCallWithinMcpScope } from "../src/core/permissions.js";
import { registerProject } from "../src/core/project/projectRegistry.js";
import { grantProjectAccess, revokeProjectAccess, hasProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { MCP_CONNECTION_PROJECT_ID, listProjectAccessRequests } from "../src/core/project/projectAccessRequestStore.js";

describe("MCP authorization is independent from chat YOLO", () => {
  let root = "";
  let configDir = "";
  let outsideDir = "";
  let previousConfig: string | undefined;

  const identity = () => ({
    mode: "oauth" as const, subject: "mcp-trusted-writer",
    scopes: ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"],
  });
  const makeServer = (exposure: "full" | "gateway" = "full") =>
    createSuperagentMcpServer({
      workspace: root, authMode: "oauth", toolExposure: exposure,
      getIdentity: identity,
    });
  const listNames = async (server: ReturnType<typeof makeServer>) => {
    const handler = (server as any)._requestHandlers.get("tools/list");
    const result = await handler({ method: "tools/list", params: {} }, {});
    return result.tools.map((tool: any) => tool.name) as string[];
  };
  const call = async (server: ReturnType<typeof makeServer>, name: string, args: any) => {
    const handler = (server as any)._requestHandlers.get("tools/call");
    return handler({ method: "tools/call", params: { name, arguments: args } }, {});
  };
  const write = (server: ReturnType<typeof makeServer>, filepath: string) =>
    call(server, "superagent_write_files", {
      projectId: "mcp-test-project",
      files: [{ filePath: filepath, content: "MCP_APPROVED", overwrite: true }],
      cwd: root,
    });

  beforeEach(() => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auth-config-"));
    root = path.join(configDir, "workspace");
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auth-outside-"));
    fs.mkdirSync(root);
    process.env.SUPERAGENT_CONFIG_DIR = configDir;
    setYoloMode(false);
    registerProject({ id: "mcp-test-project", name: "MCP Test", type: "local", root });
  });
  afterEach(() => {
    setYoloMode(false);
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("lists OAuth write tools with YOLO off, but denies execution without Security Approval", async () => {
    const server = makeServer();
    const file = path.join(root, "denied.txt");
    try {
      expect(await listNames(server)).toContain("superagent_write_files");
      await expect(write(server, file)).rejects.toThrow(/PROJECT_GRANT_MISSING/);
      expect(fs.existsSync(file)).toBe(false);
    } finally { await server.close(); }
  });

  it("permits approved project write even when chat YOLO remains off", async () => {
    grantProjectAccess(identity(), "mcp-test-project", ["read", "write"]);
    const server = makeServer();
    const file = path.join(root, "approved.txt");
    try {
      const result = await write(server, file);
      expect(result.isError).not.toBe(true);
      expect(fs.readFileSync(file, "utf8")).toBe("MCP_APPROVED");
    } finally { await server.close(); }
  });

  it("chat YOLO full cannot expand MCP grants beyond the exact project", async () => {
    setFullYoloMode(true);
    grantProjectAccess(identity(), "mcp-test-project", ["read", "write"]);
    const server = makeServer();
    try {
      const outside = path.join(outsideDir, "outside.txt");
      await expect(write(server, outside)).rejects.toThrow(/project|scope/i);
      expect(fs.existsSync(outside)).toBe(false);
    } finally { await server.close(); }
  });

  it("rejects filesystem symlink and junction escape regardless of Full YOLO", () => {
    setFullYoloMode(true);
    expect(isPathWithinMcpScope(path.join(root, "allowed.txt"), root)).toBe(true);
    expect(isPathWithinMcpScope(path.join(outsideDir, "blocked.txt"), root)).toBe(false);
    const alias = path.join(root, "outside-alias");
    try {
      fs.symlinkSync(outsideDir, alias, process.platform === "win32" ? "junction" : "dir");
      expect(isPathWithinMcpScope(path.join(alias, "escape.txt"), root)).toBe(false);
      expect(isToolCallWithinMcpScope({
        name: "superagent_write_files",
        args: { files: [{ filePath: path.join(alias, "escape.txt"), content: "DENIED" }] },
      }, root)).toBe(false);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  it("chat YOLO off does not revoke a separately approved MCP grant", async () => {
    grantProjectAccess(identity(), "mcp-test-project", ["read", "write"]);
    setFullYoloMode(true);
    const server = makeServer();
    try {
      setYoloMode(false);
      const file = path.join(root, "after-yolo-off.txt");
      const result = await write(server, file);
      expect(result.isError).not.toBe(true);
      expect(fs.existsSync(file)).toBe(true);
    } finally { await server.close(); }
  });

  it("MCP grant revocation denies subsequent writes regardless of chat YOLO", async () => {
    grantProjectAccess(identity(), "mcp-test-project", ["read", "write"]);
    revokeProjectAccess(identity(), "mcp-test-project");
    setFullYoloMode(true);
    const server = makeServer();
    try {
      const file = path.join(root, "revoked.txt");
      await expect(write(server, file)).rejects.toThrow(/PROJECT_GRANT_MISSING/);
      expect(fs.existsSync(file)).toBe(false);
    } finally { await server.close(); }
  });

  it("non-project dangerous actions need independent MCP Connection Controls", async () => {
    const server = makeServer();
    try {
      await expect(call(server, "superagent_delegate_send_message", {}))
        .rejects.toThrow(/MCP_APPROVAL_REQUIRED.*Approval pending: req_/);
      const pending = listProjectAccessRequests({status: "pending", projectId: MCP_CONNECTION_PROJECT_ID});
      expect(pending).toHaveLength(1);
      expect(pending[0].capabilities).toEqual(["execute"]);
      expect(pending[0].subject).toBe(identity().subject);
      expect(hasProjectAccess(identity(), MCP_CONNECTION_PROJECT_ID, "execute")).toBe(false);
      // Repeated denies must reuse the same request, not flood the Tray inbox.
      await expect(call(server, "superagent_delegate_send_message", {}))
        .rejects.toThrow(/MCP_APPROVAL_REQUIRED/);
      expect(listProjectAccessRequests({status: "pending", projectId: MCP_CONNECTION_PROJECT_ID})
        .map(request => request.requestId)).toEqual([pending[0].requestId]);
      grantProjectAccess(identity(), MCP_CONNECTION_PROJECT_ID, ["execute"]);
      expect(hasProjectAccess(identity(), MCP_CONNECTION_PROJECT_ID, "execute")).toBe(true);
    } finally { await server.close(); }
  });

  it("insufficient OAuth write scope never queues a misleading approval request", async () => {
    const reader = createSuperagentMcpServer({
      workspace: root, authMode: "oauth", toolExposure: "full",
      getIdentity: () => ({...identity(), scopes: ["mcp:tools"]}),
    });
    try {
      await expect(call(reader, "superagent_delegate_send_message", {}))
        .rejects.toThrow(/mcp:tools:write/);
      expect(listProjectAccessRequests({status: "pending", projectId: MCP_CONNECTION_PROJECT_ID}))
        .toEqual([]);
    } finally { await reader.close(); }
  });

  it("gateway recursion cannot bypass a missing project grant", async () => {
    const server = makeServer("gateway");
    const file = path.join(root, "gateway-denied.txt");
    try {
      await expect(call(server, "superagent_tool_execute", {
        name: "superagent_write_files",
        arguments: { projectId: "mcp-test-project",
          files: [{ filePath: file, content: "DENIED" }], cwd: root },
      })).rejects.toThrow(/PROJECT_GRANT_MISSING/);
      expect(fs.existsSync(file)).toBe(false);
    } finally { await server.close(); }
  });
});
