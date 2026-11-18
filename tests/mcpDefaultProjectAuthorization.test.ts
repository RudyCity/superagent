import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { registerProject } from "../src/core/project/projectRegistry.js";
import { grantProjectAccess, revokeProjectAccess } from "../src/core/project/projectAccessPolicy.js";

describe("MCP default workspace project authorization", () => {
  let config: string;
  let previousConfig: string | undefined;
  let root: string;
  let otherRoot: string;
  let outside: string;
  const first = { mode: "oauth" as const, subject: "default-client-a", ownerConnectionName: "Approved app",
    scopes: ["mcp:tools", "mcp:tools:write"], credentialHash: "a".repeat(64) };
  const second = { ...first, subject: "default-client-b", credentialHash: "b".repeat(64) };
  let identity = first;
  beforeEach(() => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    config = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "mcp-default-project-")));
    process.env.SUPERAGENT_CONFIG_DIR = config;
    root = path.join(config, "registered");
    otherRoot = path.join(config, "other-registered");
    outside = path.join(config, "unregistered");
    for (const dir of [root, otherRoot, outside]) fs.mkdirSync(dir);
    registerProject({ id: "default-a", name: "Default A", type: "local", root });
    registerProject({ id: "default-b", name: "Default B", type: "local", root: otherRoot });
    identity = first;
  });
  afterEach(() => {
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    fs.rmSync(config, { recursive: true, force: true });
  });
  const invoke = async (server: ReturnType<typeof createSuperagentMcpServer>, gateway: boolean,
    file: string, context: Record<string, unknown> = {}) => {
    const args = { ...context, files: [{ filePath: file, content: "authorized fixture write" }] };
    const call = (server as any)._requestHandlers.get("tools/call");
    try {
      return await call({ method: "tools/call", params: gateway
        ? { name: "superagent_tool_execute", arguments: { name: "superagent_write_files", arguments: args } }
        : { name: "superagent_write_files", arguments: args } });
    } catch (error) {
      return { isError: true, content: [{ text: error instanceof Error ? error.message : String(error) }] };
    }
  };

  it.each([false, true])("uses a granted registered default without caller-supplied routing (gateway=%s)", async gateway => {
    grantProjectAccess(first, "default-a", ["write"]);
    const server = createSuperagentMcpServer({ workspace: root, toolExposure: "gateway", authMode: "oauth", getIdentity: () => identity });
    try {
      const allowed = await invoke(server, gateway, "allowed.txt");
      expect(allowed.isError).not.toBe(true);
      expect(fs.readFileSync(path.join(root, "allowed.txt"), "utf8")).toBe("authorized fixture write");
      revokeProjectAccess(first, "default-a");
      const revoked = await invoke(server, gateway, "revoked.txt");
      expect(revoked.isError).toBe(true);
      expect(fs.existsSync(path.join(root, "revoked.txt"))).toBe(false);
    } finally { await server.close(); }
  });

  it.each([false, true])("denies missing grants and never falls back from an explicit target (gateway=%s)", async gateway => {
    const server = createSuperagentMcpServer({ workspace: root, toolExposure: "gateway", authMode: "oauth", getIdentity: () => identity });
    try {
      expect((await invoke(server, gateway, "no-grant.txt")).isError).toBe(true);
      grantProjectAccess(first, "default-a", ["write"]);
      for (const context of [
        { projectId: "unknown-project" }, { projectId: "default-b" },
        { workspace: outside }, { cwd: outside }, { worktreePath: outside },
        { projectId: "default-a", workspace: outside },
      ]) expect((await invoke(server, gateway, "wrong-target.txt", context)).isError).toBe(true);
      for (const dir of [root, otherRoot, outside]) {
        expect(fs.existsSync(path.join(dir, "no-grant.txt"))).toBe(false);
        expect(fs.existsSync(path.join(dir, "wrong-target.txt"))).toBe(false);
      }
    } finally { await server.close(); }
  });

  it("binds permission to the current authenticated client despite identical display names", async () => {
    grantProjectAccess(first, "default-a", ["write"]);
    const server = createSuperagentMcpServer({ workspace: root, toolExposure: "gateway", authMode: "oauth", getIdentity: () => identity });
    try {
      expect((await invoke(server, false, "first.txt")).isError).not.toBe(true);
      identity = second;
      for (const gateway of [false, true]) {
        expect((await invoke(server, gateway, "second.txt")).isError).toBe(true);
      }
      expect(fs.existsSync(path.join(root, "second.txt"))).toBe(false);
    } finally { await server.close(); }
  });
});
