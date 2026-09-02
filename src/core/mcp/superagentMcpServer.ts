/**
 * superagentMcpServer.ts — MCP Server implementation for Superagent.
 *
 * Exposes Superagent inspection, monitoring, bidirectional communication,
 * and orchestration tools to external MCP clients (e.g. Antigravity / AGY, Claude Desktop).
 *
 * Implements tools:
 *   - superagent_list_active     : List running/completed Superagents, subagents, and background processes
 *   - superagent_get_status      : Get detailed status, reports, criteria, and violations for Superagents
 *   - superagent_get_logs        : Get live/recent logs for a Superagent or Subagent
 *   - superagent_send_message    : Send follow-up instruction/message to an active or paused Superagent (two-way communication)
 *   - superagent_invoke          : Spawn a new Superagent on a feature branch/worktree
 *   - superagent_await           : Wait for active Superagents to complete
 *   - superagent_merge           : Merge completed Superagent branches with conflict resolution
 *   - superagent_manage          : Manage Superagent lifecycle (status, kill, retry_failed, etc.)
 *   - superagent_query_history   : Query sessions and chat transcripts from SQLite database
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
import { superagentInstances, subagentInstances, backgroundTasks } from "../tools/state.js";
import { listSessionsFromDb, loadSessionFromDb, searchMessagesInDb } from "../storage/historyDb.js";

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
 * Attempt to query the running Superagent HTTP API server if available.
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
  // Try remote server API first
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

  // Add registry entries not already in memory
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
      version: version || "1.5.21",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List Tools handler
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

  // Call Tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    logMcp(`Handling tool call: ${name} with args: ${JSON.stringify(args)}`);

    try {
      switch (name) {
        case "superagent_list_active": {
          const result = await listActiveInstances();
          return {
            content: [
              {
                type: "text",
                text: result.formatted,
              },
            ],
          };
        }

        case "superagent_get_status": {
          const rawIds = args.superagentIds ?? args.superagent_ids ?? args.id ?? args.superagentId;
          const ids = Array.isArray(rawIds) ? (rawIds as string[]) : (rawIds ? [String(rawIds)] : []);
          
          // Try server API first
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

          // Fallback to local tool execution
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

          // Try server API first
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

          // Fallback to local state
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

          // Forward to running server endpoint if active
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

          // Local in-process execution fallback
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

          // Forward to server if active
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

          // Local fallback
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

          // Forward to server if active
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

          // Local fallback
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
                const dateStr = s.lastModified
                  ? new Date(typeof s.lastModified === "number" ? s.lastModified : Number(s.lastModified) || s.lastModified).toISOString()
                  : "unknown";
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
                const dateStr = r.timestamp
                  ? new Date(typeof r.timestamp === "number" ? r.timestamp : Number(r.timestamp) || r.timestamp).toISOString()
                  : "unknown";
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
