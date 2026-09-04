/**
 * processTools.ts — Process status, monitoring, logs, and interruption tool handlers for MCP.
 */

import fs from "fs";
import path from "path";
import http from "http";
import { McpToolResult, ServerInfo } from "../types.js";
import { getRootConfigDir, getGlobalConfigDir } from "../../config/paths.js";
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
  getProcessActivity,
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

  // 1. Check live active processes across machine via process journal
  const processes = loadActiveProcesses();
  const nonMcpProcs = processes.filter((p) => p.mode !== "mcp");
  if (nonMcpProcs.length > 0) {
    lines.push(`\nRunning Superagent CLI / Server Processes (${nonMcpProcs.length}):`);
    for (const p of nonMcpProcs) {
      const ageSec = Math.round((Date.now() - p.startedAt) / 1000);
      const m = Math.floor(ageSec / 60);
      const s = ageSec % 60;
      const uptimeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;

      lines.push(`  - PID: ${p.pid} | Mode: ${p.mode} | Workspace: ${p.workingDirectory} | Uptime: ${uptimeStr}`);
      lines.push(`    Status: ${p.isAgentRunning ? "🟢 RUNNING" : "⚪ IDLE"} (${p.currentStatus || (p.isAgentRunning ? "Active" : "Idle")})`);
      if (p.currentTask) {
        const taskPreview = p.currentTask.length > 100 ? p.currentTask.slice(0, 100) + "..." : p.currentTask;
        lines.push(`    Current Task: ${taskPreview}`);
      }
      if (p.currentTool) {
        lines.push(`    Active Tool: ${p.currentTool}`);
      }
      if (p.model) {
        lines.push(`    Model: ${p.model}`);
      }
      if (p.activeSuperagents && p.activeSuperagents.length > 0) {
        lines.push(`    Active Superagents (${p.activeSuperagents.length}):`);
        for (const s of p.activeSuperagents) {
          lines.push(`      • [${s.id}] (${s.role}) -> ${s.status}${s.task ? ` | Task: ${s.task}` : ""}`);
        }
      }
      if (p.activeSubagents && p.activeSubagents.length > 0) {
        lines.push(`    Active Subagents (${p.activeSubagents.length}):`);
        for (const sub of p.activeSubagents) {
          lines.push(`      • [${sub.id}] (${sub.role || sub.typeName}) -> ${sub.status}`);
        }
      }
    }
  }

  // 2. Query running server API if active
  const serverRes = await callServerApi("/api/instances", "GET");
  if (serverRes.success && serverRes.data) {
    const { superagents = [], subagents = [], procs = [] } = serverRes.data;
    if (superagents.length > 0) {
      lines.push("\nSuperagents (via Server API):");
      for (const s of superagents) {
        lines.push(`  - ID: ${s.id} | Role: ${s.role} | Status: ${s.status} | Task: ${s.prompt || "(none)"}`);
        if (s.result) {
          const snip = s.result.length > 120 ? s.result.slice(0, 120) + "..." : s.result;
          lines.push(`    Report: ${snip}`);
        }
      }
    }

    if (subagents.length > 0) {
      lines.push("\nSubagents (via Server API):");
      for (const sub of subagents) {
        lines.push(`  - ID: ${sub.id} | Type: ${sub.typeName} | Role: ${sub.role} | Status: ${sub.status}`);
      }
    }

    if (procs.length > 0) {
      lines.push("\nBackground Tasks (via Server API):");
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
      lines.push(`  - [${s.id}] Role: ${s.role} | Branch: ${s.branch} | Status: ${s.status}${s.task ? ` | Task: ${s.task}` : ""}`);
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
    const ageSec = Math.round((Date.now() - p.startedAt) / 1000);
    const m = Math.floor(ageSec / 60);
    const s = ageSec % 60;
    const uptimeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;

    lines.push(`\n[Process PID ${p.pid} — ${p.mode.toUpperCase()}]`);
    lines.push(`  - Workspace: ${p.workingDirectory}`);
    lines.push(`  - Uptime: ${uptimeStr}`);
    lines.push(`  - State: ${p.isAgentRunning ? "🟢 RUNNING" : "⚪ IDLE"} (${p.currentStatus || (p.isAgentRunning ? "Active" : "Idle")})`);
    if (p.currentTask) lines.push(`  - Current Task: ${p.currentTask}`);
    if (p.currentTool) lines.push(`  - Current Tool: ${p.currentTool}`);
    if (p.model) lines.push(`  - Model: ${p.model}`);
    if (p.promptTokens || p.completionTokens) lines.push(`  - Tokens: ${p.promptTokens || 0} prompt / ${p.completionTokens || 0} completion`);
    if (p.sessionId) lines.push(`  - Session ID: ${p.sessionId}`);
    if (p.recentLogs && p.recentLogs.length > 0) {
      lines.push(`  - Recent Activity Logs (last 3):`);
      for (const log of p.recentLogs.slice(-3)) {
        lines.push(`      ${log}`);
      }
    }
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

  lines.push(`\nRunning Background Tasks (${runningProcs.length}):`);
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

  await callServerApi("/api/superagents/pause", "POST", { superagentId });

  const inst = superagentInstances.get(superagentId);
  if (inst) {
    inst.status = "paused";
    return {
      content: [{ type: "text", text: `Superagent ${superagentId} (${inst.role}) paused.` }],
    };
  }

  return {
    content: [{ type: "text", text: `Superagent ${superagentId} paused (dispatched).` }],
  };
}

export async function handleResume(args: any): Promise<McpToolResult> {
  const superagentId = String(args.superagentId || args.id || args.target || "");
  if (!superagentId) {
    return {
      content: [{ type: "text", text: "Error: 'superagentId' is required to resume." }],
      isError: true,
    };
  }

  await callServerApi("/api/superagents/resume", "POST", { superagentId });

  const inst = superagentInstances.get(superagentId);
  if (inst) {
    inst.status = "running";
    return {
      content: [{ type: "text", text: `Superagent ${superagentId} (${inst.role}) resumed.` }],
    };
  }

  return {
    content: [{ type: "text", text: `Superagent ${superagentId} resumed (dispatched).` }],
  };
}

export async function handleGetStatus(args: any): Promise<McpToolResult> {
  const id = String(args.id || args.superagentId || args.subagentId || args.taskId || "");
  if (!id) {
    return await handleGetProcessStatus();
  }

  // 1. Check if id is a PID in the process journal
  const processes = loadActiveProcesses();
  const matchedProc = processes.find((p) => String(p.pid) === id || p.sessionId === id);
  if (matchedProc) {
    const ageSec = Math.round((Date.now() - matchedProc.startedAt) / 1000);
    const m = Math.floor(ageSec / 60);
    const s = ageSec % 60;
    const uptimeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;

    const lines = [
      `Status for Process PID ${matchedProc.pid} (${matchedProc.mode.toUpperCase()}):`,
      `  - Workspace: ${matchedProc.workingDirectory}`,
      `  - State: ${matchedProc.isAgentRunning ? "🟢 RUNNING" : "⚪ IDLE"} (${matchedProc.currentStatus || "Idle"})`,
      `  - Current Task: ${matchedProc.currentTask || "(none)"}`,
      `  - Active Tool: ${matchedProc.currentTool || "(none)"}`,
      `  - Model: ${matchedProc.model || "(default)"}`,
      `  - Tokens: ${matchedProc.promptTokens || 0} prompt / ${matchedProc.completionTokens || 0} completion`,
      `  - Uptime: ${uptimeStr}`,
    ];
    if (matchedProc.recentLogs && matchedProc.recentLogs.length > 0) {
      lines.push(`  - Recent Logs:`);
      for (const log of matchedProc.recentLogs.slice(-5)) {
        lines.push(`      ${log}`);
      }
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  // 2. Check in server API
  const serverRes = await callServerApi("/api/instances", "GET");
  if (serverRes.success && serverRes.data) {
    const all = [
      ...(serverRes.data.superagents || []),
      ...(serverRes.data.subagents || []),
      ...(serverRes.data.procs || []),
    ];
    const found = all.find((item: any) => item.id === id);
    if (found) {
      return {
        content: [{ type: "text", text: `Status for ${id}:\n${JSON.stringify(found, null, 2)}` }],
      };
    }
  }

  // 3. Check in memory
  const superagent = superagentInstances.get(id);
  if (superagent) {
    return {
      content: [
        {
          type: "text",
          text: `Superagent [${id}]:\n  Role: ${superagent.role}\n  Branch: ${superagent.branch}\n  Status: ${superagent.status}\n  Task: ${superagent.task}\n  Worktree: ${superagent.worktreePath || "none"}\n  Result: ${superagent.result || "none"}`,
        },
      ],
    };
  }

  const subagent = subagentInstances.get(id);
  if (subagent) {
    return {
      content: [
        {
          type: "text",
          text: `Subagent [${id}]:\n  Type: ${subagent.typeName}\n  Role: ${subagent.role}\n  Status: ${subagent.status}\n  Prompt: ${subagent.prompt || "none"}\n  Result: ${subagent.result || "none"}`,
        },
      ],
    };
  }

  const task = backgroundTasks.get(id);
  if (task) {
    return {
      content: [
        {
          type: "text",
          text: `Background Task [${id}]:\n  Command: ${task.command}\n  PID: ${task.process?.pid || "unknown"}\n  Exited: ${task.hasExited}\n  ExitCode: ${task.exitCode ?? "none"}`,
        },
      ],
    };
  }

  return {
    content: [{ type: "text", text: `No instance, process, or task found with ID: ${id}` }],
    isError: true,
  };
}

export async function handleGetLogs(args: any): Promise<McpToolResult> {
  const rawId = args.id || args.superagentId || args.subagentId || args.taskId;
  const id = rawId ? String(rawId).trim() : "";
  const limit = typeof args.limit === "number" ? Math.min(args.limit, 200) : (typeof args.lines === "number" ? Math.min(args.lines, 200) : 50);

  // 1. If id is empty, "all", "current", "latest", or numeric PID:
  const processes = loadActiveProcesses();
  const nonMcpProcs = processes.filter((p) => p.mode !== "mcp");

  if (!id || id === "all" || id === "current" || id === "latest" || /^\d+$/.test(id)) {
    const targetProc = /^\d+$/.test(id)
      ? processes.find((p) => String(p.pid) === id)
      : nonMcpProcs[0];

    if (targetProc && targetProc.recentLogs && targetProc.recentLogs.length > 0) {
      const recent = targetProc.recentLogs.slice(-limit).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `=== Logs for Process PID ${targetProc.pid} (${targetProc.workingDirectory}) ===\n${recent}`,
          },
        ],
      };
    }

    // Fallback to global superagent.log
    try {
      const logFile = path.join(getGlobalConfigDir(), "superagent.log");
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, "utf-8");
        const lines = content.split("\n").filter(Boolean);
        const sliced = lines.slice(-limit).join("\n");
        return {
          content: [
            {
              type: "text",
              text: `=== Global Superagent Logs (last ${Math.min(limit, lines.length)} lines) ===\n${sliced}`,
            },
          ],
        };
      }
    } catch {}
  }

  // 2. Check running server API
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

  // 3. Check in-memory instances
  const inst = superagentInstances.get(id) || subagentInstances.get(id);
  if (inst && Array.isArray(inst.logs)) {
    const recent = inst.logs.slice(-limit).join("");
    return {
      content: [{ type: "text", text: `Logs for ${id}:\n${recent || "(no logs)"}` }],
    };
  }

  // 4. Check background tasks
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

  // 5. Check global process activity
  const activity = getProcessActivity();
  if (activity.recentLogs && activity.recentLogs.length > 0) {
    const recent = activity.recentLogs.slice(-limit).join("\n");
    return {
      content: [{ type: "text", text: `Process Activity Logs:\n${recent}` }],
    };
  }

  return {
    content: [{ type: "text", text: `No instance, task, or process found with ID: ${id}` }],
  };
}
