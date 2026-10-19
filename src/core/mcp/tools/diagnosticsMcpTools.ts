/**
 * diagnosticsMcpTools.ts — Process inspection, port diagnostics, and graceful termination tools for MCP.
 */

import { McpToolResult } from "../types.js";
import {
  inspectPortTool,
  freePortTool,
  findProcessTool,
  killProcessTool,
} from "../../tools/processInspectionTools.js";
import { getMcpWorkspacePath } from "./workspaceContext.js";
import { isRemoteWorkspaceTarget } from "./workspaceContext.js";
import fs from "node:fs";
import path from "node:path";
import { redactMemorySecrets } from "../../memoryLifecycle.js";
import { getProcessPoolMetrics } from "../../agent/ProcessPool.js";

function toResult(res: unknown): McpToolResult {
  const text = typeof res === "string" ? res : JSON.stringify(res, null, 2);
  const isError =
    typeof res === "string" &&
    (res.startsWith("Error:") ||
      res.startsWith("Failed to") ||
      res.includes("remains occupied"));
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function handleInspectPort(args: any): Promise<McpToolResult> {
  try {
    const res = await inspectPortTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `inspect_port error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleFreePort(args: any): Promise<McpToolResult> {
  try {
    const res = await freePortTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `free_port error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleFindProcess(args: any): Promise<McpToolResult> {
  try {
    const res = await findProcessTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `find_process error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleKillProcess(args: any): Promise<McpToolResult> {
  try {
    const res = await killProcessTool.execute(args || {}, getMcpWorkspacePath());
    return toResult(res);
  } catch (err: any) {
    return {
      content: [{ type: "text", text: `kill_process error: ${err?.message || String(err)}` }],
      isError: true,
    };
  }
}

export async function handleProcessPoolStatus(): Promise<McpToolResult> {
  const metrics = getProcessPoolMetrics();
  const result = {
    workerType: "ephemeral-os-process",
    supportedOperations: ["local-file-read-batches"],
    maxConcurrentWorkers: 4,
    defaultWorkerTimeoutMs: 30000,
    metrics,
    note: "This process pool isolates safe file-read batches. Full Agent/subagent execution still runs in the orchestrator until the event/approval IPC contract is implemented.",
  };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

function getAuthorizedLocalDaemonWorkspace(): string {
  const selected = getMcpWorkspacePath();
  if (isRemoteWorkspaceTarget(selected)) {
    throw new Error("Daemon diagnostics only support an authorized local workspace.");
  }
  return fs.realpathSync(path.resolve(selected));
}

function sameDaemonWorkspace(a: string, b: string): boolean {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/** Read-only, project-scoped diagnostics with no execution/cancellation side effects. */
export async function handleDaemonMcpStatus(args: { limit?: number } = {}): Promise<McpToolResult> {
  try {
    const workspace = getAuthorizedLocalDaemonWorkspace();
    const limit = args.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("limit must be an integer between 1 and 50.");
    }
    const [{ daemonScheduler }, { listDaemonRuns }] = await Promise.all([
      import("../../daemon/daemonScheduler.js"),
      import("../../storage/daemonRunLedger.js"),
    ]);
    const jobs = daemonScheduler.listJobs()
      .filter((job) => sameDaemonWorkspace(job.workspace, workspace))
      .map(({ id, name, enabled, lastStatus, nextRun }) => ({ id, name, enabled, lastStatus, nextRun }));
    const runs = listDaemonRuns({ workspacePath: workspace, limit })
      .filter((run) => sameDaemonWorkspace(run.workspacePath, workspace));
    const status = daemonScheduler.getStatus();
    const visible = {
      workspace,
      daemonRunning: status.running,
      pid: status.pid,
      projectScheduledJobs: jobs.length,
      jobs,
      recentRuns: runs.map(({ runId, jobId, status, startedAt, durationMs, notificationStatus }) =>
        ({ runId, jobId, status, startedAt, durationMs, notificationStatus })),
    };
    return { content: [{ type: "text", text: redactMemorySecrets(JSON.stringify(visible, null, 2)) }] };
  } catch (error) {
    return { content: [{ type: "text", text: redactMemorySecrets(String(error)) }], isError: true };
  }
}

export async function handleDaemonMcpInspectRun(args: { runId?: string } = {}): Promise<McpToolResult> {
  try {
    const workspace = getAuthorizedLocalDaemonWorkspace();
    if (typeof args.runId !== "string" || !args.runId.trim() || args.runId.length > 256) {
      throw new Error("A valid runId (up to 256 characters) is required.");
    }
    const { getDaemonRun } = await import("../../storage/daemonRunLedger.js");
    const run = getDaemonRun(args.runId);
    if (!run || !sameDaemonWorkspace(run.workspacePath, workspace)) {
      return { content: [{ type: "text", text: "Daemon run not found in authorized workspace." }], isError: true };
    }
    return { content: [{ type: "text", text: redactMemorySecrets(JSON.stringify(run, null, 2)) }] };
  } catch (error) {
    return { content: [{ type: "text", text: redactMemorySecrets(String(error)) }], isError: true };
  }
}

export const DIAGNOSTICS_MCP_TOOL_CLASSIFICATIONS: Record<string, "safe" | "dangerous"> = {
  superagent_daemon_status: "safe",
  superagent_daemon_inspect_run: "safe",
  superagent_process_pool_status: "safe",
  superagent_inspect_port: "safe",
  superagent_free_port: "dangerous",
  superagent_find_process: "safe",
  superagent_kill_process: "dangerous",
};

export const DIAGNOSTICS_MCP_TOOL_DEFS = [
  {
    name: "superagent_daemon_status",
    description: "Read-only project-scoped daemon health, scheduled job statuses, and recent ledger run summaries. Requires workspace read access.",
    inputSchema: { type: "object", properties: {
      limit: { type: "number", description: "Number of recent runs to show (1-50). Defaults to 10." },
      workspace: { type: "string", description: "Authorized local workspace." },
      projectId: { type: "string", description: "Optional registered project with read access." },
    } },
  },
  {
    name: "superagent_daemon_inspect_run",
    description: "Read-only inspection of a daemon run scoped to the authorized local workspace; never cancels or executes tasks.",
    inputSchema: { type: "object", properties: {
      runId: { type: "string", description: "Durable run ID." },
      workspace: { type: "string", description: "Authorized local workspace." },
      projectId: { type: "string", description: "Optional registered project with read access." },
    }, required: ["runId"] },
  },

  {
    name: "superagent_process_pool_status",
    description: "Show bounded OS process-pool worker counts, timeouts, failures, fallback reads, and duration counters. Reports the supported operation scope explicitly.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "superagent_inspect_port",
    description:
      "Inspect a TCP port (1-65535) to discover which process is listening on it, including PID, process name, full command line, and whether it is a Superagent background task.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "The TCP port number to inspect (1-65535), e.g. 3000, 7001, 8080.",
        },
      },
      required: ["port"],
    },
  },
  {
    name: "superagent_free_port",
    description:
      "Safely terminate the specific process occupying a TCP port and its child process tree, preventing port conflicts (EADDRINUSE) without killing unrelated services.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "The TCP port number to release, e.g. 3000, 7001, 8080.",
        },
        force: {
          type: "boolean",
          description: "Whether to force-kill if graceful termination does not release the port within 2s (default: true).",
        },
      },
      required: ["port"],
    },
  },
  {
    name: "superagent_find_process",
    description:
      "Search active system processes or Superagent tasks by port number, process name (e.g. 'bun', 'vite'), or command line substring.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Port number, process name, or command substring to search for.",
        },
        limit: {
          type: "number",
          description: "Maximum number of process matches to return (default: 10).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "superagent_kill_process",
    description:
      "Safely terminate a specific process by its PID and its child process tree, verifying against critical operating system processes.",
    inputSchema: {
      type: "object",
      properties: {
        pid: {
          type: "number",
          description: "The Process ID (PID) to terminate.",
        },
        force: {
          type: "boolean",
          description: "Whether to force-kill if graceful termination fails (default: true).",
        },
      },
      required: ["pid"],
    },
  },
];

export async function dispatchDiagnosticsMcpTool(name: string, args: any): Promise<McpToolResult | null> {
  switch (name) {
    case "superagent_daemon_status":
      return await handleDaemonMcpStatus(args);
    case "superagent_daemon_inspect_run":
      return await handleDaemonMcpInspectRun(args);
    case "superagent_process_pool_status":
      return await handleProcessPoolStatus();
    case "superagent_inspect_port":
      return await handleInspectPort(args);
    case "superagent_free_port":
      return await handleFreePort(args);
    case "superagent_find_process":
    case "superagent_find_processes":
      return await handleFindProcess(args);
    case "superagent_kill_process":
      return await handleKillProcess(args);
    default:
      return null;
  }
}
