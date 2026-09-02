import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import { registerToAgyConfig } from "../src/core/mcp/mcpRegistration.js";
import {
  superagentInstances,
  subagentInstances,
  backgroundTasks,
} from "../src/core/tools/state.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

describe("Superagent MCP Server", () => {
  beforeEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
  });

  it("creates MCP server with tools capability", () => {
    const server = createSuperagentMcpServer();
    expect(server).toBeDefined();
  });

  it("lists all superagent MCP tools", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    expect(handler).toBeDefined();

    const result = await handler({ method: "tools/list", params: {} });
    expect(result).toBeDefined();
    expect(Array.isArray(result.tools)).toBe(true);

    const toolNames = result.tools.map((t: any) => t.name);
    expect(toolNames).toContain("superagent_list_active");
    expect(toolNames).toContain("superagent_get_status");
    expect(toolNames).toContain("superagent_get_logs");
    expect(toolNames).toContain("superagent_send_message");
    expect(toolNames).toContain("superagent_invoke");
    expect(toolNames).toContain("superagent_await");
    expect(toolNames).toContain("superagent_merge");
    expect(toolNames).toContain("superagent_manage");
    expect(toolNames).toContain("superagent_query_history");
  });

  it("executes superagent_list_active when empty", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);
    expect(handler).toBeDefined();

    const response = await handler({
      method: "tools/call",
      params: {
        name: "superagent_list_active",
        arguments: {},
      },
    });

    expect(response).toBeDefined();
    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toContain("Active Superagent Instances");
  });

  it("executes superagent_list_active with populated active instances", async () => {
    superagentInstances.set("test-super-1", {
      id: "test-super-1",
      role: "backend-engineer",
      task: "Implement authentication API",
      branch: "feat/auth",
      worktreePath: "/tmp/worktrees/feat-auth",
      agent: null,
      status: "running",
      logs: ["Starting task...", "Analyzing schema..."],
    });

    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const response = await handler({
      method: "tools/call",
      params: {
        name: "superagent_list_active",
        arguments: {},
      },
    });

    expect(response.content[0].text).toContain("test-super-1");
    expect(response.content[0].text).toContain("backend-engineer");
    expect(response.content[0].text).toContain("feat/auth");
  });

  it("executes superagent_get_logs for an instance", async () => {
    superagentInstances.set("test-super-logs", {
      id: "test-super-logs",
      role: "tester",
      task: "Run test suite",
      branch: "feat/tests",
      worktreePath: "/tmp/worktrees/feat-tests",
      agent: null,
      status: "completed",
      logs: ["Running unit tests...\n", "All 15 tests passed.\n"],
      result: "Testing complete.",
    });

    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const response = await handler({
      method: "tools/call",
      params: {
        name: "superagent_get_logs",
        arguments: { id: "test-super-logs", limit: 10 },
      },
    });

    expect(response.content[0].text).toContain("All 15 tests passed");
  });

  it("returns error for superagent_send_message when required args are missing", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const response = await handler({
      method: "tools/call",
      params: {
        name: "superagent_send_message",
        arguments: { superagentId: "test-1" }, // missing message
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Both 'superagentId' and 'message' are required");
  });

  it("executes superagent_query_history with list_sessions", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const response = await handler({
      method: "tools/call",
      params: {
        name: "superagent_query_history",
        arguments: { action: "list_sessions", limit: 5 },
      },
    });

    expect(response.content[0].type).toBe("text");
    expect(response.content[0].text).toBeDefined();
  });
});

describe("Antigravity MCP Registration", () => {
  it("registers superagent in Antigravity config correctly", () => {
    const res = registerToAgyConfig();
    expect(res.success).toBe(true);
    expect(fs.existsSync(res.configPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(res.configPath, "utf-8"));
    expect(content.mcpServers).toBeDefined();
    expect(content.mcpServers.superagent).toBeDefined();
    expect(content.mcpServers.superagent.command).toBe("node");
    expect(Array.isArray(content.mcpServers.superagent.args)).toBe(true);
    expect(content.mcpServers.superagent.args).toContain("--mcp");
  });
});
