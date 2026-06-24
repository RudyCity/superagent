import path from "path";
import fs from "fs";
import { getGlobalConfigDir, ensureGlobalConfigDir, getRootConfigDir } from "../config.js";
import { 
  BackgroundTask, 
  TaskChangeListener, 
  ActiveOutputListener, 
  ScheduleJob, 
  SubagentType, 
  SubagentInstance, 
  SuperagentInstance,
  SuperagentType,
  QuestionHandler 
} from "./types.js";

export const backgroundTasks = new Map<string, BackgroundTask>();
export const taskChangeListeners = new Set<TaskChangeListener>();
export const activeOutputListeners = new Set<ActiveOutputListener>();
export let activeToolOutput = "";

interface PersistedTask {
  id: string;
  command: string;
  pid: number;
  logPath?: string;
  isDetachedWindow?: boolean;
  windowLabel?: string;
  autoRetry?: boolean;
  onExit?: string;
  hasExited: boolean;
  exitCode?: number | null;
}

function acquireTasksLockSync(lockPath: string): boolean {
  const start = Date.now();
  const timeoutMs = 2000;
  while (Date.now() - start < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        try {
          fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        } catch {}
      }
      // Simple sleep/retry
      const sab = new SharedArrayBuffer(4);
      const int32 = new Int32Array(sab);
      try { Atomics.wait(int32, 0, 0, 50); } catch {
        const end = Date.now() + 50;
        while (Date.now() < end) {}
      }
    }
  }
  return false;
}

function releaseTasksLockSync(lockPath: string) {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

export function savePersistedTasks(): void {
  const rootDir = getRootConfigDir();
  if (!rootDir) return;
  const tasksFilePath = path.join(rootDir, "background-tasks.json");
  const lockPath = tasksFilePath + ".lock";

  if (!acquireTasksLockSync(lockPath)) {
    return;
  }

  try {
    const list: PersistedTask[] = [];
    for (const [id, task] of backgroundTasks.entries()) {
      list.push({
        id: task.id,
        command: task.command,
        pid: task.process?.pid || 0,
        logPath: task.logPath,
        isDetachedWindow: task.isDetachedWindow,
        windowLabel: task.windowLabel,
        autoRetry: task.autoRetry,
        onExit: task.onExit,
        hasExited: !!task.hasExited,
        exitCode: task.exitCode,
      });
    }
    fs.writeFileSync(tasksFilePath, JSON.stringify(list, null, 2), "utf-8");
  } catch (err) {
    // Ignore errors
  } finally {
    releaseTasksLockSync(lockPath);
  }
}

// Global flag to prevent re-entrant calls to loadAndSyncPersistedTasks
let isSyncing = false;

export function loadAndSyncPersistedTasks(): void {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const rootDir = getRootConfigDir();
    if (!rootDir) return;
    const tasksFilePath = path.join(rootDir, "background-tasks.json");
    if (!fs.existsSync(tasksFilePath)) {
      return;
    }

    const lockPath = tasksFilePath + ".lock";
    if (!acquireTasksLockSync(lockPath)) {
      return;
    }

    try {
      const content = fs.readFileSync(tasksFilePath, "utf-8");
      const list = JSON.parse(content) as PersistedTask[];
      let changed = false;

      for (const item of list) {
        let isAlive = false;
        if (item.pid > 0) {
          try {
            process.kill(item.pid, 0);
            isAlive = true;
          } catch (e: any) {
            isAlive = (e.code === "EPERM");
          }
        }

        const hasExited = !isAlive;
        const exitCode = hasExited ? (item.exitCode ?? -1) : null;

        const existing = backgroundTasks.get(item.id);
        if (existing) {
          if (existing.hasExited !== hasExited) {
            existing.hasExited = hasExited;
            existing.exitCode = exitCode;
            changed = true;
          }
        } else {
          const restoredTask: BackgroundTask = {
            id: item.id,
            command: item.command,
            process: {
              pid: item.pid,
              killed: hasExited,
              stdin: null,
            },
            output: [],
            logPath: item.logPath,
            hasExited,
            exitCode,
            isDetachedWindow: item.isDetachedWindow,
            windowLabel: item.windowLabel,
            autoRetry: item.autoRetry,
            onExit: item.onExit,
          };
          if (item.logPath && fs.existsSync(item.logPath)) {
            try {
              const logs = fs.readFileSync(item.logPath, "utf-8");
              restoredTask.output = logs.split("\n").map(l => l + "\n").slice(-1000);
            } catch {}
          }
          backgroundTasks.set(item.id, restoredTask);
          changed = true;
        }
      }

      if (changed) {
        const updatedList: PersistedTask[] = [];
        for (const [id, task] of backgroundTasks.entries()) {
          updatedList.push({
            id: task.id,
            command: task.command,
            pid: task.process?.pid || 0,
            logPath: task.logPath,
            isDetachedWindow: task.isDetachedWindow,
            windowLabel: task.windowLabel,
            autoRetry: task.autoRetry,
            onExit: task.onExit,
            hasExited: !!task.hasExited,
            exitCode: task.exitCode,
          });
        }
        fs.writeFileSync(tasksFilePath, JSON.stringify(updatedList, null, 2), "utf-8");
      }

      if (changed) {
        setTimeout(() => {
          for (const listener of taskChangeListeners) {
            listener();
          }
        }, 0);
      }
    } catch (err) {
      // Ignore errors
    } finally {
      releaseTasksLockSync(lockPath);
    }
  } finally {
    isSyncing = false;
  }
}

