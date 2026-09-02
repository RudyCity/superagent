/**
 * processTools.ts — Process status, monitoring, logs, and interruption tool handlers for MCP.
 */

import fs from "fs";
import path from "path";
import http from "http";
import { McpToolResult, ServerInfo } from "../types.js";
import { getRootConfigDir } from "../../config/paths.js";
import { loadRegistry, reconcileRegistry } from "../../tools/superagentRegistry.js";
import { loadActiveProcesses } from "../processJournal.js";
import {
  superagentInstances,
  subagentInstances,
  backgroundTasks,
  activeToolOutput,
  masterAgentRef,
  masterPromptTokens,
  masterCompletionTokens,
  lastMasterPromptTokens,
} from "../../tools/state.js";
import { killProcessTree } from "../../tools/shellTools.js";

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

export async function callServerApi(
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

export async function handleListActive(args: any): Promise<McpToolResult> {
  const lines: string[] = ["=== Active Superagent Instances & Processes ==="];

  // 1. Check live active processes across machine
  const processes = loadActiveProcesses();
  const nonMcpProcs = processes.filter((p) => p.mode !== "mcp");
  if (nonMcpProcs.length > 0) {
    lines.push(`\nRunning Superagent CLI / Server Processes (${nonMcpProcs.length}):`);
    for (const p of nonMcpProcs) {
      const ageSec = Math.round((Date.now() - p.startedAt) / 1000);
      lines.push(`  - PID: ${p.pid} | Mode: ${p.mode} | Workspace: ${p.workingDirectory} | Uptime: ${ageSec}s | Agent Loop: ${p.isAgentRunning ? "🟢 Active" : "⚪ Idle"}`);
      if (p.activeSuperagents && p.activeSuperagents.length > 0) {
        for (const s of p.activeSuperagents) {
          lines.push(`      • Superagent [${s.id}] (${s.role}) -> ${s.status}${s.task ? ` | Task: ${s.task}` : ""}`);
        }
      }
    }
  }

  // 2. Query running server API if active
  const serverRes = await callServerApi("/api/instances", "GET");
  if (serverRes.success && serverRes.data) {
    const { superagents = [], subagents = [], procs = [] } = serverRes.data;
    if (superagents.length > 0) {
      lines.push("\nSuperagents (via Server):");
      for (const s of superagents) {
        lines.push(`  - ID: ${s.id} | Role: ${s.role} | Status: ${s.status} | Task: ${s.prompt || "(none)"}`);
        if (s.result) {
          const snip = s.result.length > 120 ? s.result.slice(0, 120) + "..." : s.result;
          lines.push(`    Report: ${snip}`);
        }
      }
    }

    if (subagents.length > 0) {
      lines.push("\nSubagents (via Server):");
      for (const sub of subagents) {
        lines.push(`  - ID: ${sub.id} | Type: ${sub.typeName} | Role: ${sub.role} | Status: ${sub.status}`);
      }
    }

    if (procs.length > 0) {
      lines.push("\nBackground Tasks (via Server):");
      for (const p of procs) {
        lines.push(`  - ID: ${p.id} | PID: ${p.pid} | Command: ${p.commandLine} | Status: ${p.status}`);
      }
    }
  }

  // 3. Check local in-memory state
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
      });
    }
  }

  if (superagentList.length > 0) {
    lines.push(`\nRegistered Feature Worktrees (${superagentList.length}):`);
    for (const s of superagentList) {
      lines.push(`  - [${s.id}] Role: ${s.role} | Branch: ${s.branch} | Status: ${s.status}`);
    }
  }

  if (nonMcpProcs.length === 0 && superagentList.length === 0) {
    lines.push("\nNo active Superagent processes or worktree instances found.");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleGetProcessStatus(): Promise<McpToolResult> {
  const isMasterRunning = masterAgentRef ? (masterAgentRef.isAgentRunning?.() ?? false) : false;
  const activeSuperagents = [...superagentInstances.values()].filter((i) => i.status === "running" || i.status === "waiting");
  const activeSubagents = [...subagentInstances.values()].filter((i) => i.status === "running" || i.status === "waiting");
  const runningProcs = [...backgroundTasks.values()].filter((t) => !t.hasExited && !t.isHidden);

  const processes = loadActiveProcesses();
  const nonMcpProcs = processes.filter((p) => p.mode !== "mcp");

  const lines: string[] = ["=== Real-time Superagent AI Process Status ==="];
  lines.push(`Active CLI Processes: ${nonMcpProcs.length > 0 ? `${nonMcpProcs.length} Process(es) Running` : "None"}`);
  for (const p of nonMcpProcs) {
    lines.push(`  - PID ${p.pid} (${p.mode}) in ${p.workingDirectory} -> ${p.isAgentRunning ? "🟢 RUNNING" : "⚪ IDLE"}`);
  }

  lines.push(`\nMaster Agent: ${isMasterRunning ? "🟢 RUNNING" : "⚪ IDLE"}`);
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

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleInterrupt(args: any): Promise<McpToolResult> {
  const target = String(args.target || "all");
  const id = args.id ? String(args.id) : (args.superagentId ? String(args.superagentId) : undefined);
  const stopped: string[] = [];

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

export async function handlePause(args: any): Promise<McpToolResult> {
  const superagentId = String(args.superagentId || args.id || args.target || "");
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

export async function handleResume(args: any): Promise<McpToolResult> {
  const superagentId = String(args.superagentId || args.id || args.target || "");
  const message = String(args.message || args.prompt || "Resume and continue working.");
  const wait = args.wait === true;

  if (!superagentId) {
    return {
      content: [{ type: "text", text: "Error: 'superagentId' is required to resume." }],
      isError: true,
    };
  }

  const { sendMessageToSuperagentTool } = await import("../../tools/superagentTools.js");
  const result = await sendMessageToSuperagentTool.execute(
    { superagentId, message, wait },
    process.cwd()
  );
  return {
    content: [{ type: "text", text: String(result) }],
  };
}

export async function handleGetLogs(args: any): Promise<McpToolResult> {
  const id = String(args.id || args.superagentId || args.subagentId || args.taskId || "");
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
        out = fs.readFileSync(task.logPath, "utf-8").split("\n").map((l) => l + "\n");
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
