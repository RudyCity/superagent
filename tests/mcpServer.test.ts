import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { createSuperagentMcpServer, MCP_TOOL_CLASSIFICATION } from "../src/core/mcp/superagentMcpServer.js";
import { getDefaultSafeTools } from "../src/core/mcp/mcpHttpTransport.js";
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

const EXPECTED_TOOL_COUNT = 58;

describe("Superagent Complete 3-Pillar MCP Server Suite (58 Tools, Resources, Prompts)", () => {
  const testDir = path.join(process.cwd(), `.tmp_mcp_test_${Date.now()}`);

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

    // Local agent execution/control tools are intentionally not exposed over MCP.
    expect(toolNames).not.toContain("superagent_interrupt");
    expect(toolNames).not.toContain("superagent_pause");
    expect(toolNames).not.toContain("superagent_resume");
    expect(toolNames).not.toContain("superagent_send_message");

    // Subagent & multi-agent
    expect(toolNames).not.toContain("superagent_run_task");
    expect(toolNames).not.toContain("superagent_spawn_subagent");
    expect(toolNames).not.toContain("superagent_cli_bridge");
    expect(toolNames).not.toContain("superagent_invoke");
    expect(toolNames).not.toContain("superagent_await");
    expect(toolNames).not.toContain("superagent_merge");
    expect(toolNames).not.toContain("superagent_manage");

    // Explicit remote operations are separately permission-gated tools.
    expect(toolNames).toContain("superagent_muse_tunnel_start");
    expect(toolNames).toContain("superagent_muse_tunnel_restart");
    expect(toolNames).toContain("superagent_telegram_send_to_muse");
    expect(toolNames).toContain("superagent_muse_chat_status");
    expect(toolNames).toContain("superagent_muse_chat");
    expect(toolNames).toContain("superagent_muse_chat");

    // Workspace & files
    expect(toolNames).toContain("superagent_switch_workspace");
    expect(toolNames).toContain("superagent_get_workspace");
    expect(toolNames).toContain("superagent_exec_command");
    expect(toolNames).toContain("superagent_read_file");
    expect(toolNames).toContain("superagent_write_file");
    expect(toolNames).toContain("superagent_unlock_file");
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
    expect(toolNames).toContain("superagent_get_remote_status");

    // Chrome CDP & Vision
    expect(toolNames).toContain("superagent_chrome_cdp");
    expect(toolNames).toContain("superagent_chrome_vision");
    expect(toolNames).toContain("superagent_list_running_chrome");
    expect(toolNames).toContain("superagent_close_chrome_profile");
    expect(toolNames).toContain("superagent_close_chrome_window");
    expect(toolNames).toContain("superagent_launch_chrome");
    expect(toolNames).toContain("superagent_list_chrome_profiles");

    // Diagnostics & Process/Port
    expect(toolNames).toContain("superagent_inspect_port");
    expect(toolNames).toContain("superagent_free_port");
    expect(toolNames).toContain("superagent_find_process");
    expect(toolNames).toContain("superagent_kill_process");

    // Planning & Skills & Mutation
    expect(toolNames).toContain("superagent_manage_plan");
    expect(toolNames).toContain("superagent_manage_tasks");
    expect(toolNames).toContain("superagent_get_skills");
    expect(toolNames).toContain("superagent_use_skill");
    expect(toolNames).toContain("superagent_synthesize_skill");
    expect(toolNames).toContain("superagent_replace_file_content");
    expect(toolNames).toContain("superagent_apply_patch");

    // Network & Content
    expect(toolNames).toContain("superagent_web_search");
    expect(toolNames).toContain("superagent_fetch_url");
    expect(toolNames).toContain("superagent_search_journal");
    expect(toolNames).toContain("superagent_read_document");
    expect(toolNames).toContain("superagent_office_cli");
    expect(toolNames).toContain("superagent_git_action");
  });

  it("requires dangerous opt-in for Muse tunnel and two-way chat tools", () => {
    const safeTools = getDefaultSafeTools();
    const remoteMutationTools = [
      "superagent_muse_tunnel_start",
      "superagent_muse_tunnel_restart",
      "superagent_telegram_send_to_muse",
      "superagent_muse_chat",
    ];

    for (const name of remoteMutationTools) {
      expect(MCP_TOOL_CLASSIFICATION[name]).toBe("dangerous");
      expect(safeTools).not.toContain(name);
    }

    expect(MCP_TOOL_CLASSIFICATION.superagent_muse_chat_status).toBe("safe");
    expect(safeTools).toContain("superagent_muse_chat_status");
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
    expect(uris).toContain("superagent://instructions/agentic-mcp");

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

    // Read agentic MCP instructions resource
    const instructionsRead = await readHandler({
      method: "resources/read",
      params: { uri: "superagent://instructions/agentic-mcp" },
    });
    expect(instructionsRead.contents[0].text).toContain("SUPERAGENT MCP AGENTIC INSTRUCTION PROTOCOL");
    expect(instructionsRead.contents[0].text).toContain("TOOL_FIRST");
  });

  it("lists and renders all 4 MCP Prompts", async () => {
    const server = createSuperagentMcpServer();
    const listHandler = (server as any)._requestHandlers.get(ListPromptsRequestSchema.shape.method.value);
    const getHandler = (server as any)._requestHandlers.get(GetPromptRequestSchema.shape.method.value);

    const listRes = await listHandler({ method: "prompts/list", params: {} });
    expect(listRes.prompts.length).toBe(4);
    const names = listRes.prompts.map((p: any) => p.name);
    expect(names).toContain("superagent_orchestrate");
    expect(names).toContain("superagent_debug");
    expect(names).toContain("superagent_review");
    expect(names).toContain("superagent_agentic_mcp");

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

    // Render agentic MCP prompt
    const agentic = await getHandler({
      method: "prompts/get",
      params: { name: "superagent_agentic_mcp", arguments: { task: "Fix authentication race condition" } },
    });
    expect(agentic.messages[0].content.text).toContain("AUTONOMOUS MCP AGENTIC EXECUTION MANDATE");
    expect(agentic.messages[0].content.text).toContain("Fix authentication race condition");
    expect(agentic.messages[0].content.text).toContain("TOOL_FIRST");
  });

  it("executes file, search, workspace, config, and health tools", async () => {
    const server = createSuperagentMcpServer({ workspace: testDir, allowDangerous: true });
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    // Write then read file
    const testFile = path.join(testDir, "test_calc.ts");
    const writeRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_write_file", arguments: { filePath: testFile, content: "export function add(a: number, b: number) { return a + b; }\n", cwd: testDir } },
    });
    expect(writeRes.content[0].text).toContain("test_calc.ts");

    const readRes = await callHandler({
      method: "tools/call",
      params: { name: "superagent_read_file", arguments: { filePath: testFile, cwd: testDir } },
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

  it("superagent_spawn_subagent is disabled and rejected on MCP server", async () => {
    const server = createSuperagentMcpServer();
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const res = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_spawn_subagent",
        arguments: { type: "researcher", prompt: "test" },
      },
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("disabled");
  });

  it("superagent_run_task is hidden and rejected even when dangerous tools are enabled", async () => {
    const server = createSuperagentMcpServer({ workspace: testDir, allowDangerous: true });
    const listHandler = (server as any)._requestHandlers.get(ListToolsRequestSchema.shape.method.value);
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const listResult = await listHandler({ method: "tools/list", params: {} });
    expect(listResult.tools.map((tool: any) => tool.name)).not.toContain("superagent_run_task");

    await expect(callHandler({
      method: "tools/call",
      params: { name: "superagent_run_task", arguments: { task: "should not execute" } },
    })).rejects.toThrow("disabled and not exposed by this MCP server");
  });

  it("superagent_unlock_file inspects status, unlocks, and force-unlocks file locks", async () => {
    const server = createSuperagentMcpServer({ workspace: testDir, allowDangerous: true });
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const testFile = path.join(testDir, "test_lock.txt");
    fs.writeFileSync(testFile, "Hello Concurrency", "utf-8");

    const { lockFile } = await import("../src/core/storage/sharedMemory.js");

    // 1. Initial status -> UNLOCKED
    const statusBefore = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_unlock_file",
        arguments: { filePath: testFile, action: "status" },
      },
    });
    expect(statusBefore.content[0].text).toContain("Status: UNLOCKED");

    // 2. Lock file by external session
    lockFile(testFile, "external-session-999", "tline", 60000, testDir);

    // 3. Status now -> LOCKED with details
    const statusLocked = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_unlock_file",
        arguments: { filePath: testFile, action: "status" },
      },
    });
    expect(statusLocked.content[0].text).toContain("Status: LOCKED");
    expect(statusLocked.content[0].text).toContain("Owner Session ID: external-session-999");

    // 4. Graceful unlock from another session without force -> rejected
    const gracefulUnlock = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_unlock_file",
        arguments: { filePath: testFile, action: "unlock" },
      },
    });
    expect(gracefulUnlock.isError).toBe(true);
    expect(gracefulUnlock.content[0].text).toContain("force_unlock");

    // 5. Force unlock with audit reason -> succeeds
    const forceUnlock = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_unlock_file",
        arguments: {
          filePath: testFile,
          action: "force_unlock",
          reason: "Emergency unlock for dead task",
        },
      },
    });
    expect(forceUnlock.isError).toBeUndefined();
    expect(forceUnlock.content[0].text).toContain("Forcibly unlocked");

    // 6. Verify now unlocked
    const statusAfter = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_unlock_file",
        arguments: { filePath: testFile, action: "status" },
      },
    });
    expect(statusAfter.content[0].text).toContain("Status: UNLOCKED");
  });

  it("auto-preempts conflicting locks during YOLO mode for write and mutation tools", async () => {
    const server = createSuperagentMcpServer({ workspace: testDir, allowDangerous: true });
    const callHandler = (server as any)._requestHandlers.get(CallToolRequestSchema.shape.method.value);

    const testFile = path.join(testDir, "test_preempt.txt");
    fs.writeFileSync(testFile, "initial text line", "utf-8");

    const { lockFile, releaseFile, checkFileLock } = await import("../src/core/storage/sharedMemory.js");
    const { setYoloMode, isYoloMode } = await import("../src/core/permissions.js");

    // Ensure YOLO is off initially
    setYoloMode(false);

    // Lock file by another session
    lockFile(testFile, "competing-session-123", "cli", 60000, testDir);

    // Write file while locked without YOLO -> blocked by lock conflict
    const writeBlocked = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_write_file",
        arguments: { filePath: testFile, content: "Blocked content", overwrite: true },
      },
    });
    expect(writeBlocked.isError).toBe(true);
    expect(writeBlocked.content[0].text).toContain("[LOCK_CONFLICT]");

    // Turn ON YOLO mode
    setYoloMode(true);
    expect(isYoloMode()).toBe(true);

    // Now write file -> auto-preempts lock and writes cleanly!
    const writeSuccess = await callHandler({
      method: "tools/call",
      params: {
        name: "superagent_write_file",
        arguments: { filePath: testFile, content: "YOLO auto-preempted content", overwrite: true },
      },
    });
    expect(writeSuccess.isError).toBeUndefined();
    expect(writeSuccess.content[0].text).toContain("Successfully wrote");
    expect(fs.readFileSync(testFile, "utf-8")).toBe("YOLO auto-preempted content");

    // Clean up YOLO mode
    setYoloMode(false);
    releaseFile(testFile, undefined, testDir, true);
  });
});