export function subscribeToTasks(listener: TaskChangeListener) {
  taskChangeListeners.add(listener);
  return () => {
    taskChangeListeners.delete(listener);
  };
}

export function notifyTasksChanged() {
  if (!isSyncing) {
    savePersistedTasks();
  }
  for (const listener of taskChangeListeners) {
    listener();
  }
}

export function subscribeToActiveOutput(listener: ActiveOutputListener) {
  activeOutputListeners.add(listener);
  return () => {
    activeOutputListeners.delete(listener);
  };
}

export function getActiveToolOutput() {
  return activeToolOutput;
}

export function clearActiveToolOutput() {
  activeToolOutput = "";
  for (const listener of activeOutputListeners) {
    listener("");
  }
}

export function appendActiveToolOutput(text: string) {
  activeToolOutput += text;
  const lines = activeToolOutput.split("\n");
  if (lines.length > 50) {
    activeToolOutput = lines.slice(lines.length - 50).join("\n");
  }
  for (const listener of activeOutputListeners) {
    listener(activeToolOutput);
  }
}

export const scheduledJobs = new Map<string, ScheduleJob>();
export type ScheduleChangeListener = (jobId: string, prompt: string) => void;
export const scheduleChangeListeners = new Set<ScheduleChangeListener>();

export function subscribeToSchedules(listener: ScheduleChangeListener) {
  scheduleChangeListeners.add(listener);
  return () => {
    scheduleChangeListeners.delete(listener);
  };
}

export function notifyScheduleTriggered(jobId: string, prompt: string) {
  for (const listener of scheduleChangeListeners) {
    listener(jobId, prompt);
  }
}

export const subagentTypes = new Map<string, SubagentType>();
export const subagentInstances = new Map<string, SubagentInstance>();

export const superagentTypes = new Map<string, SuperagentType>();

export type SubagentChangeListener = () => void;
export const subagentChangeListeners = new Set<SubagentChangeListener>();

export function subscribeToSubagents(listener: SubagentChangeListener) {
  subagentChangeListeners.add(listener);
  return () => {
    subagentChangeListeners.delete(listener);
  };
}

export function notifySubagentsChanged() {
  for (const listener of subagentChangeListeners) {
    listener();
  }
}

export function registerSubagentType(name: string, description: string, systemPrompt: string) {
  subagentTypes.set(name, { name, description, systemPrompt });
}

export function registerSuperagentType(name: string, description: string, systemPrompt: string) {
  superagentTypes.set(name, { name, description, systemPrompt });
}

export let activeQuestionHandler: QuestionHandler | null = null;

export function registerQuestionHandler(handler: QuestionHandler | null) {
  activeQuestionHandler = handler;
}

