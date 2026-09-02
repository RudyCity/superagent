/**
 * superagentMcpServer.ts — Comprehensive MCP Server implementation for Superagent.
 *
 * Exposes full Superagent inspection, monitoring, bidirectional communication,
 * live interruption/control, subagent delegation, workspace switching, presets,
 * plan/task checklist management, and persistent memory to external MCP clients (Antigravity/AGY, Claude, Cursor).
 */

import fs from "fs";
import path from "path";
import os from "os";
import http from "http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { getRootConfigDir, getSuperAgentVersion } from "../config/paths.js";
import { loadRegistry, reconcileRegistry } from "../tools/superagentRegistry.js";
import {
  superagentInstances,
  subagentInstances,
  backgroundTasks,
  activeToolOutput,
  masterAgentRef,
  masterPromptTokens,
  masterCompletionTokens,
  lastMasterPromptTokens,
} from "../tools/state.js";
import {
  listSessionsFromDb,
  loadSessionFromDb,
  searchMessagesInDb,
  savePinnedKnowledgeToDb,
  getAllPinnedKnowledgeFromDb,
} from "../storage/historyDb.js";
import {
  getSettings,
  getPresets,
  getActivePresetId,
  setActivePresetId,
  applyModelPreset,
  switchActiveProvider,
  getActiveProviderName,
  getConfiguredProviders,
  getEffectiveMasterModel,
  getAllTierModels,
  addTrustedDirectory,
  ensureDirectoryTrusted,
} from "../config.js";
import { killProcessTree } from "../tools/shellTools.js";

const MCP_LOG_FILE = path.join(os.homedir(), ".superagent-r", "superagent-mcp.log");

function logMcp(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    const dir = path.dirname(MCP_LOG_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(MCP_LOG_FILE, `[${timestamp}] ${message}\n`, "utf-8");
  } catch {}
}

export interface ServerInfo {
  port: number;
  pid: number;
  authToken?: string;
  startedAt?: number;
}

export function getServerInfo(): ServerInfo | null {
  try {
    const infoPath = path.join(getRootConfigDir(), "server-info.json");
    if (!fs.existsSync(infoPath)) return null;
    const raw = fs.readFileSync(infoPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.port === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query the running Superagent HTTP API server if available.
 */
async function callServerApi(
  apiPath: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: any,
  timeoutMs: number = 5000
): Promise<{ success: boolean; status?: number; data?: any; error?: string }> {
  const info = getServerInfo();
  const port = info?.port || 7888;
  const token = info?.authToken || "";

  return new Promise((resolve) => {
    const postData = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: apiPath,
        method,
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "x-auth-token": token, Authorization: `Bearer ${token}` } : {}),
          ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            const parsed = raw ? JSON.parse(raw) : null;
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ success: true, status: res.statusCode, data: parsed });
            } else {
              resolve({
                success: false,
                status: res.statusCode,
                error: parsed?.error || `Server responded with status ${res.statusCode}`,
                data: parsed,
              });
            }
          } catch {
            resolve({
              success: res.statusCode ? res.statusCode >= 200 && res.statusCode < 300 : false,
              status: res.statusCode,
              data: raw,
            });
          }
        });
      }
    );

    req.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: `Request to ${apiPath} timed out after ${timeoutMs}ms` });
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Format a list of active Superagents, subagents, and background tasks.
 */
