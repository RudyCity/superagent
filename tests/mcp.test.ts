import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { loadModelConfig, saveModelConfig, clearModelConfigCache } from "../src/core/config/jsonConfig.js";
import { initMcpServers, closeMcpServers, connectedServers } from "../src/core/mcp/McpManager.js";
import { allTools } from "../src/core/tools/index.js";

// Mock the MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  return {
    Client: class {
      connect = vi.fn().mockResolvedValue(undefined);
      listTools = vi.fn().mockResolvedValue({
        tools: [
          {
            name: "echo",
            description: "Echoes back the input",
            inputSchema: {
              type: "object",
              properties: {
                message: { type: "string" }
              }
            }
          }
        ]
      });
      callTool = vi.fn().mockResolvedValue({
        content: [
          { type: "text", text: "hello world" }
        ]
      });
    }
  };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => {
  return {
    StdioClientTransport: class {
      close = vi.fn().mockResolvedValue(undefined);
    }
  };
});

describe("MCP Client Integration", () => {
  beforeEach(() => {
    clearModelConfigCache();
    const configDir = process.env.SUPERAGENT_CONFIG_DIR;
    if (configDir) {
      const configPath = path.join(configDir, "model-config.json");
      if (fs.existsSync(configPath)) {
        try { fs.unlinkSync(configPath); } catch {}
      }
    }
  });

  afterAll(async () => {
    await closeMcpServers();
  });

  it("should configure and initialize MCP servers", async () => {
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
});
