/**
 * processJournal.ts — Real-time persistent process and session registry for Superagent CLI & Server.
 *
 * Allows MCP servers, background daemons, and external tools to discover all live running
 * Superagent interactive CLI sessions, servers, and multi-agent workers across the machine.
 */

import fs from "fs";
import path from "path";
import { getRootConfigDir } from "../config/paths.js";
import { superagentInstances, subagentInstances, backgroundTasks, masterAgentRef } from "../tools/state.js";

export interface ActiveProcessEntry {
  pid: number;
  mode: "single" | "multi" | "server" | "mcp" | "cli";
  workingDirectory: string;
  startedAt: number;
  lastHeartbeat: number;
  isAgentRunning?: boolean;
  activeSuperagents?: Array<{ id: string; role: string; branch: string; status: string; task?: string }>;
  activeSubagents?: Array<{ id: string; typeName: string; role: string; status: string }>;
  backgroundTaskCount?: number;
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
        // Drop processes that died or haven't sent a heartbeat in > 30 seconds
        if (isPidAlive(item.pid) && now - (item.lastHeartbeat || 0) < 30000) {
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

export function registerCurrentProcess(mode: "single" | "multi" | "server" | "mcp" | "cli"): void {
  const pid = process.pid;
  const cwd = process.cwd();
  const startedAt = Date.now();

  const update = () => {
    const activeSuperagents = [...superagentInstances.values()].map((i) => ({
      id: i.id,
      role: i.role,
      branch: i.branch,
      status: i.status,
      task: i.task,
    }));

    const activeSubagents = [...subagentInstances.values()].map((s) => ({
      id: s.id,
      typeName: s.typeName,
      role: s.role,
      status: s.status,
    }));

    const isRunning = masterAgentRef ? (masterAgentRef.isAgentRunning?.() ?? false) : false;

    const entry: ActiveProcessEntry = {
      pid,
      mode,
      workingDirectory: cwd,
      startedAt,
      lastHeartbeat: Date.now(),
      isAgentRunning: isRunning,
      activeSuperagents,
      activeSubagents,
      backgroundTaskCount: backgroundTasks.size,
    };

    const currentList = loadActiveProcesses().filter((p) => p.pid !== pid);
    currentList.push(entry);
    saveActiveProcesses(currentList);
  };

  update();

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(update, 3000);
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
