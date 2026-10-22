import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Vitest hoists these mocks before the dynamic imports below.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined);
    setNotificationHandler = vi.fn();
    listTools = vi.fn().mockResolvedValue({
      tools: [{
        name: "echo",
        description: "Echoes back the input",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
        },
      }],
    });
    callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "hello world" }],
    });
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

const { loadModelConfig, saveModelConfig, clearModelConfigCache } = await import("../src/core/config/jsonConfig.js");
const { initMcpServers, closeMcpServers, connectedServers, withTimeout } = await import("../src/core/mcp/McpManager.js");


describe("MCP Client Integration", () => {
  const originalEnv = process.env;
  const tempConfigDir = path.join(os.tmpdir(), `superagent-mcp-test-${process.pid}`);

  beforeAll(async () => {
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: tempConfigDir };
    fs.mkdirSync(tempConfigDir, { recursive: true });
  });

  afterAll(async () => {
    await closeMcpServers();
    process.env = originalEnv;
    fs.rmSync(tempConfigDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    clearModelConfigCache();
    const configPath = path.join(tempConfigDir, "model-config.json");
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  });

  it("should configure and initialize MCP servers", async () => {
    const { allTools } = await import("../src/core/tools/index.js");
    // 1. Setup config with an MCP server
    const config = loadModelConfig();
    config.mcpServers = {
      testserver: {
        command: "node",
        args: ["dummy.js"],
        env: { SOME_VAR: "value" }
      }
    };
    saveModelConfig(config);

    // 2. Initialize servers
    await initMcpServers();

    // 3. Verify server connection status
    const server = connectedServers.get("testserver");
    expect(server).toBeDefined();
    expect(server?.status).toBe("connected");
    expect(server?.tools).toContain("testserver_echo");

    // 4. Verify tool registration
    const tool = allTools.find(t => t.name === "testserver_echo");
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("Echoes back the input");

    // Test execute function
    const executionResult = await tool?.execute({ message: "hello" }, process.cwd());
    expect(executionResult).toBe("hello world");

    // 5. Cleanup and verify removal
    await closeMcpServers();
    expect(connectedServers.size).toBe(0);
    expect(allTools.find(t => t.name === "testserver_echo")).toBeUndefined();
  });

  it("should manage MCP servers using manage_mcp tool", async () => {
    const { allTools } = await import("../src/core/tools/index.js");
    const manageTool = allTools.find(t => t.name === "manage_mcp");
    expect(manageTool).toBeDefined();

    // 1. Add server via tool
    const addResult = await manageTool?.execute({
      action: "add",
      name: "toolserver",
      command: "node",
      args: ["test.js"]
    }, process.cwd());
    expect(addResult).toContain("Successfully added and connected MCP server");

    // 2. List servers via tool
    const listResult = await manageTool?.execute({ action: "list" }, process.cwd());
    expect(listResult).toContain("Configured MCP Servers");
    expect(listResult).toContain("toolserver");

    // 3. Remove server via tool
    const removeResult = await manageTool?.execute({
      action: "remove",
      name: "toolserver"
    }, process.cwd());
    expect(removeResult).toContain("Successfully removed MCP server");

    // 4. List after removal
    const listAfterRemove = await manageTool?.execute({ action: "list" }, process.cwd());
    expect(listAfterRemove).toBe("No MCP servers configured.");
  });

  it("should enforce withTimeout correctly to prevent terminal hangs", async () => {
    // 1. Fast promise resolves
    const fast = withTimeout(Promise.resolve("ok"), 50, "timed out");
    await expect(fast).resolves.toBe("ok");

    // 2. Slow promise times out cleanly without hanging
    const slow = withTimeout(
      new Promise((resolve) => setTimeout(() => resolve("late"), 200)),
      50,
      "MCP operation timed out after 50ms"
    );
    await expect(slow).rejects.toThrow("MCP operation timed out after 50ms");
  });
});

