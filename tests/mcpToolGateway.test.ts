import { afterEach, describe, expect, it } from "vitest";
import {
  createSuperagentMcpServer,
  MCP_TOOL_DEFINITIONS,
} from "../src/core/mcp/superagentMcpServer.js";
import {
  MCP_GATEWAY_TOOL_NAMES,
  MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES,
  describeGatewayTool,
  searchGatewayTools,
  validateGatewayExecuteTarget,
} from "../src/core/mcp/mcpToolGateway.js";
import { setYoloMode } from "../src/core/permissions.js";

const invoke = async (server: ReturnType<typeof createSuperagentMcpServer>,
  name: string, args: Record<string, unknown> = {}) => {
  const handler = (server as any)._requestHandlers.get("tools/call");
  return handler({ method: "tools/call", params: { name, arguments: args } });
};

const list = async (server: ReturnType<typeof createSuperagentMcpServer>) => {
  const handler = (server as any)._requestHandlers.get("tools/list");
  return (await handler({ method: "tools/list", params: {} })).tools as Array<{name:string}>;
};

const parseResult = (result: any) => JSON.parse(result.content.find((entry: any) => entry.type === "text").text);

afterEach(() => setYoloMode(false));

describe("static MCP gateway catalog", () => {
  it("does not expose privileged or disabled tools through search, describe, or status", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "gateway",
      authMode: "oauth",
      getIdentity: () => ({ mode: "oauth", subject: "reader", scopes: ["mcp:tools"] }),
    });
    const advertised = (await list(server)).map((tool) => tool.name);
    expect(advertised).toEqual(expect.arrayContaining([
      MCP_GATEWAY_TOOL_NAMES.search,
      MCP_GATEWAY_TOOL_NAMES.describe,
      MCP_GATEWAY_TOOL_NAMES.status,
    ]));
    expect(advertised).toContain(MCP_GATEWAY_TOOL_NAMES.execute);
    const executionTool = (await list(server)).find((tool) => tool.name === MCP_GATEWAY_TOOL_NAMES.execute) as any;
    expect(executionTool.annotations?.readOnlyHint).toBe(false);
    expect(executionTool.annotations?.destructiveHint).toBe(true);
    expect(executionTool._meta.securitySchemes[0].scopes).toContain("mcp:tools");
    expect(advertised).not.toContain("superagent_read_files");
    expect(advertised).toEqual(expect.arrayContaining([
      "superagent_get_workspace",
      "superagent_list_projects",
      "superagent_discover_projects",
      "superagent_get_project",
      "superagent_check_project_health",
      "superagent_list_project_access",
    ]));
    expect(advertised).not.toContain("superagent_switch_workspace");
    expect(advertised).not.toContain("superagent_register_project");
    expect(advertised).not.toContain("superagent_import_discovered_project");

    const directList = await invoke(server, "superagent_list_projects");
    expect(directList.isError).not.toBe(true);

    const search = parseResult(await invoke(server, MCP_GATEWAY_TOOL_NAMES.search, { query: "project", limit: 20 }));
    expect(search.tools.length).toBeGreaterThan(0);
    expect(search.tools.map((entry: any) => entry.name)).not.toContain("superagent_grant_project_access");
    expect(search.tools.map((entry: any) => entry.name)).not.toContain("superagent_write_files");
    expect(search.tools.map((entry: any) => entry.name)).not.toContain("superagent_read_file");

    const rejected = await invoke(server, MCP_GATEWAY_TOOL_NAMES.describe, { name: "superagent_grant_project_access" });
    expect(rejected.isError).toBe(true);
    const valid = parseResult(await invoke(server, MCP_GATEWAY_TOOL_NAMES.describe, { name: "superagent_get_workspace" }));
    expect(valid.name).toBe("superagent_get_workspace");
    expect(valid.inputSchema.type).toBe("object");

    const status = parseResult(await invoke(server, MCP_GATEWAY_TOOL_NAMES.status));
    expect(status.mode).toBe("gateway");
    expect(status.visibleToolCount).toBeGreaterThan(0);
    expect(status.gatewayTools).toContain(MCP_GATEWAY_TOOL_NAMES.execute);
    expect(status.eagerProjectWorkspaceTools).toEqual(expect.arrayContaining([
      "superagent_get_workspace",
      "superagent_list_projects",
      "superagent_discover_projects",
    ]));
    expect(status.initiallyAdvertisedTools).toEqual(expect.arrayContaining([
      MCP_GATEWAY_TOOL_NAMES.search,
      "superagent_list_projects",
    ]));
    await server.close();
  });

  it("eager-loads authorized project/workspace mutation tools only with their original write/admin policy", async () => {
    setYoloMode(true);
    let scopes = ["mcp:tools", "mcp:tools:read", "mcp:tools:write"];
    const server = createSuperagentMcpServer({
      toolExposure: "gateway",
      authMode: "oauth",
      allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "project-writer", scopes }),
    });
    const writerTools = (await list(server)).map((tool) => tool.name);
    expect(writerTools).toContain("superagent_switch_workspace");
    expect(writerTools).not.toContain("superagent_register_project");
    expect(writerTools).not.toContain("superagent_import_discovered_project");
    expect(writerTools).not.toContain("superagent_sync_projects");

    scopes = ["mcp:tools", "mcp:tools:read", "mcp:tools:write", "mcp:tools:admin"];
    const adminTools = (await list(server)).map((tool) => tool.name);
    for (const toolName of MCP_GATEWAY_EAGER_PROJECT_WORKSPACE_TOOL_NAMES) {
      expect(adminTools).toContain(toolName);
    }
    await server.close();
  });

  it("allows OAuth read-only execution of safe targets but not write targets", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "gateway",
      authMode: "oauth",
      allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "read-only", scopes: ["mcp:tools"] }),
    });
    const safeResult = await invoke(server, MCP_GATEWAY_TOOL_NAMES.execute, {
      name: "superagent_server_health", arguments: {},
    });
    expect(safeResult.isError).not.toBe(true);
    const denied = await invoke(server, MCP_GATEWAY_TOOL_NAMES.execute, {
      name: "superagent_exec_command", arguments: { command: "echo forbidden" },
    });
    expect(denied.isError).toBe(true);
    await server.close();
  });

  it("reuses original target dispatch, permission checks, and audit identity", async () => {
    const called: string[] = [];
    const server = createSuperagentMcpServer({
      toolExposure: "gateway",
      authMode: "oauth",
      allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "writer", scopes: ["mcp:tools", "mcp:tools:write"] }),
      onToolCall: (entry) => called.push(entry.tool),
    });
    expect((await list(server)).map((tool) => tool.name)).toContain(MCP_GATEWAY_TOOL_NAMES.execute);
    const response = await invoke(server, MCP_GATEWAY_TOOL_NAMES.execute, {
      name: "superagent_server_health", arguments: {},
    });
    expect(response.isError).not.toBe(true);
    expect(called).toContain("superagent_server_health");
    expect(called).toContain(MCP_GATEWAY_TOOL_NAMES.execute);

    const blocked = await invoke(server, MCP_GATEWAY_TOOL_NAMES.execute, {
      name: MCP_GATEWAY_TOOL_NAMES.execute, arguments: {
        name: MCP_GATEWAY_TOOL_NAMES.execute,
      },
    });
    expect(blocked.isError).toBe(true);
    const disabled = await invoke(server, MCP_GATEWAY_TOOL_NAMES.execute, {
      name: "superagent_read_file", arguments: { path: ".env" },
    });
    expect(disabled.isError).toBe(true);
    await server.close();
  });

  it("reflects OAuth scope revocation immediately, without stale cached gateway discovery", async () => {
    setYoloMode(true);
    let scopes = ["mcp:tools", "mcp:tools:read", "mcp:tools:write", "mcp:tools:admin"];
    const server = createSuperagentMcpServer({
      toolExposure: "gateway",
      authMode: "oauth",
      allowDangerous: true,
      getIdentity: () => ({ mode: "oauth", subject: "scope-change", scopes }),
    });
    const first = parseResult(await invoke(server, MCP_GATEWAY_TOOL_NAMES.search, { query: "grant_project_access" }));
    expect(first.tools.map((tool: any) => tool.name)).toContain("superagent_grant_project_access");

    scopes = ["mcp:tools"];
    const afterRevoke = parseResult(await invoke(server, MCP_GATEWAY_TOOL_NAMES.search, { query: "grant_project_access" }));
    expect(afterRevoke.tools).toEqual([]);
    const noSchema = await invoke(server, MCP_GATEWAY_TOOL_NAMES.describe, { name: "superagent_grant_project_access" });
    expect(noSchema.isError).toBe(true);
    const denied = await invoke(server, MCP_GATEWAY_TOOL_NAMES.execute, {
      name: "superagent_grant_project_access", arguments: {},
    });
    expect(denied.isError).toBe(true);
    await server.close();
  });

  it("does not override the outer allowlist for static-bearer tool execution", async () => {
    const server = createSuperagentMcpServer({
      toolExposure: "gateway",
      allowedTools: [
        MCP_GATEWAY_TOOL_NAMES.search,
        MCP_GATEWAY_TOOL_NAMES.describe,
        MCP_GATEWAY_TOOL_NAMES.status,
        "superagent_get_workspace",
      ],
    });
    expect((await list(server)).map((tool) => tool.name)).not.toContain(MCP_GATEWAY_TOOL_NAMES.execute);
    await expect(invoke(server, MCP_GATEWAY_TOOL_NAMES.execute, {
      name: "superagent_get_workspace", arguments: {},
    })).rejects.toThrow(/allowlist/);
    await server.close();
  });

  it("ranks authorized intents, enforces limits, and rejects nested gateway execution", () => {
    const available = MCP_TOOL_DEFINITIONS.filter((item) =>
      ["superagent_grep_search", "superagent_get_workspace", "superagent_tool_execute", "superagent_tool_search"].includes(item.name));
    expect(searchGatewayTools(available, { intent: "search in code", limit: 1 })).toEqual([
      expect.objectContaining({ name: "superagent_grep_search" }),
    ]);
    expect(describeGatewayTool(available, MCP_GATEWAY_TOOL_NAMES.execute)).toBeNull();
    expect(validateGatewayExecuteTarget(available, { name: MCP_GATEWAY_TOOL_NAMES.search })).toBeNull();
    expect(validateGatewayExecuteTarget(available, { name: "superagent_grep_search", arguments: [] })).toBeNull();
  });
});
