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

describe("Superagent MCP Server Tool Suite", () => {
  beforeEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
  });

  it("creates MCP server and lists all extended tools", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    expect(handler).toBeDefined();

    const result = await handler({ method: "tools/list", params: {} });
    expect(result).toBeDefined();
    const toolNames = result.tools.map((t: any) => t.name);

    // Monitoring & Inspection
    expect(toolNames).toContain("superagent_list_active");
    expect(toolNames).toContain("superagent_get_process_status");
    expect(toolNames).toContain("superagent_get_status");
    expect(toolNames).toContain("superagent_get_logs");

    // Communication & Interruption
    expect(toolNames).toContain("superagent_send_message");
    expect(toolNames).toContain("superagent_interrupt");
    expect(toolNames).toContain("superagent_pause");
    expect(toolNames).toContain("superagent_resume");

    // Subagent Delegation & Orchestration
    expect(toolNames).toContain("superagent_run_task");
    expect(toolNames).toContain("superagent_spawn_subagent");
    expect(toolNames).toContain("superagent_invoke");
    expect(toolNames).toContain("superagent_await");
    expect(toolNames).toContain("superagent_merge");
    expect(toolNames).toContain("superagent_manage");

    // Workspace & Tasks
    expect(toolNames).toContain("superagent_switch_workspace");
    expect(toolNames).toContain("superagent_get_workspace");
    expect(toolNames).toContain("superagent_get_plan_and_tasks");
    expect(toolNames).toContain("superagent_update_tasks");

    // Config, Presets & Memory
    expect(toolNames).toContain("superagent_get_config");
    expect(toolNames).toContain("superagent_switch_preset");
    expect(toolNames).toContain("superagent_switch_provider");
    expect(toolNames).toContain("superagent_memory_search");
    expect(toolNames).toContain("superagent_memory_save");
    expect(toolNames).toContain("superagent_query_history");
  });

  it("executes superagent_get_process_status with live state", async () => {
    superagentInstances.set("super-proc-1", {
      id: "super-proc-1",
      role: "database-engineer",
      task: "Optimize query indices",
      branch: "feat/db-opt",
      worktreePath: "/tmp/worktrees/feat-db-opt",
      agent: null,
      status: "running",
      logs: ["Inspecting SQLite schema...\n", "Found 4 tables needing indexing.\n"],
    });

    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const response = await handler({
      method: "tools/call",
      params: {
        name: "superagent_get_process_status",
        arguments: {},
      },
    });

    expect(response.content[0].text).toContain("Real-time Superagent AI Process Status");
    expect(response.content[0].text).toContain("database-engineer");
    expect(response.content[0].text).toContain("feat/db-opt");
  });

  it("executes superagent_pause and superagent_interrupt", async () => {
    let aborted = false;
    superagentInstances.set("super-kill-1", {
      id: "super-kill-1",
      role: "tester",
      task: "Run tests",
      branch: "feat/tests",
      worktreePath: "/tmp/worktrees/feat-tests",
      agent: { abort: () => { aborted = true; } },
      status: "running",
      logs: ["Running test batch...\n"],
    });

    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    // Test pause
    const pauseRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_pause",
        arguments: { superagentId: "super-kill-1" },
      },
    });
    expect(pauseRes.content[0].text).toContain("has been paused");
    expect(superagentInstances.get("super-kill-1")?.status).toBe("paused");

    // Test interrupt
    const interruptRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_interrupt",
        arguments: { target: "superagent", id: "super-kill-1" },
      },
    });
    expect(interruptRes.content[0].text).toContain("Successfully interrupted");
    expect(superagentInstances.get("super-kill-1")?.status).toBe("terminated");
  });

  it("executes superagent_get_workspace and superagent_switch_workspace", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const wsRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_get_workspace",
        arguments: {},
      },
    });

    expect(wsRes.content[0].text).toContain("Current Workspace:");

    // Switch workspace to project root
    const switchRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_switch_workspace",
        arguments: { workspacePath: process.cwd() },
      },
    });

    expect(switchRes.content[0].text).toContain("Switched active Superagent workspace to");
  });

  it("executes superagent_get_config", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const configRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_get_config",
        arguments: {},
      },
    });

    expect(configRes.content[0].text).toContain("=== Superagent Configuration ===");
    expect(configRes.content[0].text).toContain("Active Provider:");
  });

  it("executes superagent_memory_save and superagent_memory_search", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const saveRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_memory_save",
        arguments: {
          content: "MCP Server integration test note for verification.",
          tag: "mcp-test",
        },
      },
    });

    expect(saveRes.content[0].text).toContain("Knowledge snippet saved");

    const searchRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_memory_search",
        arguments: {
          query: "MCP Server integration",
        },
      },
    });

    expect(searchRes.content[0].text).toContain("MCP Server integration test note");
  });
});
