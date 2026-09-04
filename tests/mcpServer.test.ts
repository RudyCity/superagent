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
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const EXPECTED_TOOL_COUNT = 38;

describe("Superagent Complete 3-Pillar MCP Server Suite (38 Tools, Resources, Prompts)", () => {
  const testDir = path.join(os.tmpdir(), `superagent_mcp_test_${Date.now()}`);

  beforeEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    fs.mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    superagentInstances.clear();
    subagentInstances.clear();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
  });

  it(`lists all ${EXPECTED_TOOL_COUNT} MCP tools`, async () => {
    const server = createSuperagentMcpServer();
    const handler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const result = await handler({ method: "tools/list", params: {} });
    const toolNames = result.tools.map((t: any) => t.name);

    expect(result.tools.length).toBe(EXPECTED_TOOL_COUNT);

    // Process monitoring
    expect(toolNames).toContain("superagent_list_active");
    expect(toolNames).toContain("superagent_get_process_status");
    expect(toolNames).toContain("superagent_get_status");
    expect(toolNames).toContain("superagent_get_logs");

    // Execution control
    expect(toolNames).toContain("superagent_interrupt");
    expect(toolNames).toContain("superagent_pause");
    expect(toolNames).toContain("superagent_resume");
    expect(toolNames).toContain("superagent_send_message");

    // Subagent & multi-agent
    expect(toolNames).toContain("superagent_run_task");
    expect(toolNames).toContain("superagent_spawn_subagent");
    expect(toolNames).toContain("superagent_cli_bridge");
    expect(toolNames).toContain("superagent_invoke");
    expect(toolNames).toContain("superagent_await");
    expect(toolNames).toContain("superagent_merge");
    expect(toolNames).toContain("superagent_manage");

    // Workspace & files
    expect(toolNames).toContain("superagent_switch_workspace");
    expect(toolNames).toContain("superagent_get_workspace");
    expect(toolNames).toContain("superagent_exec_command");
    expect(toolNames).toContain("superagent_read_file");
    expect(toolNames).toContain("superagent_write_file");
    expect(toolNames).toContain("superagent_list_files");
    expect(toolNames).toContain("superagent_grep_search");
    expect(toolNames).toContain("superagent_find_files");
    expect(toolNames).toContain("superagent_manage_worktrees");

    // Plans & tasks
    expect(toolNames).toContain("superagent_get_current_task");
    expect(toolNames).toContain("superagent_get_plan_and_tasks");
    expect(toolNames).toContain("superagent_update_tasks");

    // Config & knowledge
    expect(toolNames).toContain("superagent_get_config");
    expect(toolNames).toContain("superagent_switch_preset");
    expect(toolNames).toContain("superagent_switch_provider");
    expect(toolNames).toContain("superagent_memory_search");
    expect(toolNames).toContain("superagent_memory_save");
    expect(toolNames).toContain("superagent_query_history");
    expect(toolNames).toContain("superagent_export_session");

    // Analytics & infra
    expect(toolNames).toContain("superagent_compact_context");
    expect(toolNames).toContain("superagent_get_token_usage");
    expect(toolNames).toContain("superagent_remote_chrome");
    expect(toolNames).toContain("superagent_server_health");
  });

  it("lists and reads all 5 MCP Resources", async () => {
    const server = createSuperagentMcpServer();
    const listHandler = (server as any)._requestHandlers.get(ListResourcesRequestSchema.shape.method.value);
    const readHandler = (server as any)._requestHandlers.get(ReadResourceRequestSchema.shape.method.value);

    const listRes = await listHandler({ method: "resources/list", params: {} });
    expect(listRes.resources.length).toBeGreaterThanOrEqual(5);

    const uris = listRes.resources.map((r: any) => r.uri);
    expect(uris).toContain("superagent://status/live");
    expect(uris).toContain("superagent://config/current");
    expect(uris).toContain("superagent://workspace/info");
    expect(uris).toContain("superagent://history/sessions");
    expect(uris).toContain("superagent://memory/pinned");

    // Read live status
    const statusRead = await readHandler({
      method: "resources/read",
      params: { uri: "superagent://status/live" },
    });
    const parsed = JSON.parse(statusRead.contents[0].text);
    expect(parsed).toHaveProperty("masterAgent");
    expect(parsed).toHaveProperty("superagents");
    expect(parsed).toHaveProperty("timestamp");

    // Read config
    const configRead = await readHandler({
      method: "resources/read",
      params: { uri: "superagent://config/current" },
    });
    const config = JSON.parse(configRead.contents[0].text);
    expect(config).toHaveProperty("settings");
  });

  it("lists and renders all 3 MCP Prompts", async () => {
    const server = createSuperagentMcpServer();
    const listHandler = (server as any)._requestHandlers.get(ListPromptsRequestSchema.shape.method.value);
    const getHandler = (server as any)._requestHandlers.get(GetPromptRequestSchema.shape.method.value);

    const listRes = await listHandler({ method: "prompts/list", params: {} });
    expect(listRes.prompts.length).toBe(3);
    const names = listRes.prompts.map((p: any) => p.name);
    expect(names).toContain("superagent_orchestrate");
    expect(names).toContain("superagent_debug");
    expect(names).toContain("superagent_review");

    // Render orchestrate prompt
    const orchestrate = await getHandler({
      method: "prompts/get",
      params: { name: "superagent_orchestrate", arguments: { feature: "WebSocket Streaming", acceptanceCriteria: "Latency < 50ms" } },
    });
    expect(orchestrate.messages[0].content.text).toContain("WebSocket Streaming");

    // Render debug prompt
    const debug = await getHandler({
      method: "prompts/get",
      params: { name: "superagent_debug", arguments: { error: "TypeError: Cannot read properties of undefined" } },
    });
    expect(debug.messages[0].content.text).toContain("TypeError");

    // Render review prompt
    const review = await getHandler({
      method: "prompts/get",
      params: { name: "superagent_review", arguments: { targetBranch: "feat/websocket-streaming" } },
    });
    expect(review.messages[0].content.text).toContain("feat/websocket-streaming");
  });

  it("executes file, search, workspace, config, and health tools", async () => {
    const server = createSuperagentMcpServer();
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    // Write then read file
    const testFile = path.join(testDir, "test_calc.ts");
    const writeRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_write_file", arguments: { filePath: testFile, content: "export function add(a: number, b: number) { return a + b; }\n" } },
    });
    expect(writeRes.content[0].text).toContain("test_calc.ts");

    const readRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_read_file", arguments: { filePath: testFile } },
    });
    expect(readRes.content[0].text).toContain("add");

    // Grep search
    const grepRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_grep_search", arguments: { query: "add", path: testDir } },
    });
    expect(grepRes.content[0].text).toContain("add");

    // Config
    const configRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_get_config", arguments: {} },
    });
    expect(configRes.content[0].text).toContain("Superagent Configuration");

    // Token usage
    const tokenRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_get_token_usage", arguments: {} },
    });
    expect(tokenRes.content[0].text).toContain("Token Analytics");

    // Compact context
    const compactRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_compact_context", arguments: { strategy: "summarization", maxTokens: 8000 } },
    });
    expect(compactRes.content[0].text).toContain("Context Compaction");

    // Server health
    const healthRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_server_health", arguments: {} },
    });
    expect(healthRes.content[0].text).toContain("Superagent Server Health");

    // Query history - list sessions
    const historyRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_query_history", arguments: { action: "list_sessions", limit: 5 } },
    });
    expect(historyRes.content[0].text).toBeDefined();
    expect(historyRes.isError).toBeFalsy();

    // Memory save then search
    const saveRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_memory_save", arguments: { content: "MCP test memory entry for unit test", tag: "test" } },
    });
    expect(saveRes.content[0].text).toContain("saved");

    const searchRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_memory_search", arguments: { query: "MCP test memory" } },
    });
    expect(searchRes.content[0].text).toContain("MCP test memory");
  });

  it("reads plan and tasks via workspace path and via superagentId", async () => {
    const server = createSuperagentMcpServer();
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    // Create a mock instance worktree directory with plan and task files
    const instanceWorktree = path.join(testDir, "mock_worktree_feature_x");
    fs.mkdirSync(instanceWorktree, { recursive: true });
    fs.writeFileSync(path.join(instanceWorktree, "plan.md"), "# Feature X Implementation Plan\nProposed changes for feature X.");
    fs.writeFileSync(path.join(instanceWorktree, "task.md"), "- [x] Setup database\n- [/] Implement backend API\n- [ ] Add unit tests");

    // 1. Read via explicit workspace path
    const resByWorkspace = await callHandler({
      method: "tools/call",
      params: { name: "superagent_get_plan_and_tasks", arguments: { workspace: instanceWorktree } },
    });
    expect(resByWorkspace.content[0].text).toContain("Feature X Implementation Plan");
    expect(resByWorkspace.content[0].text).toContain("[x] Setup database");
    expect(resByWorkspace.content[0].text).toContain("[/] Implement backend API");
    expect(resByWorkspace.content[0].text).toContain("[ ] Add unit tests");

    // 2. Read via superagentId from superagentInstances map
    superagentInstances.set("test-instance-123", {
      id: "test-instance-123",
      role: "coder",
      branch: "feature-x",
      worktreePath: instanceWorktree,
      status: "running",
      task: "Implement feature X",
      logs: [],
    } as any);

    const resById = await callHandler({
      method: "tools/call",
      params: { name: "superagent_get_plan_and_tasks", arguments: { superagentId: "test-instance-123" } },
    });
    expect(resById.content[0].text).toContain("Feature X Implementation Plan");
    expect(resById.content[0].text).toContain("[x] Setup database");
    expect(resById.content[0].text).toContain("[Instance: test-instance-123]");

    // 3. Error when non-existent superagentId is passed
    const resNotFound = await callHandler({
      method: "tools/call",
      params: { name: "superagent_get_plan_and_tasks", arguments: { superagentId: "non-existent-agent" } },
    });
    expect(resNotFound.isError).toBe(true);
    expect(resNotFound.content[0].text).toContain("No active or registered worktree found");

    // 4. Update tasks via superagentId
    const resUpdate = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_update_tasks",
        arguments: {
          superagentId: "test-instance-123",
          action: "get_status",
        },
      },
    });
    expect(resUpdate.content[0].text).toBeDefined();

    // 5. Error updating tasks with non-existent superagentId
    const resUpdateNotFound = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_update_tasks",
        arguments: {
          superagentId: "non-existent-agent",
          action: "get_status",
        },
      },
    });
    expect(resUpdateNotFound.isError).toBe(true);
    expect(resUpdateNotFound.content[0].text).toContain("was not found in active instances or worktree registry");
  });
});
