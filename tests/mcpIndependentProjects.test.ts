import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { registerProject, updateProject } from "../src/core/project/projectRegistry.js";
import { hasProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { createProjectAccessRequest, approveProjectAccessRequest } from "../src/core/project/projectAccessRequestStore.js";
import { PERMANENT_ACCESS_FILENAME } from "../src/core/desktopUi/permanentRegistryStore.js";
import { identityOfSelf } from "../src/core/tools/registeredFileToolGate.js";
import { setFullYoloMode, setYoloMode } from "../src/core/permissions.js";

describe("MCP independent project Security Approval", () => {
  let configDir = "";
  let projectA = "";
  let projectB = "";
  let previousConfig: string | undefined;
  const projectAId = "independent-local-a";
  const projectBId = "independent-local-b";
  const identity = { mode: "oauth" as const, subject: "approved-mcp-client",
    scopes: ["mcp:tools", "mcp:tools:write", "mcp:tools:admin"] };

  const textOf = (result: any): string =>
    (result?.content ?? []).map((part: any) => part.text ?? "").join("\n");
  function server() {
    return createSuperagentMcpServer({
      workspace: projectA, toolExposure: "full", authMode: "oauth",
      getIdentity: () => identity,
    });
  }
  async function call(mcp: ReturnType<typeof server>, name: string, args: Record<string, unknown>) {
    const handler = (mcp as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    try { return await handler({ method: "tools/call", params: { name, arguments: args } }, {}); }
    catch (error) { return { isError: true, content: [{ text: String(error) }] }; }
  }
  function approve(projectId: string, capabilities: Array<"read" | "write" | "execute">) {
    const pending = createProjectAccessRequest(identity, {
      projectId, capabilities, reason: "Approved by local operator for test",
    });
    approveProjectAccessRequest(pending.requestId);
  }

  beforeEach(() => {
    previousConfig = process.env.SUPERAGENT_CONFIG_DIR;
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-independent-"));
    projectA = path.join(configDir, "project-a");
    projectB = path.join(configDir, "project-b");
    fs.mkdirSync(projectA); fs.mkdirSync(projectB);
    process.env.SUPERAGENT_CONFIG_DIR = configDir;
    fs.writeFileSync(path.join(projectA, "from-a.txt"), "alpha");
    fs.writeFileSync(path.join(projectB, "from-b.txt"), "bravo");
    fs.writeFileSync(path.join(projectB, ".env.local"), "TEST_SECRET=private");
    const selfIdentity = identityOfSelf();
    if (!selfIdentity) throw new Error("Expected executable identity in test.");
    const canonical = (p: string) => fs.realpathSync.native(p).replace(/^\\\\\?\\/, "");
    fs.writeFileSync(
      path.join(configDir, PERMANENT_ACCESS_FILENAME),
      JSON.stringify({
        version: 2,
        defaultEffect: "deny",
        rules: [
          {
            id: "allow-project-a",
            kind: "file",
            effect: "allow",
            app: selfIdentity,
            operations: ["read", "write"],
            scope: { path: canonical(projectA), recursive: true },
          },
          {
            id: "allow-project-b",
            kind: "file",
            effect: "allow",
            app: selfIdentity,
            operations: ["read", "write"],
            scope: { path: canonical(projectB), recursive: true },
          },
        ],
      }),
      "utf8",
    );
    registerProject({ id: projectAId, name: "Project A", type: "local", root: projectA });
    registerProject({ id: projectBId, name: "Project B", type: "local", root: projectB });
    setYoloMode(false);
  });
  afterEach(() => {
    setYoloMode(false);
    if (previousConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previousConfig;
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("registration never authorizes another project, even with chat Full YOLO", async () => {
    setFullYoloMode(true);
    const mcp = server();
    try {
      const result = await call(mcp, "superagent_list_files", { projectId: projectBId });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("PROJECT_GRANT_MISSING");
    } finally { await mcp.close(); }
  });

  it("human-approved read grants allow only their selected project and no writes", async () => {
    approve(projectBId, ["read"]);
    setYoloMode(false);
    const mcp = server();
    try {
      const listed = await call(mcp, "superagent_list_files", { projectId: projectBId });
      expect(listed.isError).not.toBe(true);
      expect(textOf(listed)).toContain("from-b.txt");
      const forbidden = await call(mcp, "superagent_list_files", { projectId: projectAId });
      expect(forbidden.isError).toBe(true);
      const edit = await call(mcp, "superagent_write_files", {
        projectId: projectBId, files: [{ filePath: "unauthorized.txt", content: "no" }],
      });
      expect(edit.isError).toBe(true);
      expect(fs.existsSync(path.join(projectB, "unauthorized.txt"))).toBe(false);
    } finally { await mcp.close(); }
  });

  it("project-scoped write cannot escape into another registered project", async () => {
    approve(projectBId, ["read", "write"]);
    setFullYoloMode(true);
    const mcp = server();
    try {
      const outside = path.join(projectA, "cross-project.txt");
      const result = await call(mcp, "superagent_write_files", {
        projectId: projectBId, files: [{ filePath: outside, content: "NO" }],
      });
      expect(result.isError).toBe(true);
      expect(fs.existsSync(outside)).toBe(false);
      const protectedEnv = await call(mcp, "superagent_read_files", {
        projectId: projectBId, files: [".env.local"],
      });
      expect(protectedEnv.isError).toBe(true);
      expect(textOf(protectedEnv)).not.toContain("TEST_SECRET=private");
    } finally { await mcp.close(); }
  });

  it("disabling a project revokes all approved MCP grants without affecting chat YOLO", async () => {
    approve(projectBId, ["read"]);
    expect(hasProjectAccess(identity, projectBId, "read")).toBe(true);
    updateProject(projectBId, { enabled: false });
    expect(hasProjectAccess(identity, projectBId, "read")).toBe(false);
    const mcp = server();
    try {
      const result = await call(mcp, "superagent_list_files", { projectId: projectBId });
      expect(result.isError).toBe(true);
    } finally { await mcp.close(); }
  });

  it("legacy MCP self-grant cannot create a project grant even with Full YOLO", async () => {
    setFullYoloMode(true);
    const mcp = server();
    try {
      const attempted = await call(mcp, "superagent_grant_project_access", {
        projectId: projectBId, capabilities: ["read"],
      });
      expect(attempted.isError).toBe(true);
      expect(hasProjectAccess(identity, projectBId, "read")).toBe(false);
    } finally { await mcp.close(); }
  });
});
