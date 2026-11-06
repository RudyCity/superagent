/**
 * SuperAgent Desktop Terminal & Background Process Manager
 *
 * Provides inspection, log tailing, process lifecycle control, and preset
 * execution for terminal tasks and background subprocesses running in the workspace.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import {
  backgroundTasks,
  loadAndSyncPersistedTasks,
  savePersistedTasks,
  notifyTasksChanged,
} from "../tools/state.js";
import { killProcessTree } from "../tools/helpers.js";
import { getWorkspaceTasksFromDb, pruneExitedWorkspaceTasksFromDb } from "../storage/historyDb.js";
import { getWorkspaceId } from "../config/paths.js";
import { getWorkspaceTasksLogDir } from "../config.js";
import { applyProcessIntent } from "../process/processSpawnPolicy.js";
import { getProcessSupervisor } from "../process/processSupervisor.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import { getCommandLogsDir } from "../tools/commandLogger.js";
import { discoverExternalTerminalProcesses } from "./externalTerminalProcesses.js";
import { suspendOwnedTerminalProcess, resumeOwnedTerminalProcess, type SuspendedProcess } from "./desktopTerminalSuspend.js";

// Never populated from persisted PIDs or external discovery. Only this Core's live spawn handles.
const ownedTerminalIdentities = new Map<string, Promise<string | null>>();
const pausedTerminalTrees = new Map<string, SuspendedProcess[]>();
const terminalControls = new Set<string>();

export interface DesktopTerminalTaskInfo {
  id: string;
  command: string;
  pid: number;
  status: "running" | "paused" | "exited" | "killed" | "unverified";
  cwd: string;
  windowLabel?: string;
  isDetachedWindow?: boolean;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number | null;
  durationMs?: number;
  logPath?: string;
  lastOutput?: string;
  isTerminal: boolean;
  source?: "mcp" | "agent" | "background" | "tray" | "external";
  canStop?: boolean;
  canStart?: boolean;
  canPause?: boolean;
  canResume?: boolean;
  canViewLogs?: boolean;
}

export interface TerminalPresetInfo {
  name: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  label?: string;
}

function checkPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function readLogTail(logPath?: string, maxLines = 10): string {
  if (!logPath || !fs.existsSync(logPath)) return "";
  try {
    const stats = fs.statSync(logPath);
    const readSize = Math.min(stats.size, 16 * 1024);
    const buffer = Buffer.alloc(readSize);
    const fd = fs.openSync(logPath, "r");
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);
    const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

export class DesktopTerminalManager {
  /**
   * List all terminal and background tasks, checking OS process aliveness.
   */
  static async listTasks(options?: { runningOnly?: boolean; search?: string }): Promise<{
    tasks: DesktopTerminalTaskInfo[];
    runningCount: number;
    totalCount: number;
  }> {
    try {
      loadAndSyncPersistedTasks();
    } catch {}

    const workspaceId = getWorkspaceId();
    const dbTasks = getWorkspaceTasksFromDb(workspaceId) || [];
    const merged = new Map<string, DesktopTerminalTaskInfo>();

    const now = Date.now();

    // 1. Ingest persisted SQLite tasks
    for (const item of dbTasks) {
      const pid = item.pid || 0;
      const isTerminal = item.id.startsWith("term-") || !!item.isDetachedWindow;
      const hasExited = !!item.completedAt || (item.exitCode !== null && item.exitCode !== undefined) || item.hasExited;
      // If it already completed or exited in storage, it is strictly exited.
      // Recycled OS PIDs must never cause historical completed tasks to appear as unverified or active.
      const isAlive = !hasExited && checkPidAlive(pid);
      const status: DesktopTerminalTaskInfo["status"] = isAlive
        ? "unverified"
        : item.exitCode !== null && item.exitCode !== undefined
        ? "exited"
        : "killed";

      merged.set(item.id, {
        id: item.id,
        command: item.command || "",
        pid,
        status,
        cwd: item.cwd || process.cwd(),
        windowLabel: item.windowLabel,
        isDetachedWindow: item.isDetachedWindow,
        completedAt: item.completedAt,
        exitCode: item.exitCode,
        logPath: item.logPath,
        isTerminal,
        lastOutput: readLogTail(item.logPath, 5),
        source: isTerminal ? "tray" : "background",
        canStop: false,
        canStart: item.id.startsWith("term-bg-") && !isAlive && !!item.command?.trim() &&
          !!item.cwd && fs.existsSync(item.cwd),
      });
    }

    // 2. Ingest foreground shell executions recorded by Process Supervisor.
    // MCP superagent_exec_command records component=mcp_exec_command.
    // Agent bash/run_command records component=shell_tool.
    try {
      const supervisor = getProcessSupervisor();
      await supervisor.initialize();
      for (const record of supervisor.getRegistry().listRecords()) {
        if (record.component !== "mcp_exec_command" && record.component !== "shell_tool") continue;

        const command = record.sanitizedArgs.join(" ").trim() || record.executable || "(unknown command)";
        const cwd = record.ownership?.workspaceRoot || process.cwd();
        const stateClaimsRunning = record.state === "registered" || record.state === "running";
        const pidAlive = typeof record.pid === "number" && checkPidAlive(record.pid);
        // Presence alone is not ownership. Verify the recorded process birth
        // fingerprint and generation before showing it as actively running.
        const observedIdentity = stateClaimsRunning && pidAlive && record.creationIdentity
          ? await readProcessStartIdentity(record.pid)
          : null;
        const ownership = supervisor.getRegistry().verifyOwnership(
          record.recordId, observedIdentity,
          pidAlive ? "pid_present_unverified" : "pid_absent",
        );
        const isRunning = stateClaimsRunning && ownership.status === "verified_owner";
        const status: DesktopTerminalTaskInfo["status"] = isRunning
          ? "running"
          : record.state === "terminated"
          ? "killed"
          : stateClaimsRunning && pidAlive
          ? "unverified"
          : "exited";
        const commandLogId = record.ownership?.taskId;
        const logPath = commandLogId && /^cmd_\d{10,16}_[a-z0-9]{5}$/.test(commandLogId)
          ? path.join(getCommandLogsDir(), `${commandLogId}.log`)
          : undefined;

        merged.set(record.recordId, {
          id: record.recordId,
          command,
          pid: record.pid || 0,
          status,
          cwd,
          windowLabel: record.component === "mcp_exec_command" ? "MCP command" : "Agent command",
          startedAt: record.startedAt ?? record.registeredAt,
          completedAt: record.exitedAt,
          exitCode: record.exitCode,
          durationMs: record.terminalObservation?.durationMs,
          logPath,
          lastOutput: readLogTail(logPath, 5),
          isTerminal: true,
          source: record.component === "mcp_exec_command" ? "mcp" : "agent",
          canStop: false,
        });
      }
    } catch {}

    // 3. Overlay live in-memory background tasks
    for (const [id, task] of backgroundTasks.entries()) {
      const pid = task.process?.pid || 0;
      const hasExited = task.hasExited === true || task.process?.killed;
      const isAlive = !hasExited && checkPidAlive(pid);
      const hasOwnedHandle = typeof task.process?.on === "function" &&
        (!id.startsWith("term-bg-") || ownedTerminalIdentities.has(id));
      const status: DesktopTerminalTaskInfo["status"] = isAlive
        ? (!hasOwnedHandle ? "unverified" : pausedTerminalTrees.has(id) ? "paused" : "running")
        : task.exitCode !== null && task.exitCode !== undefined
        ? "exited"
        : "killed";

      const outputPreview =
        task.output && task.output.length > 0
          ? task.output.slice(-5).join("").trim()
          : readLogTail(task.logPath, 5);

      merged.set(id, {
        id,
        command: task.command || "",
        pid,
        status,
        cwd: task.cwd || process.cwd(),
        windowLabel: task.windowLabel,
        isDetachedWindow: task.isDetachedWindow,
        completedAt: task.completedAt,
        exitCode: task.exitCode,
        logPath: task.logPath,
        isTerminal: id.startsWith("term-") || !!task.isDetachedWindow,
        lastOutput: outputPreview,
        source: id.startsWith("term-") || !!task.isDetachedWindow ? "tray" : "background",
        canStop: isAlive && hasOwnedHandle,
        canStart: id.startsWith("term-bg-") && !isAlive && !!task.command?.trim(),
        canPause: id.startsWith("term-bg-") && isAlive && hasOwnedHandle &&
          !pausedTerminalTrees.has(id),
        canResume: id.startsWith("term-bg-") && isAlive && hasOwnedHandle && pausedTerminalTrees.has(id),
      });
    }

    // External server processes have no SuperAgent ownership lease or child handle.
    // Observing a listener never authorizes signaling the PID.
    const representedRunningPids = new Set(
      [...merged.values()]
        .filter((task) => (task.status === "running" || task.status === "paused") && task.pid > 0)
        .map((task) => task.pid),
    );
    for (const observed of await discoverExternalTerminalProcesses()) {
      if (representedRunningPids.has(observed.pid)) continue;
      const portsLabel = observed.ports.map((port) => ":" + port).join(", ");
      const id = "external-win-" + observed.pid;
      merged.set(id, {
        id,
        command: observed.name + " (listening on " + portsLabel + ")",
        pid: observed.pid,
        status: "running",
        cwd: "External process (working directory unavailable)",
        windowLabel: observed.name.replace(/\.exe$/i, "") + " · " + portsLabel,
        isTerminal: true,
        source: "external",
        canStop: false,
        canViewLogs: false,
      });
    }

    let allTasks = Array.from(merged.values());
    const runningCount = allTasks.filter((t) => t.status === "running").length;
    const totalCount = allTasks.length;

    if (options?.runningOnly) {
      allTasks = allTasks.filter((t) => t.status === "running" || t.status === "paused");
    }

    if (options?.search) {
      const q = options.search.toLowerCase().trim();
      allTasks = allTasks.filter(
        (t) =>
          t.id.toLowerCase().includes(q) ||
          t.command.toLowerCase().includes(q) ||
          (t.windowLabel && t.windowLabel.toLowerCase().includes(q)) ||
          t.cwd.toLowerCase().includes(q) ||
          (t.source && t.source.toLowerCase().includes(q)) ||
          String(t.pid).includes(q)
      );
    }

    // Sort: running first, then newest execution first across all sources.
    allTasks.sort((a, b) => {
      if (["running", "paused"].includes(a.status) && !["running", "paused"].includes(b.status)) return -1;
      if (["running", "paused"].includes(b.status) && !["running", "paused"].includes(a.status)) return 1;
      return (b.startedAt ?? b.completedAt ?? 0) - (a.startedAt ?? a.completedAt ?? 0)
        || b.id.localeCompare(a.id);
    });

    return {
      tasks: allTasks,
      runningCount,
      totalCount,
    };
  }

  /**
   * Terminate a running terminal or background process tree.
   */
  static killTask(taskId: string): { success: boolean; pid?: number; error?: string } {
    const task = backgroundTasks.get(taskId);
    let targetPid: number | undefined;

    if (task) {
      targetPid = task.process?.pid;
      if (task.hasExited || !targetPid || !checkPidAlive(targetPid) ||
          typeof task.process?.on !== "function" ||
          (taskId.startsWith("term-bg-") && !ownedTerminalIdentities.has(taskId))) {
        return { success: false, error: "No verified active owned process handle is available" };
      }
      try {
        if (targetPid) killProcessTree(targetPid);
      } catch {}
      task.hasExited = true;
      task.completedAt = Date.now();
      if (task.logPath) {
        try {
          fs.appendFileSync(
            task.logPath,
            `\n[Process terminated via Desktop Companion at ${new Date().toISOString()}]\n`
          );
        } catch {}
      }
      // Persist the stopped task BEFORE dropping its live child handle, so
      // the historical command remains restartable without PID reuse.
      try { savePersistedTasks(); } catch {}
      // Retain terminated Tray tasks in the history view for explicit Start;
      // other background task types keep their prior removal behavior.
      if (!taskId.startsWith("term-bg-")) backgroundTasks.delete(taskId);
      pausedTerminalTrees.delete(taskId);
      ownedTerminalIdentities.delete(taskId);
      notifyTasksChanged();
    } else {
      // A historical DB PID is not a live process lease. Never signal it:
      // Windows can reuse PIDs after the original process has exited.
      return { success: false, error: "Terminal task has no live owned process handle; stored PID cannot be stopped safely." };
    }

    try {
      savePersistedTasks();
    } catch {}

    return { success: true, pid: targetPid };
  }

  /**
   * Restart a previously Tray-launched task as a NEW process and task record.
   * A historical PID is never reused, signaled or treated as ownership.
   */
  static startTask(taskId: string) {
    if (!/^term-bg-[a-z0-9]{7}$/.test(taskId)) {
      throw new Error("Only Tray-launched terminal tasks may be started again");
    }
    const current = backgroundTasks.get(taskId);
    const stored = (getWorkspaceTasksFromDb(getWorkspaceId()) || [])
      .find((item) => item.id === taskId);
    const oldTask = current || stored;
    if (!oldTask || !oldTask.command?.trim()) {
      throw new Error("Original Tray command is not available");
    }
    const pid = current?.process?.pid || stored?.pid || 0;
    if ((current && !current.hasExited && checkPidAlive(pid)) ||
        (!current && stored && !stored.hasExited && !stored.completedAt && checkPidAlive(pid))) {
      throw new Error("Terminal task is already active or has an unverified live PID");
    }
    if (!oldTask.cwd || !fs.existsSync(oldTask.cwd) || !fs.statSync(oldTask.cwd).isDirectory()) {
      throw new Error("Original terminal working directory is unavailable");
    }
    return this.launchTask({ command: oldTask.command, cwd: oldTask.cwd });
  }

  /**
   * Pause/resume OS execution without killing or relaunching the task.
   * The task must have a real child-process handle created by THIS Core.
   * Restored/observed process entries can never gain signaling capability.
   */
  static async controlTask(taskId: string, action: "pause" | "resume") {
    if (!/^term-bg-[a-z0-9]{7}$/.test(taskId)) {
      throw new Error("Pause/Resume is restricted to Tray-owned terminal processes");
    }
    const task = backgroundTasks.get(taskId);
    const pid = task?.process?.pid;
    const identityPromise = ownedTerminalIdentities.get(taskId);
    if (!task || task.hasExited || !Number.isSafeInteger(pid) || pid <= 0 ||
        typeof task.process?.on !== "function" || !identityPromise || !checkPidAlive(pid)) {
      throw new Error("No live Tray-owned process handle is available");
    }
    if (terminalControls.has(taskId)) throw new Error("A terminal control action is already in progress");
    terminalControls.add(taskId);
    try {
      const paused = pausedTerminalTrees.get(taskId);
      if (action === "pause" && paused) throw new Error("Terminal is already paused");
      if (action === "resume" && !paused) throw new Error("Terminal is not paused");
      const expectedIdentity = await identityPromise;
      const actualIdentity = await readProcessStartIdentity(pid);
      if (!expectedIdentity || expectedIdentity !== actualIdentity) {
        throw new Error("Terminal process creation identity cannot be verified");
      }
      if (action === "pause") {
        const processes = await suspendOwnedTerminalProcess(pid, expectedIdentity);
        pausedTerminalTrees.set(taskId, processes);
      } else {
        await resumeOwnedTerminalProcess(pid, expectedIdentity, paused!);
        pausedTerminalTrees.delete(taskId);
      }
      const message = "[Terminal " + action + "d via SuperAgent Tray at " +
        new Date().toISOString() + "]\n";
      if (task.logPath) {
        try { fs.appendFileSync(task.logPath, message); } catch {}
      }
      notifyTasksChanged();
      return { success: true, taskId, status: action === "pause" ? "paused" : "running" };
    } finally {
      terminalControls.delete(taskId);
    }
  }

  /**
   * Prune completed, dead, or exited background tasks from memory and database storage.
   */
  static pruneStaleTasks(workspaceRoot?: string): {
    success: boolean;
    prunedCount: number;
    remainingRunningCount: number;
  } {
    let prunedCount = 0;

    // 1. Clean up dead or finished tasks in memory
    for (const [id, task] of backgroundTasks.entries()) {
      const pid = task.process?.pid || 0;
      const hasExited = task.hasExited === true || task.process?.killed;
      const isAlive = !hasExited && checkPidAlive(pid);
      if (!isAlive) {
        backgroundTasks.delete(id);
        prunedCount++;
      }
    }

    // 2. Clean up completed records from SQLite
    const workspaceId = getWorkspaceId(workspaceRoot);
    const dbPruned = pruneExitedWorkspaceTasksFromDb(workspaceId);
    prunedCount += dbPruned;

    try {
      savePersistedTasks();
      notifyTasksChanged();
    } catch {}

    const remainingRunningCount = Array.from(backgroundTasks.values()).filter(
      (t) => !t.hasExited && checkPidAlive(t.process?.pid || 0)
    ).length;

    return {
      success: true,
      prunedCount,
      remainingRunningCount,
    };
  }

  /**
   * Fetch complete or tail logs for a task.
   */
  static async getLogs(taskId: string, maxBytes = 128 * 1024): Promise<{
    taskId: string;
    command: string;
    logPath?: string;
    content: string;
  }> {
    const task = backgroundTasks.get(taskId);
    let logPath = task?.logPath;
    let command = task?.command || "";

    if (!logPath) {
      const workspaceId = getWorkspaceId();
      const dbTasks = getWorkspaceTasksFromDb(workspaceId) || [];
      const item = dbTasks.find((t) => t.task_id === taskId || t.id === taskId);
      if (item) {
        logPath = item.logPath;
        command = item.command || "";
      }
    }

    if (!logPath) {
      try {
        const supervisor = getProcessSupervisor();
        await supervisor.initialize();
        const record = supervisor.getRegistry().getRecord(taskId);
        if (record && (record.component === "mcp_exec_command" || record.component === "shell_tool")) {
          command = record.sanitizedArgs.join(" ").trim() || record.executable || "";
          const commandLogId = record.ownership?.taskId;
          if (commandLogId && /^cmd_\d{10,16}_[a-z0-9]{5}$/.test(commandLogId)) {
            logPath = path.join(getCommandLogsDir(), `${commandLogId}.log`);
          }
        }
      } catch {}
    }

    let content = "";
    if (logPath && fs.existsSync(logPath)) {
      try {
        const stats = fs.statSync(logPath);
        const readSize = Math.min(stats.size, maxBytes);
        const buffer = Buffer.alloc(readSize);
        const fd = fs.openSync(logPath, "r");
        fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
        fs.closeSync(fd);
        content = buffer.toString("utf8");
      } catch (err: any) {
        content = `[Failed to read log file: ${err.message}]`;
      }
    } else if (task && task.output && task.output.length > 0) {
      content = task.output.join("");
    } else {
      content = "[No logs available for this task]";
    }

    return {
      taskId,
      command,
      logPath,
      content,
    };
  }

  /**
   * Read configured terminal presets.
   */
  static getPresets(workspaceRoot = process.cwd()): TerminalPresetInfo[] {
    const localPresetDir = path.join(workspaceRoot, ".superagent-r");
    const localPresetPath = path.join(localPresetDir, "terminal-presets.json");
    const localRootPresetPath = path.join(workspaceRoot, "terminal-presets.json");
    const globalPresetPath = path.join(os.homedir(), ".superagent-r", "terminal-presets.json");

    const paths = [localPresetPath, localRootPresetPath, globalPresetPath];
    let presetsRaw: Record<string, any> = {};

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) {
          const content = fs.readFileSync(p, "utf-8");
          const parsed = JSON.parse(content);
          presetsRaw = parsed?.presets ?? parsed;
          if (Object.keys(presetsRaw).length > 0) break;
        }
      } catch {}
    }

    const result: TerminalPresetInfo[] = [];
    for (const [name, val] of Object.entries(presetsRaw)) {
      if (typeof val === "object" && val !== null) {
        result.push({
          name,
          command: val.command || "",
          cwd: val.cwd,
          env: val.env,
          label: val.label || name,
        });
      } else {
        result.push({
          name,
          command: String(val),
          label: name,
        });
      }
    }

    return result;
  }

  /**
   * Launch a new background terminal task.
   */
  static launchTask(params: {
    command?: string;
    presetName?: string;
    cwd?: string;
  }): { success: boolean; taskId: string; pid: number; command: string; logPath: string } {
    let commandStr = params.command || "";
    let runCwd = params.cwd || process.cwd();
    let runEnv: Record<string, string> = { ...process.env as Record<string, string> };
    let windowLabel = "";

    if (params.presetName) {
      const presets = this.getPresets(runCwd);
      const found = presets.find((p) => p.name.toLowerCase() === params.presetName?.toLowerCase());
      if (found) {
        commandStr = found.command;
        windowLabel = found.label || found.name;
        if (found.cwd) runCwd = path.resolve(runCwd, found.cwd);
        if (found.env) runEnv = { ...runEnv, ...found.env };
      } else if (!commandStr) {
        throw new Error(`Preset "${params.presetName}" not found`);
      }
    }

    if (!commandStr.trim()) {
      throw new Error("Command or valid preset name is required");
    }

    const taskId = `term-bg-${Math.random().toString(36).substring(2, 9)}`;
    const tasksLogDir = getWorkspaceTasksLogDir();
    if (!fs.existsSync(tasksLogDir)) fs.mkdirSync(tasksLogDir, { recursive: true });
    const logPath = path.join(tasksLogDir, `${taskId}.log`);
    fs.writeFileSync(logPath, `[Terminal Task: ${taskId}]\n[Command: ${commandStr}]\n[Started: ${new Date().toISOString()}]\n\n`);

    let shellPath: string | boolean = true;
    if (process.platform === "win32") {
      shellPath = "powershell.exe";
    }

    const opts = applyProcessIntent(
      {
        shell: shellPath,
        cwd: runCwd,
        env: runEnv,
        reject: false,
        all: true,
      },
      "headless"
    );

    const proc = execa(commandStr, opts);

    const taskObj = {
      id: taskId,
      command: commandStr,
      process: proc,
      output: [] as string[],
      logPath,
      cwd: runCwd,
      windowLabel: windowLabel || commandStr.split(" ")[0],
      isDetachedWindow: false,
      hasExited: false,
    };

    backgroundTasks.set(taskId, taskObj as any);
    if (proc.pid) ownedTerminalIdentities.set(taskId, readProcessStartIdentity(proc.pid));
    try { savePersistedTasks(); } catch {}
    notifyTasksChanged();

    proc.all?.on("data", (data: Buffer) => {
      const text = data.toString();
      taskObj.output.push(text);
      if (taskObj.output.length > 1000) taskObj.output.shift();
      try {
        fs.appendFileSync(logPath, text);
      } catch {}
    });

    proc.on("close", (code: number | null) => {
      (taskObj as any).hasExited = true;
      (taskObj as any).exitCode = code;
      ownedTerminalIdentities.delete(taskId);
      pausedTerminalTrees.delete(taskId);
      taskObj.output.push(`\n[Process exited with code ${code}]`);
      try {
        fs.appendFileSync(logPath, `\n[Process exited with code ${code}]\n`);
      } catch {}
      notifyTasksChanged();
      try {
        savePersistedTasks();
      } catch {}
    });

    return {
      success: true,
      taskId,
      pid: proc.pid || 0,
      command: commandStr,
      logPath,
    };
  }
}