async function listActiveInstances(): Promise<{ formatted: string; data: any }> {
  const serverRes = await callServerApi("/api/instances", "GET");
  if (serverRes.success && serverRes.data) {
    const { superagents = [], subagents = [], procs = [] } = serverRes.data;
    const lines: string[] = ["Active Superagent Instances (via Running Server):"];
    if (superagents.length === 0) {
      lines.push("  Superagents: None");
    } else {
      lines.push("  Superagents:");
      for (const s of superagents) {
        lines.push(`    - ID: ${s.id} | Role: ${s.role} | Status: ${s.status} | Task: ${s.prompt || "(none)"}`);
        if (s.result) {
          const snip = s.result.length > 120 ? s.result.slice(0, 120) + "..." : s.result;
          lines.push(`      Report: ${snip}`);
        }
      }
    }

    if (subagents.length > 0) {
      lines.push("\n  Subagents:");
      for (const sub of subagents) {
        lines.push(`    - ID: ${sub.id} | Type: ${sub.typeName} | Role: ${sub.role} | Status: ${sub.status}`);
      }
    }

    if (procs.length > 0) {
      lines.push("\n  Background Tasks:");
      for (const p of procs) {
        lines.push(`    - ID: ${p.id} | PID: ${p.pid} | Command: ${p.commandLine} | Status: ${p.status}`);
      }
    }

    return {
      formatted: lines.join("\n"),
      data: serverRes.data,
    };
  }

  // Fallback to local state / persisted registry
  reconcileRegistry(superagentInstances);
  const registryEntries = loadRegistry();

  const superagentList: any[] = [];
  for (const [id, inst] of superagentInstances.entries()) {
    superagentList.push({
      id,
      role: inst.role,
      branch: inst.branch,
      worktreePath: inst.worktreePath,
      status: inst.status,
      task: inst.task,
      result: inst.result,
      violations: inst.violations || [],
      completedAt: inst.completedAt,
    });
  }

  for (const entry of registryEntries) {
    if (!superagentList.some((s) => s.id === entry.id)) {
      superagentList.push({
        id: entry.id,
        role: entry.role,
        branch: entry.branch,
        worktreePath: entry.worktreePath,
        status: entry.status,
        task: "",
        result: "",
        violations: [],
      });
    }
  }

  const subagentList: any[] = [];
  for (const [id, inst] of subagentInstances.entries()) {
    subagentList.push({
      id,
      typeName: inst.typeName,
      role: inst.role,
      status: inst.status,
      prompt: inst.prompt,
      result: inst.result,
      completedAt: inst.completedAt,
    });
  }

  const taskList: any[] = [];
  for (const [id, task] of backgroundTasks.entries()) {
    if (!task.isHidden) {
      taskList.push({
        id: task.id,
        pid: task.process?.pid || 0,
        command: task.command,
        hasExited: !!task.hasExited,
        exitCode: task.exitCode,
      });
    }
  }

  const lines: string[] = ["Active Superagent Instances (Local State):"];
  if (superagentList.length === 0) {
    lines.push("  Superagents: None");
  } else {
    lines.push("  Superagents:");
    for (const s of superagentList) {
      lines.push(`    - ID: ${s.id} | Role: ${s.role} | Branch: ${s.branch} | Status: ${s.status}${s.task ? ` | Task: ${s.task}` : ""}`);
      if (s.violations && s.violations.length > 0) {
        lines.push(`      Violations: ${s.violations.length}`);
      }
      if (s.result) {
        const snip = s.result.length > 120 ? s.result.slice(0, 120) + "..." : s.result;
        lines.push(`      Report: ${snip}`);
      }
    }
  }

  if (subagentList.length > 0) {
    lines.push("\n  Subagents:");
    for (const sub of subagentList) {
      lines.push(`    - ID: ${sub.id} | Type: ${sub.typeName} | Role: ${sub.role} | Status: ${sub.status}`);
    }
  }

  if (taskList.length > 0) {
    lines.push("\n  Background Tasks:");
    for (const t of taskList) {
      lines.push(`    - ID: ${t.id} | PID: ${t.pid} | Command: ${t.command} | Exited: ${t.hasExited}`);
    }
  }

  return {
    formatted: lines.join("\n"),
    data: {
      superagents: superagentList,
      subagents: subagentList,
      tasks: taskList,
    },
  };
}

/**
 * Creates and configures the Superagent MCP Server instance.
 */
