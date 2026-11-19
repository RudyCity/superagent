import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerProject, listProjects, updateProject } from "../src/core/project/projectRegistry.js";
import { resolveProjectTarget } from "../src/core/project/projectRouter.js";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { onMcpActivity } from "../src/core/mcp/mcpActivityBus.js";
import { hasProjectAccess, grantProjectAccess } from "../src/core/project/projectAccessPolicy.js";
import { MCP_CONNECTION_PROJECT_ID, createProjectAccessRequest,
  listProjectAccessRequests } from "../src/core/project/projectAccessRequestStore.js";

describe("MCP virtual connection scope cannot alias a registered project", () => {
  let config: string;
  let previous: string | undefined;
  let root: string;
  const identity = { mode: "oauth" as const, subject: "reserved-scope-client", scopes: ["mcp:tools", "mcp:tools:write"] };
  beforeEach(() => {
    previous = process.env.SUPERAGENT_CONFIG_DIR;
    config = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "sa-reserved-project-")));
    process.env.SUPERAGENT_CONFIG_DIR = config;
    root = path.join(config, "PRIVATE_PROJECT_ROOT");
    fs.mkdirSync(root);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = previous;
    fs.rmSync(config, { recursive: true, force: true });
  });
  function legacyConnectionGrant() {
    // Simulate a historical grant already on disk; it must have no effect.
    grantProjectAccess(identity, MCP_CONNECTION_PROJECT_ID, ["execute"]);
    expect(hasProjectAccess(identity, MCP_CONNECTION_PROJECT_ID, "execute")).toBe(true);
  }
  function legacyCollision() {
    const bytes = JSON.stringify({ schemaVersion: 1, projects: [{ id: MCP_CONNECTION_PROJECT_ID,
      name: "Legacy collision", type: "local", root, tags: [], enabled: true, createdAt: 1, updatedAt: 1 }] });
    fs.writeFileSync(path.join(config, "projects.json"), bytes);
    return bytes;
  }

  it.each([
    { id: "mcp-connection", name: "Explicit" }, { id: " MCP_Connection ", name: "Normalized" },
    { name: "MCP Connection" },
  ])("rejects reserved IDs after normalizing $name without writing stores", input => {
    expect(() => registerProject({ ...input, type: "local", root })).toThrow(/RESERVED_PROJECT_ID/);
    expect(fs.existsSync(path.join(config, "projects.json"))).toBe(false);
  });

  it("refuses new operation grants against the virtual MCP connection", () => {
    expect(() => createProjectAccessRequest(identity, { projectId: MCP_CONNECTION_PROJECT_ID,
      capabilities: ["execute"], reason: "Deprecated non-project Execute" })).toThrow(/OAuth|registered project/);
    expect(listProjectAccessRequests({ status: "pending" })).toHaveLength(0);
  });

  it("preserves ordinary prefixed IDs but never inherits connection Execute", () => {
    const project = registerProject({ id: "mcp-connection-app", name: "Ordinary project", type: "local", root });
    expect(updateProject(project.id, { name: "Updated ordinary project" }).id).toBe(project.id);
    legacyConnectionGrant();
    expect(hasProjectAccess(identity, project.id, "execute")).toBe(false);
    expect(resolveProjectTarget({ projectId: project.id, sessionWorkspace: root }).projectId).toBe(project.id);
  });

  it("rejects persisted collisions on reads, updates and explicit or ambient resolution without rewriting", () => {
    const bytes = legacyCollision();
    for (const operation of [() => listProjects(), () => updateProject(MCP_CONNECTION_PROJECT_ID, { enabled: false }),
      () => resolveProjectTarget({ projectId: MCP_CONNECTION_PROJECT_ID, sessionWorkspace: root }),
      () => resolveProjectTarget({ sessionWorkspace: root })]) {
      expect(operation).toThrow(/RESERVED_PROJECT_ID/);
    }
    expect(fs.readFileSync(path.join(config, "projects.json"), "utf8")).toBe(bytes);
  });

  it("keeps project permission diagnostics independent of a legacy project collision", async () => {
    legacyConnectionGrant();
    const bytes = legacyCollision();
    const server = createSuperagentMcpServer({ workspace: root, toolExposure: "gateway", authMode: "oauth",
      getIdentity: () => identity });
    try {
      const result = await (server as any)._requestHandlers.get("tools/call")({ method: "tools/call", params: {
        name: "superagent_tool_describe", arguments: { name: "superagent_desktop_ui", checkArguments: { command: "probe" } },
      } });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(result.content[0].text).permissionPreflight).toMatchObject({
        decisionCode: "PROJECT_CAPABILITY_MISSING", performedExecution: false, mcpProjectExecute: { decision: "approval_required" },
      });
      expect(listProjectAccessRequests({ status: "pending" })).toHaveLength(0);
      expect(fs.readFileSync(path.join(config, "projects.json"), "utf8")).toBe(bytes);
    } finally { await server.close(); }
  });

  it.each([
    { gateway: false, explicit: false }, { gateway: false, explicit: true },
    { gateway: true, explicit: false }, { gateway: true, explicit: true },
  ])("denies legacy project execute with only a connection grant (gateway=$gateway, explicit=$explicit)", async ({ gateway, explicit }) => {
    legacyConnectionGrant();
    const policyBytes = fs.readFileSync(path.join(config, "project-access.json"), "utf8");
    const registryBytes = legacyCollision();
    const audits: unknown[] = [], activities: unknown[] = [];
    const unsubscribe = onMcpActivity(event => activities.push(event));
    const server = createSuperagentMcpServer({ workspace: root, toolExposure: "gateway", authMode: "oauth",
      getIdentity: () => identity, onToolCall: event => audits.push(event) });
    try {
      const args = { command: "echo PRIVATE_COMMAND_SENTINEL > collision-effect.txt",
        ...(explicit ? { projectId: MCP_CONNECTION_PROJECT_ID } : {}) };
      let response;
      try {
        response = await (server as any)._requestHandlers.get("tools/call")({ method: "tools/call", params: gateway
          ? { name: "superagent_tool_execute", arguments: { name: "superagent_exec_command", arguments: args } }
          : { name: "superagent_exec_command", arguments: args } });
      } catch (error) { response = { isError: true, content: [{ text: error instanceof Error ? error.message : String(error) }] }; }
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("RESERVED_PROJECT_ID");
      expect(fs.existsSync(path.join(root, "collision-effect.txt"))).toBe(false);
      expect(audits).toHaveLength(1);
      expect(activities).toHaveLength(1);
      expect(audits[0]).toMatchObject({ args: {}, projectId: null, providerKind: null,
        errorCode: "reserved_project_id", authorizationDecision: "denied" });
      expect(activities[0]).toMatchObject({ args: {}, workspace: "mcp://authorization" });
      for (const value of [response, audits, activities]) {
        expect(JSON.stringify(value)).not.toContain(config);
        expect(JSON.stringify(value)).not.toContain("PRIVATE_COMMAND_SENTINEL");
      }
      expect(listProjectAccessRequests({ status: "pending" })).toHaveLength(0);
      expect(fs.readFileSync(path.join(config, "projects.json"), "utf8")).toBe(registryBytes);
      expect(fs.readFileSync(path.join(config, "project-access.json"), "utf8")).toBe(policyBytes);
    } finally { unsubscribe(); await server.close(); }
  });
});
