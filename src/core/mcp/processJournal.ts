/**
 * processJournal.ts — Real-time persistent process and session registry for Superagent CLI & Server.
 *
 * Allows MCP servers, background daemons, and external tools to discover all live running
 * Superagent interactive CLI sessions, servers, and multi-agent workers across the machine
 * with deep runtime visibility (current prompt/task, active tool, status, model, tokens, recent logs).
 */

import fs from "fs";
import path from "path";
import { getRootConfigDir } from "../config/paths.js";
import {
  superagentInstances,
  subagentInstances,
  backgroundTasks,
  masterAgentRef,
  getProcessActivity,
  subscribeToProcessActivity,
  subscribeToSuperagents,
  masterPromptTokens,
  masterCompletionTokens,
} from "../tools/state.js";

export interface ActiveProcessSuperagent {
  id: string;
  role: string;
  branch: string;
  status: string;
  task?: string;
  worktreePath?: string;
  historyFilePath?: string;
  taskFilePath?: string;
}

export interface ActiveProcessEntry {
  pid: number;
  mode: "single" | "multi" | "server" | "mcp" | "cli";
  workingDirectory: string;
  startedAt: number;
  lastHeartbeat: number;
  isAgentRunning?: boolean;
  currentTask?: string;
  currentTaskStep?: string;
  currentTaskStatus?: "in_progress" | "pending" | "completed" | "none";
  currentTool?: string;
  currentStatus?: string;
  sessionId?: string;
  taskFilePath?: string;
  planFilePath?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  activeSuperagents?: ActiveProcessSuperagent[];
  activeSubagents?: Array<{ id: string; typeName: string; role: string; status: string; prompt?: string }>;
  backgroundTaskCount?: number;
  recentLogs?: string[];
}

function getProcessJournalPath(): string {
  return path.join(getRootConfigDir(), "active-processes.json");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM"; // Process exists but we don't have permission to signal it
  }
}

export function loadActiveProcesses(): ActiveProcessEntry[] {
  try {
    const filePath = getProcessJournalPath();
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf-8");
    const list = JSON.parse(content);
    if (!Array.isArray(list)) return [];

    const now = Date.now();
    const alive: ActiveProcessEntry[] = [];
    let dirty = false;

    for (const item of list) {
      if (item && typeof item.pid === "number") {
        // Drop processes that died or haven't sent a heartbeat in > 20 seconds
        if (isPidAlive(item.pid) && now - (item.lastHeartbeat || 0) < 20000) {
          alive.push(item);
        } else {
          dirty = true;
        }
      }
    }

    if (dirty) {
      saveActiveProcesses(alive);
    }
    return alive;
  } catch {
    return [];
  }
}

function saveActiveProcesses(list: ActiveProcessEntry[]): void {
  try {
    const filePath = getProcessJournalPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(list, null, 2), "utf-8");
  } catch {}
}

let heartbeatTimer: NodeJS.Timeout | null = null;
let globalTriggerUpdate: (() => void) | null = null;

export function triggerProcessUpdate(): void {
  try {
    globalTriggerUpdate?.();
  } catch {}
}

export function registerCurrentProcess(mode: "single" | "multi" | "server" | "mcp" | "cli"): void {
  const pid = process.pid;
  const cwd = process.cwd();
  const startedAt = Date.now();

  const update = () => {
    try {
      const activeSuperagents = [...superagentInstances.values()].map((i) => {
        let taskFilePath = i.historyFilePath ? i.historyFilePath.replace(/\.json$/, "_task.md") : undefined;
        if (i.agent?.getTaskFilePath) {
          try {
            taskFilePath = i.agent.getTaskFilePath();
          } catch {}
        }
        return {
          id: i.id,
          role: i.role,
          branch: i.branch,
          status: i.status,
          task: i.task,
          worktreePath: i.worktreePath,
          historyFilePath: i.historyFilePath,
          taskFilePath,
        };
      });

      const activeSubagents = [...subagentInstances.values()].map((s) => ({
        id: s.id,
        typeName: s.typeName,
        role: s.role,
        status: s.status,
        prompt: s.prompt,
      }));

      const activity = getProcessActivity();
      const isRunning =
        activity.isAgentRunning ||
        (masterAgentRef ? (masterAgentRef.isAgentRunning?.() ?? false) : false);

      let resolvedTaskFilePath = activity.taskFilePath;
      let resolvedPlanFilePath = activity.planFilePath;
      if (!resolvedTaskFilePath && masterAgentRef?.getTaskFilePath) {
        try {
          resolvedTaskFilePath = masterAgentRef.getTaskFilePath();
        } catch {}
      }
      if (!resolvedPlanFilePath && masterAgentRef?.getPlanFilePath) {
        try {
          resolvedPlanFilePath = masterAgentRef.getPlanFilePath();
        } catch {}
      }

      const entry: ActiveProcessEntry = {
        pid,
        mode,
        workingDirectory: activity.workingDirectory || cwd,
        startedAt,
        lastHeartbeat: Date.now(),
        isAgentRunning: isRunning,
        currentTask: activity.currentTask,
        currentTaskStatus: activity.currentTaskStatus || (isRunning ? "in_progress" : "pending"),
        currentTool: activity.currentTool,
        currentStatus: activity.currentStatus || (isRunning ? "Running" : "Idle"),
        sessionId: activity.sessionId || masterAgentRef?.sessionId,
        taskFilePath: resolvedTaskFilePath,
        planFilePath: resolvedPlanFilePath,
        model: activity.model,
        promptTokens: activity.promptTokens || masterPromptTokens,
        completionTokens: activity.completionTokens || masterCompletionTokens,
        activeSuperagents,
        activeSubagents,
        backgroundTaskCount: backgroundTasks.size,
        recentLogs: (activity.recentLogs || []).slice(-30),
      };

      const currentList = loadActiveProcesses().filter((p) => p.pid !== pid);
      currentList.push(entry);
      saveActiveProcesses(currentList);
    } catch {}
  };

  globalTriggerUpdate = update;
  update();

  // Instant sync whenever process activity or superagents change
  subscribeToProcessActivity(() => update());
  subscribeToSuperagents(() => update());

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(update, 2000);
    heartbeatTimer.unref();
  }

  const cleanup = () => {
    try {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const remaining = loadActiveProcesses().filter((p) => p.pid !== pid);
      saveActiveProcesses(remaining);
    } catch {}
  };

  process.on("exit", cleanup);
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