export function getActiveQuestionHandler(): QuestionHandler | null {
  return activeQuestionHandler;
}

// ─── Master Agent Reference ──────────────────────────────────────────────────
// Global reference to the Master Agent instance. Used by Subagents and
// Superagents to route ask_question requests to the Master for answering
// (instead of forwarding directly to the user UI).

export let masterAgentRef: any = null;

export function registerMasterAgent(agent: any | null) {
  masterAgentRef = agent;
}

export function getMasterAgent(): any {
  return masterAgentRef;
}

// ─── Superagent Instances ────────────────────────────────────────────────────

export const superagentInstances = new Map<string, SuperagentInstance>();
export let historicalSuperagentTokens = 0;
export function addHistoricalSuperagentTokens(tokens: number) {
  historicalSuperagentTokens += tokens || 0;
}
export function setHistoricalSuperagentTokens(tokens: number) {
  historicalSuperagentTokens = tokens || 0;
}

export let masterPromptTokens = 0;
export let masterCompletionTokens = 0;
export let lastMasterPromptTokens = 0;

export function addMasterTokens(prompt: number, completion: number) {
  masterPromptTokens += prompt || 0;
  masterCompletionTokens += completion || 0;
  lastMasterPromptTokens = prompt || 0;
  notifySuperagentsChanged();
}

export function setMasterTokens(prompt: number, completion: number) {
  masterPromptTokens = prompt || 0;
  masterCompletionTokens = completion || 0;
}

export function setLastMasterPromptTokens(prompt: number) {
  lastMasterPromptTokens = prompt || 0;
  notifySuperagentsChanged();
}

export type SuperagentChangeListener = () => void;
export const superagentChangeListeners = new Set<SuperagentChangeListener>();

export function subscribeToSuperagents(listener: SuperagentChangeListener) {
  superagentChangeListeners.add(listener);
  return () => superagentChangeListeners.delete(listener);
}

export function notifySuperagentsChanged() {
  for (const listener of superagentChangeListeners) {
    listener();
  }
}

// ─── Master Log Listeners ───────────────────────────────────────────────────

export type MasterLogListener = (msg: string) => void;
export const masterLogListeners = new Set<MasterLogListener>();

export function subscribeToMasterLogs(listener: MasterLogListener) {
  masterLogListeners.add(listener);
  return () => {
    masterLogListeners.delete(listener);
  };
}

export function appendMasterLog(msg: string) {
  for (const listener of masterLogListeners) {
    listener(msg);
  }
}

// ─── Tools Error Log ─────────────────────────────────────────────────────────
// Dedicated log file for tool execution errors across all tiers.

export function appendToolsErrorLog(tier: string, depth: number, toolName: string, message: string, meta?: Record<string, unknown>): void {
  try {
    ensureGlobalConfigDir();
    const logPath = path.join(getGlobalConfigDir(), "superagent-tools.log");
    const timestamp = new Date().toISOString();
    const metaStr = meta && Object.keys(meta).length > 0 ? ` | meta:${JSON.stringify(meta)}` : "";
    const line = `[${timestamp}] [tier:${tier}] [depth:${depth}] [tool:${toolName}] ${message}${metaStr}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch {
    // Ignore log write errors to prevent crashing the agent
  }
}

// ─── TTL Cleanup ─────────────────────────────────────────────────────────────

const INSTANCE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function cleanupStaleInstances(): void {
  const now = Date.now();
  for (const [id, inst] of superagentInstances.entries()) {
    if (inst.status !== "running" && inst.completedAt) {
      if (now - inst.completedAt > INSTANCE_TTL_MS) {
        superagentInstances.delete(id);
      }
    }
  }
  for (const [id, inst] of subagentInstances.entries()) {
    if (inst.status === "completed" && inst.completedAt) {
      if (now - inst.completedAt > INSTANCE_TTL_MS) {
        subagentInstances.delete(id);
      }
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleInstances, 5 * 60 * 1000).unref();

// Initial load and periodic synchronization of background tasks
try {
  loadAndSyncPersistedTasks();
  setInterval(loadAndSyncPersistedTasks, 3000).unref();
} catch {}
