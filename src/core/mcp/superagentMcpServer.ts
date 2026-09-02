/**
 * superagentMcpServer.ts — Complete, modular MCP Server for Superagent.
 *
 * Exposes full AI process inspection, live interruption/control, subagent delegation,
 * workspace switching, file tools, command execution, presets, task checklists,
 * persistent memory, token analytics, and remote browser control to external MCP clients.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { getSuperAgentVersion } from "../config/paths.js";
import {
  handleListActive,
  handleGetProcessStatus,
  handleInterrupt,
  handlePause,
  handleResume,
  handleGetLogs,
} from "./tools/processTools.js";
import {
  handleRunTask,
  handleSpawnSubagent,
  handleSendMessage,
  handleInvoke,
  handleAwait,
  handleMerge,
  handleManage,
  handleGetStatus,
} from "./tools/executionTools.js";
import {
  handleSwitchWorkspace,
  handleGetWorkspace,
  handleExecCommand,
  handleReadFile,
  handleWriteFile,
  handleListFiles,
  handleGetPlanAndTasks,
  handleUpdateTasks,
} from "./tools/workspaceTools.js";
import {
  handleGetConfig,
  handleSwitchPreset,
  handleSwitchProvider,
  handleMemorySearch,
  handleMemorySave,
  handleQueryHistory,
  handleGetTokenUsage,
  handleRemoteChrome,
} from "./tools/configTools.js";

const MCP_LOG_FILE = path.join(os.homedir(), ".superagent-r", "superagent-mcp.log");

function logMcp(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    const dir = path.dirname(MCP_LOG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(MCP_LOG_FILE, `[${timestamp}] ${message}\n`, "utf-8");
  } catch {}
}

export function createSuperagentMcpServer(): Server {
  const version = getSuperAgentVersion();
  const server = new Server(
    {
      name: "superagent-mcp-server",
      version: version || "1.5.24",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "superagent_list_active",
          description: "List all currently active Superagents, subagents, and background processes in Superagent.",
          inputSchema: { type: "object", properties: { includeCompleted: { type: "boolean" } } },
        },
        {
          name: "superagent_get_process_status",
          description: "Get real-time process details of Superagent AI: Master Agent status, iterations, thinking logs, tool streams, tokens, and child hierarchy.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "superagent_get_status",
          description: "Get detailed status, worktree paths, violation logs, acceptance criteria, and completion reports.",
          inputSchema: { type: "object", properties: { superagentIds: { type: "array", items: { type: "string" } } } },
        },
        {
          name: "superagent_get_logs",
          description: "Get recent execution logs from an active or completed Superagent, Subagent, or background task.",
          inputSchema: { type: "object", properties: { id: { type: "string" }, limit: { type: "number" } }, required: ["id"] },
        },
        {
          name: "superagent_send_message",
          description: "Send a follow-up instruction, message, feedback, or command to a running or paused Superagent (two-way communication).",
          inputSchema: { type: "object", properties: { superagentId: { type: "string" }, message: { type: "string" }, wait: { type: "boolean" } }, required: ["superagentId", "message"] },
        },
        {
          name: "superagent_interrupt",
          description: "Interrupt / abort AI processing immediately. Stops running loops and cleans up tasks safely.",
          inputSchema: { type: "object", properties: { target: { type: "string", enum: ["all", "master", "superagent", "subagent", "task"] }, id: { type: "string" } } },
        },
        {
          name: "superagent_pause",
          description: "Pause a running Superagent to halt execution until resumed.",
          inputSchema: { type: "object", properties: { superagentId: { type: "string" } }, required: ["superagentId"] },
        },
        {
          name: "superagent_resume",
          description: "Resume a paused Superagent with an optional new instruction/prompt.",
          inputSchema: { type: "object", properties: { superagentId: { type: "string" }, message: { type: "string" }, wait: { type: "boolean" } }, required: ["superagentId"] },
        },
        {
          name: "superagent_run_task",
          description: "Delegate a task to Superagent to execute as a powerful subagent for Antigravity, and return complete generated results and file modifications.",
          inputSchema: { type: "object", properties: { task: { type: "string" }, role: { type: "string" }, mode: { type: "string", enum: ["single", "multi"] }, workspace: { type: "string" } }, required: ["task"] },
        },
        {
          name: "superagent_spawn_subagent",
          description: "Directly launch a specialized atomic Subagent ('researcher', 'coder', 'reviewer', 'software-tester', 'chrome-agent') and get its report.",
          inputSchema: { type: "object", properties: { type: { type: "string" }, prompt: { type: "string" }, role: { type: "string" } }, required: ["type", "prompt"] },
        },
        {
          name: "superagent_switch_workspace",
          description: "Switch active working directory / workspace of Superagent.",
          inputSchema: { type: "object", properties: { workspacePath: { type: "string" } }, required: ["workspacePath"] },
        },
        {
          name: "superagent_get_workspace",
          description: "Get current workspace directory, active Git branch, and feature worktree information.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "superagent_exec_command",
          description: "Execute a shell command inside the active workspace or specific Superagent worktree with stdout/stderr capture.",
          inputSchema: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" }, timeoutMs: { type: "number" } }, required: ["command"] },
        },
        {
          name: "superagent_read_file",
          description: "Read the content of a file in the workspace or worktree with line range support.",
          inputSchema: { type: "object", properties: { filePath: { type: "string" }, startLine: { type: "number" }, endLine: { type: "number" }, cwd: { type: "string" } }, required: ["filePath"] },
        },
        {
          name: "superagent_write_file",
          description: "Write or create a file in the workspace or worktree with directory creation and overwrite guards.",
          inputSchema: { type: "object", properties: { filePath: { type: "string" }, content: { type: "string" }, overwrite: { type: "boolean" }, cwd: { type: "string" } }, required: ["filePath", "content"] },
        },
        {
          name: "superagent_list_files",
          description: "List files and directories in the workspace or a specific subfolder.",
          inputSchema: { type: "object", properties: { dirPath: { type: "string" } } },
        },
        {
          name: "superagent_get_plan_and_tasks",
          description: "Read the current implementation plan objective and task checklist.",
          inputSchema: { type: "object", properties: { workspace: { type: "string" } } },
        },
        {
          name: "superagent_update_tasks",
          description: "Update, check, or add items to the current task checklist.",
          inputSchema: { type: "object", properties: { action: { type: "string", enum: ["mark_completed", "mark_in_progress", "add_task", "get_status"] }, taskText: { type: "string" } }, required: ["action"] },
        },
        {
          name: "superagent_get_config",
          description: "Retrieve Superagent configuration: active provider, model presets, tier models, and system settings.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "superagent_switch_preset",
          description: "Switch the active model preset for Superagent.",
          inputSchema: { type: "object", properties: { presetId: { type: "string" }, mode: { type: "string", enum: ["single", "multi", "auto"] } }, required: ["presetId"] },
        },
        {
          name: "superagent_switch_provider",
          description: "Switch the active AI provider profile.",
          inputSchema: { type: "object", properties: { providerName: { type: "string" } }, required: ["providerName"] },
        },
        {
          name: "superagent_memory_search",
          description: "Search persistent knowledge, facts, and memories stored in Superagent.",
          inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
        },
        {
          name: "superagent_memory_save",
          description: "Save a snippet or knowledge fact into Superagent's persistent memory.",
          inputSchema: { type: "object", properties: { content: { type: "string" }, tag: { type: "string" } }, required: ["content"] },
        },
        {
          name: "superagent_query_history",
          description: "Search or retrieve conversation history, transcripts, and session records from SQLite.",
          inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list_sessions", "get_messages", "search"] }, query: { type: "string" }, sessionId: { type: "string" }, limit: { type: "number" } }, required: ["action"] },
        },
        {
          name: "superagent_get_token_usage",
          description: "Get comprehensive token consumption and context window analytics across tiers and sessions.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "superagent_remote_chrome",
          description: "Interact with remote Chrome browser extension bridge on port 9223 (check status, navigate, click, extract DOM).",
          inputSchema: { type: "object", properties: { action: { type: "string" }, target: { type: "string" }, value: { type: "string" } } },
        },
        {
          name: "superagent_invoke",
          description: "Spawn a new feature-level Superagent in an isolated Git worktree branch.",
          inputSchema: { type: "object", properties: { role: { type: "string" }, task: { type: "string" }, branch: { type: "string" }, wait: { type: "boolean" }, constraints: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } } }, required: ["role", "task"] },
        },
        {
          name: "superagent_await",
          description: "Wait for all active Superagents (or specific IDs) to finish.",
          inputSchema: { type: "object", properties: { timeoutSeconds: { type: "number" }, superagentIds: { type: "array", items: { type: "string" } } } },
        },
        {
          name: "superagent_merge",
          description: "Merge completed Superagent feature branches into main workspace with conflict resolution.",
          inputSchema: { type: "object", properties: { cleanupWorktrees: { type: "boolean" } } },
        },
        {
          name: "superagent_manage",
          description: "Manage Superagent lifecycle: check status, reports, violations, kill, or retry failed ones.",
          inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "status", "logs", "report", "violations", "kill", "kill_all", "retry_failed", "cleanup_orphans"] }, superagentIds: { type: "array", items: { type: "string" } } }, required: ["action"] },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    logMcp(`Handling tool call: ${name} with args: ${JSON.stringify(args)}`);

    try {
      switch (name) {
        case "superagent_list_active":
          return await handleListActive(args);
        case "superagent_get_process_status":
          return await handleGetProcessStatus();
        case "superagent_get_status":
          return await handleGetStatus(args);
        case "superagent_get_logs":
          return await handleGetLogs(args);
        case "superagent_send_message":
          return await handleSendMessage(args);
        case "superagent_interrupt":
          return await handleInterrupt(args);
        case "superagent_pause":
          return await handlePause(args);
        case "superagent_resume":
          return await handleResume(args);
        case "superagent_run_task":
          return await handleRunTask(args);
        case "superagent_spawn_subagent":
          return await handleSpawnSubagent(args);
        case "superagent_switch_workspace":
          return await handleSwitchWorkspace(args);
        case "superagent_get_workspace":
          return await handleGetWorkspace();
        case "superagent_exec_command":
          return await handleExecCommand(args);
        case "superagent_read_file":
          return await handleReadFile(args);
        case "superagent_write_file":
          return await handleWriteFile(args);
        case "superagent_list_files":
          return await handleListFiles(args);
        case "superagent_get_plan_and_tasks":
          return await handleGetPlanAndTasks(args);
        case "superagent_update_tasks":
          return await handleUpdateTasks(args);
        case "superagent_get_config":
          return await handleGetConfig();
        case "superagent_switch_preset":
          return await handleSwitchPreset(args);
        case "superagent_switch_provider":
          return await handleSwitchProvider(args);
        case "superagent_memory_search":
          return await handleMemorySearch(args);
        case "superagent_memory_save":
          return await handleMemorySave(args);
        case "superagent_query_history":
          return await handleQueryHistory(args);
        case "superagent_get_token_usage":
          return await handleGetTokenUsage();
        case "superagent_remote_chrome":
          return await handleRemoteChrome(args);
        case "superagent_invoke":
          return await handleInvoke(args);
        case "superagent_await":
          return await handleAwait(args);
        case "superagent_merge":
          return await handleMerge(args);
        case "superagent_manage":
          return await handleManage(args);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Tool '${name}' not recognized.`);
      }
    } catch (err: any) {
      logMcp(`Error executing tool ${name}: ${err?.stack || err?.message || String(err)}`);
      return {
        content: [{ type: "text", text: `Error executing ${name}: ${err?.message || String(err)}` }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startSuperagentMcpServer(): Promise<void> {
  logMcp("Starting Superagent MCP Server via stdio transport...");
  const server = createSuperagentMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logMcp("Superagent MCP Server connected and listening on stdio.");
}
