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

describe("Superagent Complete MCP Server Suite", () => {
  const testDir = path.join(os.tmpdir(), `superagent_mcp_test_${Date.now()}`);

  beforeEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  it("creates MCP server and lists all 30 tools", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    expect(handler).toBeDefined();

    const result = await handler({ method: "tools/list", params: {} });
    expect(result).toBeDefined();
    const toolNames = result.tools.map((t: any) => t.name);

    expect(toolNames).toContain("superagent_list_active");
    expect(toolNames).toContain("superagent_get_process_status");
    expect(toolNames).toContain("superagent_get_status");
    expect(toolNames).toContain("superagent_get_logs");
    expect(toolNames).toContain("superagent_send_message");
    expect(toolNames).toContain("superagent_interrupt");
    expect(toolNames).toContain("superagent_pause");
    expect(toolNames).toContain("superagent_resume");
    expect(toolNames).toContain("superagent_run_task");
    expect(toolNames).toContain("superagent_spawn_subagent");
    expect(toolNames).toContain("superagent_switch_workspace");
    expect(toolNames).toContain("superagent_get_workspace");
    expect(toolNames).toContain("superagent_exec_command");
    expect(toolNames).toContain("superagent_read_file");
    expect(toolNames).toContain("superagent_write_file");
    expect(toolNames).toContain("superagent_list_files");
    expect(toolNames).toContain("superagent_get_plan_and_tasks");
    expect(toolNames).toContain("superagent_update_tasks");
    expect(toolNames).toContain("superagent_get_config");
    expect(toolNames).toContain("superagent_switch_preset");
    expect(toolNames).toContain("superagent_switch_provider");
    expect(toolNames).toContain("superagent_memory_search");
    expect(toolNames).toContain("superagent_memory_save");
    expect(toolNames).toContain("superagent_query_history");
    expect(toolNames).toContain("superagent_get_token_usage");
    expect(toolNames).toContain("superagent_remote_chrome");
    expect(toolNames).toContain("superagent_invoke");
    expect(toolNames).toContain("superagent_await");
    expect(toolNames).toContain("superagent_merge");
    expect(toolNames).toContain("superagent_manage");
  });

  it("executes file operations and command execution via MCP", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const testFile = path.join(testDir, "hello.txt");

    // Write file
    const writeRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_write_file",
        arguments: { filePath: testFile, content: "Line 1: Hello MCP\nLine 2: Testing Superagent" },
      },
    });
    expect(writeRes.content[0].text).toContain("Successfully wrote");
    expect(fs.existsSync(testFile)).toBe(true);

    // Read file
    const readRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_read_file",
        arguments: { filePath: testFile, startLine: 1, endLine: 2 },
      },
    });
    expect(readRes.content[0].text).toContain("Line 1: Hello MCP");

    // List files
    const listRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_list_files",
        arguments: { dirPath: testDir },
      },
    });
    expect(listRes.content[0].text).toContain("hello.txt");

    // Exec command
    const cmdRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_exec_command",
        arguments: { command: "node -e \"console.log('MCP EXEC OK')\"", cwd: testDir },
      },
    });
    expect(cmdRes.content[0].text).toContain("MCP EXEC OK");
  });

  it("executes token usage and chrome bridge status via MCP", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    // Token usage
    const tokenRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_get_token_usage",
        arguments: {},
      },
    });
    expect(tokenRes.content[0].text).toContain("Superagent Context & Token Analytics");

    // Chrome remote status
    const chromeRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_remote_chrome",
        arguments: { action: "status" },
      },
    });
    expect(chromeRes.content[0].text).toContain("Remote Chrome Bridge Status");
  });
});