export function createSuperagentMcpServer(): Server {
  const version = getSuperAgentVersion();
  const server = new Server(
    {
      name: "superagent-mcp-server",
      version: version || "1.5.22",
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
          description:
            "List all currently active Superagents, subagents, and background processes in Superagent. Returns instance IDs, roles, branches, status, task descriptions, worktree locations, and recent summaries.",
          inputSchema: {
            type: "object",
            properties: {
              includeCompleted: {
                type: "boolean",
                description: "Whether to include completed or terminated instances (defaults to true)",
              },
            },
          },
        },
        {
          name: "superagent_get_process_status",
          description:
            "Get deep real-time process details of Superagent AI execution: Master Agent status, active loop iterations, active thinking/reasoning stages, active tool outputs, token usage, subagent hierarchy, and background processes.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "superagent_get_status",
          description:
            "Get detailed status, worktree paths, violation records, acceptance criteria, constraints, and completion reports for specific Superagents or all active instances.",
          inputSchema: {
            type: "object",
            properties: {
              superagentIds: {
                type: "array",
                items: { type: "string" },
                description: "List of Superagent IDs to inspect (optional, returns all if omitted)",
              },
            },
          },
        },
        {
          name: "superagent_get_logs",
          description:
            "Get recent execution logs and console outputs from an active or completed Superagent or Subagent by ID.",
          inputSchema: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "The Superagent ID, Subagent ID, or Background Task ID",
              },
              limit: {
                type: "number",
                description: "Maximum number of recent log lines to retrieve (default: 50)",
              },
            },
            required: ["id"],
          },
        },
        {
          name: "superagent_send_message",
          description:
            "Send a follow-up instruction, message, feedback, or command to a running or paused Superagent (enables two-way communication between Antigravity/AGY and Superagent). Automatically resumes paused Superagents.",
          inputSchema: {
            type: "object",
            properties: {
              superagentId: {
                type: "string",
                description: "The ID of the target Superagent",
              },
              message: {
                type: "string",
                description: "The follow-up message, instruction, or clarification to send",
              },
              wait: {
                type: "boolean",
                description:
                  "Whether to wait synchronously for the Superagent to finish processing and return its report (default: false)",
              },
            },
            required: ["superagentId", "message"],
          },
        },
        {
          name: "superagent_interrupt",
          description:
            "Interrupt / abort the AI processing immediately. Stops running agent loops, terminates background tasks, and cleans up execution safely.",
          inputSchema: {
            type: "object",
            properties: {
              target: {
                type: "string",
                enum: ["all", "master", "superagent", "subagent", "task"],
                description: "Target to interrupt: 'all' (stops everything), 'master', 'superagent', 'subagent', or 'task'",
              },
              id: {
                type: "string",
                description: "Specific instance ID or background task ID to interrupt (optional if target is 'all')",
              },
            },
          },
        },
        {
          name: "superagent_pause",
          description: "Pause a running Superagent to halt execution until resumed.",
          inputSchema: {
            type: "object",
            properties: {
              superagentId: {
                type: "string",
                description: "The ID of the Superagent to pause",
              },
            },
            required: ["superagentId"],
          },
        },
        {
          name: "superagent_resume",
          description: "Resume a paused Superagent with an optional new instruction/prompt.",
          inputSchema: {
            type: "object",
            properties: {
              superagentId: {
                type: "string",
                description: "The ID of the paused Superagent to resume",
              },
              message: {
                type: "string",
                description: "Optional instruction or guidance to provide upon resuming",
              },
              wait: {
                type: "boolean",
                description: "Whether to wait synchronously for completion",
              },
            },
            required: ["superagentId"],
          },
        },
        {
          name: "superagent_run_task",
          description:
            "Delegate a task to Superagent to execute as a powerful subagent for Antigravity, and return the complete generated result, tool executions, and file modifications.",
          inputSchema: {
            type: "object",
            properties: {
              task: {
                type: "string",
                description: "The task prompt or instruction to execute",
              },
              role: {
                type: "string",
                description: "Optional role/job title (e.g. 'fullstack-engineer', 'bug-investigator')",
              },
              mode: {
                type: "string",
                enum: ["single", "multi"],
                description: "Execution mode: 'single' (direct development) or 'multi' (Master orchestrator)",
              },
              workspace: {
                type: "string",
                description: "Target workspace path (defaults to current working directory)",
              },
            },
            required: ["task"],
          },
        },
        {
          name: "superagent_spawn_subagent",
          description:
            "Directly launch a specialized atomic Subagent (e.g. 'researcher', 'coder', 'reviewer', 'software-tester', 'chrome-agent') and get its report.",
          inputSchema: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "The subagent type name (e.g. 'researcher', 'coder', 'reviewer', 'software-tester', 'chrome-agent')",
              },
              prompt: {
                type: "string",
                description: "The atomic task instruction for the subagent",
              },
              role: {
                type: "string",
                description: "Optional human-readable role name",
              },
            },
            required: ["type", "prompt"],
          },
        },
        {
          name: "superagent_switch_workspace",
          description: "Switch the active working directory/workspace of Superagent.",
          inputSchema: {
            type: "object",
            properties: {
              workspacePath: {
                type: "string",
                description: "Absolute or relative path to the new target workspace",
              },
            },
            required: ["workspacePath"],
          },
        },
        {
          name: "superagent_get_workspace",
          description: "Get current workspace directory, active git branch, and worktree information.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "superagent_get_plan_and_tasks",
          description: "Read the current implementation plan objective and task checklist.",
          inputSchema: {
            type: "object",
            properties: {
              workspace: {
                type: "string",
                description: "Optional workspace directory (defaults to current)",
              },
            },
          },
        },
        {
          name: "superagent_update_tasks",
          description: "Update or modify items in the current task checklist.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["mark_completed", "mark_in_progress", "add_task", "get_status"],
                description: "Checklist action to perform",
              },
              taskText: {
                type: "string",
                description: "The text/description of the task to update or add",
              },
            },
            required: ["action"],
          },
        },
        {
          name: "superagent_get_config",
          description: "Retrieve Superagent configuration: active provider, model presets, tier models, and settings.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "superagent_switch_preset",
          description: "Switch the active model preset for Superagent.",
          inputSchema: {
            type: "object",
            properties: {
              presetId: {
                type: "string",
                description: "The preset ID or name to activate (e.g. 'qwen3.8-27b', 'openrouter', 'claude-3.5-sonnet')",
              },
              mode: {
                type: "string",
                enum: ["single", "multi", "auto"],
                description: "Target mode (defaults to 'single')",
              },
            },
            required: ["presetId"],
          },
        },
        {
          name: "superagent_switch_provider",
          description: "Switch the active AI provider.",
          inputSchema: {
            type: "object",
            properties: {
              providerName: {
                type: "string",
                description: "The provider profile ID or name to switch to",
              },
            },
            required: ["providerName"],
          },
        },
        {
          name: "superagent_memory_search",
          description: "Search persistent knowledge, facts, and memories stored in Superagent.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The search query to look up in persistent memory",
              },
              limit: {
                type: "number",
                description: "Max results to return (default: 10)",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "superagent_memory_save",
          description: "Save a snippet or knowledge fact into Superagent's persistent memory.",
          inputSchema: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "The memory content or fact to save",
              },
              tag: {
                type: "string",
                description: "Optional category tag for indexing",
              },
            },
            required: ["content"],
          },
        },
        {
          name: "superagent_invoke",
          description:
            "Spawn a new feature-level Superagent in an isolated Git worktree branch to work on a task in parallel.",
          inputSchema: {
            type: "object",
            properties: {
              role: {
                type: "string",
                description: "Descriptive role for the Superagent (e.g., 'ui-dev', 'database-optimizer', 'auth-reviewer')",
              },
              task: {
                type: "string",
                description: "Detailed prompt / task instructions for the Superagent to execute",
              },
              branch: {
                type: "string",
                description: "Git branch name for the isolated worktree (auto-generated if omitted)",
              },
              wait: {
                type: "boolean",
                description: "Whether to wait synchronously for completion before returning (default: false)",
              },
              constraints: {
                type: "string",
                description: "Optional task constraints to enforce",
              },
              acceptanceCriteria: {
                type: "array",
                items: { type: "string" },
                description: "Optional acceptance criteria checklist",
              },
            },
            required: ["role", "task"],
          },
        },
        {
          name: "superagent_await",
          description:
            "Wait for all active Superagents (or specific Superagent IDs) to complete their execution and return their final reports.",
          inputSchema: {
            type: "object",
            properties: {
              timeoutSeconds: {
                type: "number",
                description: "Maximum seconds to wait before timing out (default: 600)",
              },
              superagentIds: {
                type: "array",
                items: { type: "string" },
                description: "Optional specific list of Superagent IDs to wait for",
              },
            },
          },
        },
        {
          name: "superagent_merge",
          description:
            "Merge completed Superagent feature branches into the main workspace branch with automatic LLM conflict resolution.",
          inputSchema: {
            type: "object",
            properties: {
              cleanupWorktrees: {
                type: "boolean",
                description: "Whether to remove the isolated worktree folders after successful merge (default: true)",
              },
            },
          },
        },
        {
          name: "superagent_manage",
          description:
            "Manage Superagent lifecycle: check status, retrieve reports, inspect violations, kill running agents, or retry failed ones.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: [
                  "list",
                  "status",
                  "logs",
                  "report",
                  "violations",
                  "kill",
                  "kill_all",
                  "retry_failed",
                  "cleanup_orphans",
                ],
                description: "Action to perform on Superagents",
              },
              superagentIds: {
                type: "array",
                items: { type: "string" },
                description: "List of Superagent IDs to operate on",
              },
            },
            required: ["action"],
          },
        },
        {
          name: "superagent_query_history",
          description:
            "Search or retrieve conversation history, chat transcripts, and session metadata from the Superagent SQLite database.",
          inputSchema: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["list_sessions", "get_messages", "search"],
                description: "History operation to perform",
              },
              query: {
                type: "string",
                description: "Search keyword or query string for full-text search",
              },
              sessionId: {
                type: "string",
                description: "Specific session ID to fetch messages from",
              },
              limit: {
                type: "number",
                description: "Max results to return (default: 20)",
              },
            },
            required: ["action"],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    logMcp(`Handling tool call: ${name} with args: ${JSON.stringify(args)}`);

    try {
      switch (name) {
        case "superagent_list_active": {
          const result = await listActiveInstances();
          return {
            content: [{ type: "text", text: result.formatted }],
          };
        }

        case "superagent_get_process_status": {
          const isMasterRunning = masterAgentRef ? (masterAgentRef.isAgentRunning?.() ?? false) : false;
          const activeSuperagents = [...superagentInstances.values()].filter((i) => i.status === "running" || i.status === "waiting");
          const activeSubagents = [...subagentInstances.values()].filter((i) => i.status === "running" || i.status === "waiting");
          const runningProcs = [...backgroundTasks.values()].filter((t) => !t.hasExited && !t.isHidden);

          const lines: string[] = ["=== Real-time Superagent AI Process Status ==="];
          lines.push(`Master Agent: ${isMasterRunning ? "🟢 RUNNING" : "⚪ IDLE"}`);
          lines.push(`  - Master Tokens: ${masterPromptTokens} prompt / ${masterCompletionTokens} completion (last: ${lastMasterPromptTokens})`);

          lines.push(`\nRunning Superagents (${activeSuperagents.length}):`);
          if (activeSuperagents.length === 0) {
            lines.push("  None");
          } else {
            for (const s of activeSuperagents) {
              const latestLog = (s.logs || []).slice(-3).join(" ").trim();
              lines.push(`  - [${s.id}] Role: ${s.role} | Branch: ${s.branch} | Status: ${s.status}`);
              lines.push(`    Task: ${s.task}`);
              if (latestLog) lines.push(`    Recent Activity: ${latestLog.slice(0, 150)}...`);
            }
          }

          lines.push(`\nRunning Subagents (${activeSubagents.length}):`);
          if (activeSubagents.length === 0) {
            lines.push("  None");
          } else {
            for (const sub of activeSubagents) {
              lines.push(`  - [${sub.id}] Type: ${sub.typeName} | Role: ${sub.role} | Status: ${sub.status}`);
              if (sub.prompt) lines.push(`    Prompt: ${sub.prompt.slice(0, 120)}...`);
            }
          }

          lines.push(`\nRunning Background Processes (${runningProcs.length}):`);
          if (runningProcs.length === 0) {
            lines.push("  None");
          } else {
            for (const p of runningProcs) {
              lines.push(`  - [${p.id}] PID: ${p.process?.pid || "unknown"} | Cmd: ${p.command}`);
            }
          }

          if (activeToolOutput && activeToolOutput.trim()) {
            lines.push(`\nLive Tool Output Stream:`);
            lines.push(activeToolOutput.slice(-300));
          }

          return {
            content: [{ type: "text", text: lines.join("\n") }],
          };
        }

        case "superagent_interrupt": {
          const target = String(args.target || "all");
          const id = args.id ? String(args.id) : undefined;
          const stopped: string[] = [];

          // Forward to running server endpoint if active
          await callServerApi("/api/abort", "POST", { target, id });

          if (target === "all" || target === "master") {
            if (masterAgentRef?.isAgentRunning?.()) {
              masterAgentRef.abort();
              stopped.push("Master Agent");
            }
          }

          if (target === "all" || target === "superagent") {
            for (const [sId, inst] of superagentInstances.entries()) {
              if (!id || id === sId) {
                if (inst.status === "running" || inst.status === "waiting" || inst.status === "paused") {
                  inst.agent?.abort?.();
                  inst.status = "terminated";
                  inst.result = "[Interrupted via MCP]";
                  stopped.push(`Superagent ${sId} (${inst.role})`);
                }
              }
            }
          }

          if (target === "all" || target === "subagent") {
            for (const [subId, inst] of subagentInstances.entries()) {
              if (!id || id === subId) {
                if (inst.status === "running" || inst.status === "waiting" || inst.status === "paused") {
                  inst.agent?.abort?.();
                  inst.status = "terminated";
                  inst.result = "[Interrupted via MCP]";
                  stopped.push(`Subagent ${subId} (${inst.role})`);
                }
              }
            }
          }

          if (target === "all" || target === "task") {
            for (const [taskId, task] of backgroundTasks.entries()) {
              if (!id || id === taskId) {
                if (!task.hasExited && task.process?.pid) {
                  try {
                    killProcessTree(task.process.pid);
                    task.hasExited = true;
                    task.completedAt = Date.now();
                    stopped.push(`Task ${taskId} (PID: ${task.process.pid})`);
                  } catch {}
                }
              }
            }
          }

          const msg = stopped.length > 0
            ? `Successfully interrupted: ${stopped.join(", ")}`
            : "No active agents or processes were running.";
          return { content: [{ type: "text", text: msg }] };
        }

        case "superagent_pause": {
          const superagentId = String(args.superagentId || args.id || "");
          if (!superagentId) {
            return {
              content: [{ type: "text", text: "Error: 'superagentId' is required to pause." }],
              isError: true,
            };
          }
          const inst = superagentInstances.get(superagentId);
          if (!inst) {
            return {
              content: [{ type: "text", text: `Superagent '${superagentId}' not found.` }],
              isError: true,
            };
          }
          inst.agent?.abort?.();
          inst.status = "paused";
          return {
            content: [{ type: "text", text: `Superagent '${superagentId}' (${inst.role}) has been paused.` }],
          };
        }

        case "superagent_resume": {
          const superagentId = String(args.superagentId || args.id || "");
          const message = String(args.message || "Resume and continue working.");
          const wait = args.wait === true;

          if (!superagentId) {
            return {
              content: [{ type: "text", text: "Error: 'superagentId' is required to resume." }],
              isError: true,
            };
          }

          const { sendMessageToSuperagentTool } = await import("../tools/superagentTools.js");
          const result = await sendMessageToSuperagentTool.execute(
            { superagentId, message, wait },
            process.cwd()
          );
          return {
            content: [{ type: "text", text: String(result) }],
          };
        }

        case "superagent_run_task": {
          const task = String(args.task || "");
          const role = String(args.role || "assistant");
          const mode = args.mode === "multi" ? "multi" : "single";
          const targetWs = args.workspace ? path.resolve(String(args.workspace)) : process.cwd();

          if (!task) {
            return {
              content: [{ type: "text", text: "Error: 'task' is required." }],
              isError: true,
            };
          }

          // Forward to running server if active
          const serverRes = await callServerApi("/api/chat", "POST", {
            message: task,
            workspace: targetWs,
            mode,
          }, 300000);
          if (serverRes.success) {
            return {
              content: [{ type: "text", text: typeof serverRes.data === "string" ? serverRes.data : JSON.stringify(serverRes.data, null, 2) }],
            };
          }

          // Direct standalone execution
          const { Agent } = await import("../agent.js");
          const { superagentToolset, masterToolset } = await import("../tools/toolsets.js");
          const { MASTER_AGENT_SYSTEM_PROMPT } = await import("../prompts.js");

          let collectedOutput = "";
          let reasoningText = "";
          const toolCallsRun: string[] = [];

          const agent = new Agent(
            (event: any) => {
              if (event.type === "text") collectedOutput += event.content;
              if (event.type === "reasoning") reasoningText += event.content;
              if (event.type === "tool_start") toolCallsRun.push(`⚡ ${event.description}`);
              if (event.type === "tool_end") {
                const r = event.toolResult;
                toolCallsRun.push(`${r.isError ? "✗ Failed" : "✓ Done"}: ${event.description}`);
              }
            },
            async () => true, // auto-approve
            async (q, opts) => (Array.isArray(q) ? q.map(i => i.options?.[0] || "") : (opts?.[0] || "")),
            mode === "multi" ? MASTER_AGENT_SYSTEM_PROMPT : undefined,
            mode === "multi" ? masterToolset : superagentToolset,
            targetWs
          );

          agent.tier = mode === "multi" ? "master" : "single";
          await agent.sendMessage(task);

          const summary = [
            `Task completed by Superagent (${role}):`,
            toolCallsRun.length > 0 ? `\nTools Executed:\n${toolCallsRun.join("\n")}\n` : "",
            `\nFinal Result:\n${collectedOutput || "(No output emitted)"}`,
          ].join("\n");

          return { content: [{ type: "text", text: summary }] };
        }

        case "superagent_spawn_subagent": {
          const typeName = String(args.type || args.typeName || "researcher");
          const prompt = String(args.prompt || "");
          const role = String(args.role || typeName);

          if (!prompt) {
            return {
              content: [{ type: "text", text: "Error: 'prompt' is required to spawn a subagent." }],
              isError: true,
            };
          }

          const { invokeSubagentTool } = await import("../tools/subagentTools.js");
          const result = await invokeSubagentTool.execute(
            { typeName, role, prompt, wait: true },
            process.cwd()
          );
          return { content: [{ type: "text", text: String(result) }] };
        }

        case "superagent_switch_workspace": {
          const ws = String(args.workspacePath || "");
          if (!ws) {
            return { content: [{ type: "text", text: "Error: 'workspacePath' is required." }], isError: true };
          }
          const resolved = path.resolve(ws);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
          }
          addTrustedDirectory(resolved);
          await ensureDirectoryTrusted(resolved);
          process.chdir(resolved);

          // Notify running server if active
          await callServerApi("/api/switch-workspace", "POST", { workspace: resolved });

          return { content: [{ type: "text", text: `Switched active Superagent workspace to: ${resolved}` }] };
        }

        case "superagent_get_workspace": {
          const cwd = process.cwd();
          let branch = "unknown";
          try {
            const { execSync } = await import("child_process");
            branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
          } catch {}

          const registry = loadRegistry();
          const lines = [
            `Current Workspace: ${cwd}`,
            `Git Branch: ${branch}`,
            `Registered Feature Worktrees (${registry.length}):`,
          ];
          for (const r of registry) {
            lines.push(`  - [${r.id}] ${r.role} -> ${r.branch} (${r.status}) at ${r.worktreePath}`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        case "superagent_get_plan_and_tasks": {
          const ws = args.workspace ? path.resolve(String(args.workspace)) : process.cwd();
          const { readChecklistTasks } = await import("../taskChecklist.js");
          const taskFiles = [
            path.join(ws, "_task.md"),
            path.join(ws, "task.md"),
            path.join(ws, "tasks.md"),
          ];
          let foundTasks: any[] = [];
          for (const tf of taskFiles) {
            if (fs.existsSync(tf)) {
              const res = await readChecklistTasks(tf);
              if (res.tasks && res.tasks.length > 0) {
                foundTasks = res.tasks;
                break;
              }
            }
          }

          const planFiles = [
            path.join(ws, "_plan.md"),
            path.join(ws, "plan.md"),
            path.join(ws, "implementation_plan.md"),
          ];
          let planContent = "(No plan document found)";
          for (const pf of planFiles) {
            if (fs.existsSync(pf)) {
              planContent = fs.readFileSync(pf, "utf-8");
              break;
            }
          }

          const lines = ["=== Implementation Plan ===", planContent.slice(0, 1000), "\n=== Task Checklist ==="];
          if (foundTasks.length === 0) {
            lines.push("  No checklist tasks found.");
          } else {
            for (const t of foundTasks) {
              const check = t.status === "x" ? "[x]" : (t.status === "/" ? "[/]" : "[ ]");
              lines.push(`  - ${check} ${t.text}`);
            }
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        case "superagent_update_tasks": {
          const action = String(args.action || "get_status");
          const taskText = String(args.taskText || "");
          const { managePlanTool } = await import("../tools/otherTools.js");
          const result = await managePlanTool.execute({ action, task: taskText }, process.cwd());
          return { content: [{ type: "text", text: String(result) }] };
        }

        case "superagent_get_config": {
          const settings = getSettings();
          const activeProvider = getActiveProviderName();
          const providers = getConfiguredProviders();
          const singlePreset = getActivePresetId("single");
          const multiPreset = getActivePresetId("multi");
          const singleModel = getEffectiveMasterModel("single");
          const multiModel = getEffectiveMasterModel("multi");
          const tierModels = getAllTierModels("multi");

          const lines = [
            "=== Superagent Configuration ===",
            `Active Provider: ${activeProvider}`,
            `Configured Providers: ${providers.join(", ")}`,
            `Active Presets: Single = ${singlePreset || "default"} | Multi = ${multiPreset || "default"}`,
            `Effective Models: Single = ${singleModel} | Multi = ${multiModel}`,
            `\nTier Models (Multi-Agent):`,
            ...Object.entries(tierModels).map(([tier, model]) => `  - ${tier}: ${model}`),
            `\nSystem Settings:`,
            `  - Concurrency: ${settings.concurrencyLimit ?? 5}`,
            `  - Max Iterations: ${settings.maxIterations ?? 50}`,
            `  - Streaming: ${settings.disableStreaming ? "Disabled" : "Enabled"}`,
            `  - Rate Limit RPM: ${settings.rateLimitRpm ?? 60}`,
          ];
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        case "superagent_switch_preset": {
          const presetId = String(args.presetId || "");
          const mode: "multi" | "single" = args.mode === "multi" ? "multi" : "single";
          if (!presetId) {
            return { content: [{ type: "text", text: "Error: 'presetId' is required." }], isError: true };
          }
          applyModelPreset(presetId, mode, true);
          setActivePresetId(mode, presetId);
          return { content: [{ type: "text", text: `Switched ${mode} mode preset to: ${presetId}` }] };
        }

        case "superagent_switch_provider": {
          const providerName = String(args.providerName || "");
          if (!providerName) {
            return { content: [{ type: "text", text: "Error: 'providerName' is required." }], isError: true };
          }
          switchActiveProvider(providerName);
          return { content: [{ type: "text", text: `Active AI provider switched to: ${providerName}` }] };
        }

        case "superagent_memory_search": {
          const query = String(args.query || "");
          const limit = typeof args.limit === "number" ? args.limit : 10;
          if (!query) {
            return { content: [{ type: "text", text: "Error: 'query' is required." }], isError: true };
          }
          const allPinned = getAllPinnedKnowledgeFromDb() || [];
          const matched = allPinned.filter((p: any) =>
            (p.content || p.content_preview || "").toLowerCase().includes(query.toLowerCase()) ||
            (p.tag || "").toLowerCase().includes(query.toLowerCase())
          ).slice(0, limit);

          if (matched.length === 0) {
            return { content: [{ type: "text", text: `No pinned knowledge found matching: "${query}"` }] };
          }

          const text = matched
            .map((m: any) => `[Tag: ${m.tag || "general"} | ${new Date(m.timestamp).toISOString()}]: ${m.content || m.content_preview}`)
            .join("\n\n");
          return { content: [{ type: "text", text }] };
        }

        case "superagent_memory_save": {
          const content = String(args.content || "");
          const tag = String(args.tag || "general");
          if (!content) {
            return { content: [{ type: "text", text: "Error: 'content' is required." }], isError: true };
          }
          const now = Date.now();
          savePinnedKnowledgeToDb({
            id: `pin_${now}_${Math.random().toString(36).slice(2, 8)}`,
            content,
            preview: content.slice(0, 200),
            tag,
            role: "user",
            pinnedAt: now,
            timestamp: now,
            sourceSessionPath: process.cwd(),
            workingDirectory: process.cwd(),
          });
          return { content: [{ type: "text", text: `Knowledge snippet saved to persistent memory under tag [${tag}].` }] };
        }

        case "superagent_get_status": {
          const rawIds = args.superagentIds ?? args.superagent_ids ?? args.id ?? args.superagentId;
          const ids = Array.isArray(rawIds) ? (rawIds as string[]) : (rawIds ? [String(rawIds)] : []);
          
          if (ids.length > 0) {
            const serverRes = await callServerApi("/api/instances", "GET");
            if (serverRes.success && serverRes.data?.superagents) {
              const matched = serverRes.data.superagents.filter((s: any) => ids.includes(s.id));
              if (matched.length > 0) {
                const text = matched
                  .map((s: any) => `Superagent ${s.id} (${s.role}):\n  Status: ${s.status}\n  Task: ${s.prompt || "(none)"}\n  Result: ${s.result || "(no result yet)"}`)
                  .join("\n\n");
                return { content: [{ type: "text", text }] };
              }
            }
          }

          const { manageSuperagentsTool } = await import("../tools/superagentTools.js");
          const res = await manageSuperagentsTool.execute(
            { action: "status", superagentIds: ids },
            process.cwd()
          );
          return { content: [{ type: "text", text: String(res) }] };
        }

        case "superagent_get_logs": {
          const id = String(args.id || "");
          const limit = typeof args.limit === "number" ? args.limit : 50;
          if (!id) {
            return {
              content: [{ type: "text", text: "Error: Missing required parameter 'id'." }],
              isError: true,
            };
          }

          const serverRes = await callServerApi("/api/instances", "GET");
          if (serverRes.success && serverRes.data) {
            const all = [
              ...(serverRes.data.superagents || []),
              ...(serverRes.data.subagents || []),
              ...(serverRes.data.procs || []),
            ];
            const found = all.find((item: any) => item.id === id);
            if (found && Array.isArray(found.logs)) {
              const recent = found.logs.slice(-limit).join("\n");
              return {
                content: [{ type: "text", text: `Logs for ${id}:\n${recent || "(no logs)"}` }],
              };
            }
          }

          const inst = superagentInstances.get(id) || subagentInstances.get(id);
          if (inst && Array.isArray(inst.logs)) {
            const recent = inst.logs.slice(-limit).join("");
            return {
              content: [{ type: "text", text: `Logs for ${id}:\n${recent || "(no logs)"}` }],
            };
          }

          const task = backgroundTasks.get(id);
          if (task) {
            let out = task.output || [];
            if (task.logPath && fs.existsSync(task.logPath)) {
              try {
                out = fs.readFileSync(task.logPath, "utf-8").split("\n").map(l => l + "\n");
              } catch {}
            }
            const recent = out.slice(-limit).join("");
            return {
              content: [{ type: "text", text: `Logs for background task ${id}:\n${recent || "(no logs)"}` }],
            };
          }

          return {
            content: [{ type: "text", text: `No instance or task found with ID: ${id}` }],
          };
        }

        case "superagent_send_message": {
          const superagentId = String(args.superagentId || args.id || "");
          const message = String(args.message || "");
          const wait = args.wait === true;

          if (!superagentId || !message) {
            return {
              content: [{ type: "text", text: "Error: Both 'superagentId' and 'message' are required." }],
              isError: true,
            };
          }

          const serverRes = await callServerApi(
            "/api/superagents/message",
            "POST",
            { superagentId, message, wait },
            wait ? 300000 : 10000
          );
          if (serverRes.success) {
            return {
              content: [
                {
                  type: "text",
                  text: typeof serverRes.data === "string" ? serverRes.data : JSON.stringify(serverRes.data, null, 2),
                },
              ],
            };
          }

          const { sendMessageToSuperagentTool } = await import("../tools/superagentTools.js");
          const result = await sendMessageToSuperagentTool.execute(
            { superagentId, message, wait },
            process.cwd()
          );
          return {
            content: [{ type: "text", text: String(result) }],
          };
        }

        case "superagent_invoke": {
          const role = String(args.role || "");
          const task = String(args.task || "");
          const branch = args.branch ? String(args.branch) : undefined;
          const wait = args.wait === true;
          const constraints = args.constraints ? String(args.constraints) : undefined;
          const acceptanceCriteria = Array.isArray(args.acceptanceCriteria)
            ? (args.acceptanceCriteria as string[])
            : undefined;

          if (!role || !task) {
            return {
              content: [{ type: "text", text: "Error: 'role' and 'task' are required to invoke a Superagent." }],
              isError: true,
            };
          }

          const serverRes = await callServerApi(
            "/api/superagents/invoke",
            "POST",
            { role, task, branch, wait, constraints, acceptanceCriteria },
            wait ? 600000 : 10000
          );
          if (serverRes.success) {
            return {
              content: [
                {
                  type: "text",
                  text: typeof serverRes.data === "string" ? serverRes.data : JSON.stringify(serverRes.data, null, 2),
                },
              ],
            };
          }

          const { invokeSuperagentTool } = await import("../tools/superagentTools.js");
          const result = await invokeSuperagentTool.execute(
            { role, task, branch, wait, constraints, acceptanceCriteria },
            process.cwd()
          );
          return {
            content: [{ type: "text", text: String(result) }],
          };
        }

        case "superagent_await": {
          const timeoutSeconds = typeof args.timeoutSeconds === "number" ? args.timeoutSeconds : 600;
          const superagentIds = Array.isArray(args.superagentIds) ? (args.superagentIds as string[]) : undefined;

          const { awaitSuperagentsTool } = await import("../tools/superagentTools.js");
          const result = await awaitSuperagentsTool.execute(
            { timeoutSeconds, superagentIds },
            process.cwd()
          );
          return {
            content: [{ type: "text", text: String(result) }],
          };
        }

        case "superagent_merge": {
          const cleanupWorktrees = args.cleanupWorktrees !== false;
          const { mergeSuperagentsTool } = await import("../tools/superagentTools.js");
          const result = await mergeSuperagentsTool.execute(
            { cleanupWorktrees },
            process.cwd()
          );
          return {
            content: [{ type: "text", text: String(result) }],
          };
        }

        case "superagent_manage": {
          const action = String(args.action || "list");
          const superagentIds = Array.isArray(args.superagentIds) ? (args.superagentIds as string[]) : undefined;

          const serverRes = await callServerApi(
            "/api/superagents/manage",
            "POST",
            { action, superagentIds }
          );
          if (serverRes.success) {
            return {
              content: [
                {
                  type: "text",
                  text: typeof serverRes.data === "string" ? serverRes.data : JSON.stringify(serverRes.data, null, 2),
                },
              ],
            };
          }

          const { manageSuperagentsTool } = await import("../tools/superagentTools.js");
          const result = await manageSuperagentsTool.execute(
            { action, superagentIds },
            process.cwd()
          );
          return {
            content: [{ type: "text", text: String(result) }],
          };
        }

        case "superagent_query_history": {
          const action = String(args.action || "list_sessions");
          const limit = typeof args.limit === "number" ? args.limit : 20;

          if (action === "list_sessions") {
            const sessions = listSessionsFromDb(limit);
            const text = sessions
              .map((s: any) => {
                const dateVal = Number(s.lastModified) || 0;
                const dateStr = dateVal > 0 ? new Date(dateVal).toISOString() : "unknown";
                const mode = s.filePath?.includes("multi") ? "multi" : "single";
                const title = s.displayName || s.firstChat || s.preview || "(no title)";
                return `- ID: ${s.id} | Mode: ${mode} | Messages: ${s.messageCount ?? 0} | Updated: ${dateStr} | Title: ${title}`;
              })
              .join("\n");
            return {
              content: [{ type: "text", text: text || "No sessions found in history database." }],
            };
          }

          if (action === "get_messages") {
            const sessionId = String(args.sessionId || "");
            if (!sessionId) {
              return {
                content: [{ type: "text", text: "Error: 'sessionId' is required for action 'get_messages'." }],
                isError: true,
              };
            }
            const record = loadSessionFromDb(sessionId);
            if (!record) {
              return {
                content: [{ type: "text", text: `Session '${sessionId}' not found in SQLite database.` }],
              };
            }
            const msgs = record.messages || [];
            const text = msgs
              .map((m: any) => `[${(m.role || "unknown").toUpperCase()}]: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
              .join("\n\n");
            return {
              content: [{ type: "text", text: text || "(Session has no messages)" }],
            };
          }

          if (action === "search") {
            const query = String(args.query || "");
            if (!query) {
              return {
                content: [{ type: "text", text: "Error: 'query' is required for action 'search'." }],
                isError: true,
              };
            }
            const results = searchMessagesInDb(query, limit);
            if (results.length === 0) {
              return { content: [{ type: "text", text: `No history matches found for query: "${query}"` }] };
            }
            const text = results
              .map((r: any) => {
                const dateVal = Number(r.timestamp) || 0;
                const dateStr = dateVal > 0 ? new Date(dateVal).toISOString() : "unknown";
                const snip = (r.content || "").length > 200 ? (r.content || "").slice(0, 200) + "..." : r.content || "";
                return `[Session ${r.sessionId} | ${r.role} | ${dateStr}]: ${snip}`;
              })
              .join("\n\n");
            return {
              content: [{ type: "text", text }],
            };
          }

          return {
            content: [{ type: "text", text: `Unknown history action: ${action}` }],
            isError: true,
          };
        }

        default:
          throw new McpError(ErrorCode.MethodNotFound, `Tool '${name}' not recognized.`);
      }
    } catch (err: any) {
      logMcp(`Error executing tool ${name}: ${err?.stack || err?.message || String(err)}`);
      return {
        content: [
          {
            type: "text",
            text: `Error executing ${name}: ${err?.message || String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Connect the Superagent MCP Server to Stdio transport and start listening.
 */
export async function startSuperagentMcpServer(): Promise<void> {
  logMcp("Starting Superagent MCP Server via stdio transport...");
  const server = createSuperagentMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logMcp("Superagent MCP Server connected and listening on stdio.");
}
