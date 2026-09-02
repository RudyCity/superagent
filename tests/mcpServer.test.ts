import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createSuperagentMcpServer } from "../src/core/mcp/superagentMcpServer.js";
import {
  superagentInstances,
  subagentInstances,
} from "../src/core/tools/state.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

describe("Superagent Complete 35-Tool MCP Server Suite", () => {
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

  it("creates MCP server and lists all 35 tools", async () => {
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
    expect(toolNames).toContain("superagent_cli_bridge");
    expect(toolNames).toContain("superagent_switch_workspace");
    expect(toolNames).toContain("superagent_get_workspace");
    expect(toolNames).toContain("superagent_exec_command");
    expect(toolNames).toContain("superagent_read_file");
    expect(toolNames).toContain("superagent_write_file");
    expect(toolNames).toContain("superagent_list_files");
    expect(toolNames).toContain("superagent_grep_search");
    expect(toolNames).toContain("superagent_find_files");
    expect(toolNames).toContain("superagent_manage_worktrees");
    expect(toolNames).toContain("superagent_get_plan_and_tasks");
    expect(toolNames).toContain("superagent_update_tasks");
    expect(toolNames).toContain("superagent_get_config");
    expect(toolNames).toContain("superagent_switch_preset");
    expect(toolNames).toContain("superagent_switch_provider");
    expect(toolNames).toContain("superagent_memory_search");
    expect(toolNames).toContain("superagent_memory_save");
    expect(toolNames).toContain("superagent_query_history");
    expect(toolNames).toContain("superagent_export_session");
    expect(toolNames).toContain("superagent_get_token_usage");
    expect(toolNames).toContain("superagent_remote_chrome");
    expect(toolNames).toContain("superagent_invoke");
    expect(toolNames).toContain("superagent_await");
    expect(toolNames).toContain("superagent_merge");
    expect(toolNames).toContain("superagent_manage");
  });

  it("executes search, file finding, and worktree tools via MCP", async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const testFile = path.join(testDir, "search_sample.ts");
    fs.writeFileSync(testFile, "export function calculateMetricTotal() {\n  return 42;\n}\n", "utf-8");

    // Grep search
    const grepRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_grep_search",
        arguments: { query: "calculateMetricTotal", path: testDir },
      },
    });
    expect(grepRes.content[0].text).toContain("calculateMetricTotal");

    // Find files
    const findRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_find_files",
        arguments: { pattern: "*.ts", path: testDir },
      },
    });
    expect(findRes.content[0].text).toContain("search_sample.ts");

    // Worktrees list
    const wtRes = await handler({
      method: "tools/call",
      params: {
        name: "superagent_manage_worktrees",
        arguments: { action: "list" },
      },
    });
    expect(wtRes.content[0].text).toBeDefined();
  });
});
