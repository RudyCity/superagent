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
  getActiveToolOutput,
} from "../tools/state.js";
import { getCurrentCommandLogPath } from "../tools/commandLogger.js";

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
  currentCommandLogPath?: string;
  activeToolOutput?: string;
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

export function normalizeProcessSession(entry: ActiveProcessEntry): { entry: ActiveProcessEntry; changed: boolean } {
  let changed = false;

  // 1. Detect if taskFilePath or planFilePath points to a subagent folder
  const candidatePath = entry.taskFilePath || entry.planFilePath || "";
  const subagentMatch = candidatePath.match(
    /[\\\/]history[\\\/](?:single|multi)[\\\/](sess_[^\\\/]+)[\\\/]subagents[\\\/]/i
  );

  let rootSessionId = subagentMatch?.[1];

  // 2. If no subagent path match, but sessionId is given, check if that session folder itself is a subagent of a parent session
  if (!rootSessionId && entry.sessionId) {
    try {
      const historyRoot = path.join(getRootConfigDir(), "history");
      for (const m of ["single", "multi"]) {
        const modeDir = path.join(historyRoot, m);
        if (!fs.existsSync(modeDir)) continue;
        const parents = fs.readdirSync(modeDir);
        for (const parent of parents) {
          const subDir = path.join(modeDir, parent, "subagents", entry.sessionId);
          if (fs.existsSync(subDir)) {
            rootSessionId = parent;
            break;
          }
        }
        if (rootSessionId) break;
      }
    } catch {}
  }

  // 3. If a parent session was detected, normalize entry.sessionId, taskFilePath, and planFilePath
  if (rootSessionId) {
    if (entry.sessionId !== rootSessionId) {
      entry.sessionId = rootSessionId;
      changed = true;
    }
    const mode = entry.mode === "multi" ? "multi" : "single";
    const modeDir = path.join(getRootConfigDir(), "history", mode, rootSessionId);
    const parentTask = path.join(modeDir, `${rootSessionId}_task.md`);
    if (fs.existsSync(parentTask) && entry.taskFilePath !== parentTask) {
      entry.taskFilePath = parentTask;
      changed = true;
    }
    const parentPlan = path.join(modeDir, `${rootSessionId}_implementation_plan.md`);
    if (fs.existsSync(parentPlan) && entry.planFilePath !== parentPlan) {
      entry.planFilePath = parentPlan;
      changed = true;
    }
  }

  // 4. If the process is idle and taskFilePath exists, ensure currentTask reflects the active task checklist step
  if (!entry.isAgentRunning && entry.taskFilePath && fs.existsSync(entry.taskFilePath)) {
    try {
      const content = fs.readFileSync(entry.taskFilePath, "utf-8");
      const lines = content.split(/\r?\n/);
      let inProgressTask: string | null = null;
      let pendingTask: string | null = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- [/]") || trimmed.startsWith("* [/]")) {
          inProgressTask = trimmed.replace(/^[-*]\s*\[\/\]\s*/, "").trim();
          break;
        }
        if (!pendingTask && (trimmed.startsWith("- [ ]") || trimmed.startsWith("* [ ]"))) {
          pendingTask = trimmed.replace(/^[-*]\s*\[\s\]\s*/, "").trim();
        }
      }
      const activeTask = inProgressTask || pendingTask;
      if (activeTask && (rootSessionId || !entry.currentTask || !content.includes(entry.currentTask.trim()))) {
        entry.currentTask = activeTask;
        entry.currentTaskStatus = inProgressTask ? "in_progress" : "pending";
        changed = true;
      }
    } catch {}
  }

  return { entry, changed };
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
          const { entry, changed } = normalizeProcessSession(item);
          if (changed) dirty = true;
          alive.push(entry);
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
        sessionId: masterAgentRef?.sessionId || (masterAgentRef?.getSessionId ? masterAgentRef.getSessionId() : undefined) || activity.sessionId,
        taskFilePath: resolvedTaskFilePath,
        planFilePath: resolvedPlanFilePath,
        model: activity.model,
        promptTokens: activity.promptTokens || masterPromptTokens,
        completionTokens: activity.completionTokens || masterCompletionTokens,
        activeSuperagents,
        activeSubagents,
        backgroundTaskCount: backgroundTasks.size,
        recentLogs: (activity.recentLogs || []).slice(-30),
        currentCommandLogPath: getCurrentCommandLogPath(),
        activeToolOutput: getActiveToolOutput() || undefined,
      };

      const { entry: normalizedEntry } = normalizeProcessSession(entry);
      const currentList = loadActiveProcesses().filter((p) => p.pid !== pid);
      currentList.push(normalizedEntry);
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
