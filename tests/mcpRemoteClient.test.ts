import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMcpHttpServer, generateMcpBearerToken } from "../src/core/mcp/mcpHttpTransport.js";

const state = vi.hoisted(() => ({
  config: { mcpServers: {} as Record<string, any> },
}));

vi.mock("../src/core/config/jsonConfig.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/core/config/jsonConfig.js")>();
  return { ...original, loadModelConfig: () => state.config };
});

describe("outgoing remote Streamable HTTP MCP client", () => {
  let server: Awaited<ReturnType<typeof startMcpHttpServer>> | undefined;
  let closeMcpServers: typeof import("../src/core/mcp/McpManager.js")["closeMcpServers"];
  let connectedServers: typeof import("../src/core/mcp/McpManager.js")["connectedServers"];
  let initMcpServers: typeof import("../src/core/mcp/McpManager.js")["initMcpServers"];
  let token = "";

  beforeEach(async () => {
    state.config = { mcpServers: {} };
    token = generateMcpBearerToken();
    // This fixture verifies the outbound client's ability to discover actual
    // remote standalone tools, so opt into the legacy full MCP catalog.
    server = await startMcpHttpServer({
      port: 0,
      bearerToken: token,
      allowDangerous: false,
      toolExposure: "full",
    });
    vi.stubEnv("SUPERAGENT_TEST_REMOTE_MCP_AUTH", "Bearer " + token);
    const manager = await import("../src/core/mcp/McpManager.js");
    closeMcpServers = manager.closeMcpServers;
    connectedServers = manager.connectedServers;
    initMcpServers = manager.initMcpServers;
  }, 30000);

  afterEach(async () => {
    if (closeMcpServers) await closeMcpServers();
    if (server) await server.close();
    server = undefined;
    state.config = { mcpServers: {} };
    vi.unstubAllEnvs();
  });

  it("connects over HTTP, discovers namespaced tools, invokes one, and closes cleanly", async () => {
    state.config = {
      mcpServers: {
        remotesmoke: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
          headersFromEnv: { Authorization: "SUPERAGENT_TEST_REMOTE_MCP_AUTH" },
        },
      },
    };

    await initMcpServers();

    const connection = connectedServers.get("remotesmoke");
    expect(connection?.status).toBe("connected");
    expect(connection?.tools).toContain("remotesmoke_superagent_server_health");

    const { getToolByName } = await import("../src/core/tools/index.js");
    const remoteTool = getToolByName("remotesmoke_superagent_server_health");
    expect(remoteTool).toBeDefined();
    const result = await remoteTool!.execute({}, process.cwd());
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    const { manageMcpTool } = await import("../src/core/tools/mcpTools.js");
    const stats = await manageMcpTool.execute({ action: "stats", name: "remotesmoke" }, process.cwd());
    expect(stats).toContain("remotesmoke_superagent_server_health");
    expect(stats).toContain("calls=");

    await closeMcpServers();
    expect(connectedServers.size).toBe(0);
    expect(getToolByName("remotesmoke_superagent_server_health")).toBeUndefined();
  }, 30000);

  it("refreshes changed MCP capabilities without reconnecting and revokes stale tools", async () => {
    state.config = {
      mcpServers: {
        refreshed: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
          headersFromEnv: { Authorization: "SUPERAGENT_TEST_REMOTE_MCP_AUTH" },
        },
      },
    };
    await initMcpServers();
    const connection = connectedServers.get("refreshed")!;
    const { getToolByName, masterToolset, superagentToolset, defaultSubagentToolset } =
      await import("../src/core/tools/index.js");
    const { getToolRegistryVersion } = await import("../src/core/tools/toolRegistryVersion.js");
    const { refreshMcpServerTools } = await import("../src/core/mcp/McpManager.js");
    const old = getToolByName("refreshed_superagent_server_health")!;
    expect(old).toBeDefined();
    expect(masterToolset.some((tool) => tool.name === old.name)).toBe(false);
    expect(defaultSubagentToolset.some((tool) => tool.name === old.name)).toBe(false);

    const before = getToolRegistryVersion();
    vi.spyOn(connection.client, "listTools").mockImplementation(async (params?: { cursor?: string }) => (
      params?.cursor
        ? { tools: [{ name: "second_page", description: "Next-page tool", inputSchema: { type: "object", properties: {} } }] }
        : { tools: [{ name: "new_capability", description: "New tool", inputSchema: { type: "object", properties: {} } }], nextCursor: "next" }
    ));
    expect(await refreshMcpServerTools("refreshed")).toBe(true);
    expect(getToolRegistryVersion()).toBeGreaterThan(before);
    expect(getToolByName(old.name)).toBeUndefined();
    expect(getToolByName("refreshed_new_capability")).toBeDefined();
    expect(getToolByName("refreshed_second_page")).toBeDefined();
    expect(superagentToolset.some((tool) => tool.name === "refreshed_new_capability")).toBe(true);
    expect(masterToolset.some((tool) => tool.name === "refreshed_new_capability")).toBe(false);
    expect(await old.execute({}, process.cwd())).toMatch(/no longer available/i);
    expect(await refreshMcpServerTools("refreshed")).toBe(false);
    const { manageMcpTool } = await import("../src/core/tools/mcpTools.js");
    expect(await manageMcpTool.execute({ action: "refresh", name: "refreshed" }, process.cwd()))
      .toMatch(/already up to date/);
  }, 30000);

  it("reconnects one client, refreshes its tool handles, and revokes old closures", async () => {
    state.config = {
      mcpServers: {
        reconnectable: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
          headersFromEnv: { Authorization: "SUPERAGENT_TEST_REMOTE_MCP_AUTH" },
          autoReconnect: false,
        },
      },
    };
    await initMcpServers();
    const oldConnection = connectedServers.get("reconnectable")!;
    const { getToolByName } = await import("../src/core/tools/index.js");
    const oldTool = getToolByName("reconnectable_superagent_server_health")!;
    expect(oldTool).toBeDefined();

    const { manageMcpTool } = await import("../src/core/tools/mcpTools.js");
    const result = await manageMcpTool.execute({ action: "reconnect", name: "reconnectable" }, process.cwd());
    expect(result).toMatch(/reconnected/i);
    const newConnection = connectedServers.get("reconnectable");
    expect(newConnection?.status).toBe("connected");
    expect(newConnection).not.toBe(oldConnection);
    expect(getToolByName(oldTool.name)).not.toBe(oldTool);
    expect(await oldTool.execute({}, process.cwd())).toMatch(/no longer available/);
    expect(await getToolByName(oldTool.name)!.execute({}, process.cwd())).not.toMatch(/no longer available/);
  }, 30000);

  it("retire tools on an unexpected disconnect while preserving other servers", async () => {
    state.config = {
      mcpServers: {
        lost: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
          headersFromEnv: { Authorization: "SUPERAGENT_TEST_REMOTE_MCP_AUTH" },
          autoReconnect: false,
        },
        surviving: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
          headersFromEnv: { Authorization: "SUPERAGENT_TEST_REMOTE_MCP_AUTH" },
          autoReconnect: false,
        },
      },
    };
    await initMcpServers();
    const { getToolByName } = await import("../src/core/tools/index.js");
    const removed = getToolByName("lost_superagent_server_health")!;
    const surviving = getToolByName("surviving_superagent_server_health")!;
    expect(removed).toBeDefined();
    expect(surviving).toBeDefined();
    const record = connectedServers.get("lost")!;
    record.transport!.onclose?.();
    for (let i = 0; i < 40 && getToolByName(removed.name); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(record.status).toBe("disconnected");
    expect(getToolByName(removed.name)).toBeUndefined();
    expect(record.tools).toEqual([]);
    expect(await removed.execute({}, process.cwd())).toMatch(/no longer available/);
    expect(getToolByName(surviving.name)).toBe(surviving);
  }, 30000);

  it("automatically reconnects a lost non-OAuth MCP client and cancels retries on shutdown", async () => {
    state.config = {
      mcpServers: {
        autorecover: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
          headersFromEnv: { Authorization: "SUPERAGENT_TEST_REMOTE_MCP_AUTH" },
          autoReconnect: true,
        },
      },
    };
    await initMcpServers();
    const previous = connectedServers.get("autorecover")!;
    previous.transport!.onclose?.();
    let recovered = false;
    for (let i = 0; i < 85; i++) {
      const now = connectedServers.get("autorecover");
      if (now?.status === "connected" && now !== previous) { recovered = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(recovered).toBe(true);
    await closeMcpServers();
    expect(connectedServers.size).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(connectedServers.size).toBe(0);
  }, 30000);

  it("does not report an unauthenticated HTTP server as connected", async () => {
    state.config = {
      mcpServers: {
        missingauth: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
        },
      },
    };

    await initMcpServers();

    const connection = connectedServers.get("missingauth");
    expect(connection?.status).toBe("error");
    expect(connection?.error).toMatch(/401|Unauthorized|authorization|token/i);
    expect(connection?.tools).toEqual([]);
  }, 30000);

  it("rejects conflicting static Authorization headers when OAuth is enabled", async () => {
    state.config = {
      mcpServers: {
        conflictauth: {
          transport: "http",
          url: "http://127.0.0.1:" + server!.port + "/mcp",
          oauth: true,
          headersFromEnv: { Authorization: "SUPERAGENT_TEST_REMOTE_MCP_AUTH" },
        },
      },
    };

    await initMcpServers();

    const connection = connectedServers.get("conflictauth");
    expect(connection?.status).toBe("error");
    expect(connection?.error).toContain("remove the Authorization entry");
    expect(connection?.tools).toEqual([]);
  });
});
