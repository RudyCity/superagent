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
    server = await startMcpHttpServer({
      port: 0,
      bearerToken: token,
      allowDangerous: false,
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

    await closeMcpServers();
    expect(connectedServers.size).toBe(0);
    expect(getToolByName("remotesmoke_superagent_server_health")).toBeUndefined();
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
