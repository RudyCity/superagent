/**
 * processInspectionTools.ts — Precise process and port management tools for Superagent.
 *
 * Provides targeted tools for inspecting ports, searching active processes,
 * and safely freeing ports without blanket-killing unrelated services.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { execa } from "execa";
import { Tool } from "./types.js";
import { killProcessTree } from "./shellTools.js";
import { backgroundTasks, notifyTasksChanged } from "./state.js";

export interface PortProcessInfo {
  pid: number;
  processName: string;
  commandLine: string;
  localAddress: string;
  isSuperagentTask: boolean;
  taskId?: string;
  cwd?: string;
}

export interface PortInspectionResult {
  port: number;
  status: "listening" | "free";
  processes: PortProcessInfo[];
}

export interface ProcessSearchResult {
  pid: number;
  name: string;
  commandLine: string;
  isSuperagentTask: boolean;
  taskId?: string;
  cwd?: string;
}

const PROTECTED_PROCESS_NAMES = new Set([
  "system",
  "system idle process",
  "csrss.exe",
  "lsass.exe",
  "services.exe",
  "smss.exe",
  "wininit.exe",
  "winlogon.exe",
  "explorer.exe",
  "dwm.exe",
  "svchost.exe",
  "init",
  "systemd",
  "launchd",
  "kernel_task",
  "kthreadd",
]);

export function isProtectedProcess(name: string, pid?: number): boolean {
  if (pid !== undefined && pid <= 4) return true;
  if (pid !== undefined && (pid === process.pid || pid === process.ppid)) return true;
  const clean = (name || "").toLowerCase().trim();
  return PROTECTED_PROCESS_NAMES.has(clean);
}

/**
 * Resolves process details (name, command line, cwd) for a given PID cross-platform.
 */
export async function getProcessDetails(pid: number): Promise<{
  name: string;
  commandLine: string;
  cwd?: string;
  isSuperagentTask: boolean;
  taskId?: string;
}> {
  // Check Superagent backgroundTasks map first
  for (const [id, task] of backgroundTasks.entries()) {
    if (task.process?.pid === pid) {
      return {
        name: path.basename(task.command.split(" ")[0] || "process"),
        commandLine: task.command,
        cwd: task.cwd,
        isSuperagentTask: true,
        taskId: id,
      };
    }
  }

  if (process.platform === "win32") {
    try {
      const psCmd = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`;
      const res = await execa("powershell", ["-NoProfile", "-Command", psCmd], {
        timeout: 3000,
        reject: false,
      });
      if (res.stdout && res.stdout.trim().startsWith("{")) {
        const parsed = JSON.parse(res.stdout.trim());
        return {
          name: parsed.Name || "unknown",
          commandLine: parsed.CommandLine || parsed.Name || "unknown",
          isSuperagentTask: false,
        };
      }
    } catch {}

    try {
      const res = await execa("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
        timeout: 2000,
        reject: false,
      });
      const lines = res.stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length > 0 && !lines[0].toLowerCase().includes("no tasks")) {
        const parts = lines[0].split('","').map((s) => s.replace(/^"|"$/g, ""));
        return {
          name: parts[0] || "unknown",
          commandLine: parts[0] || "unknown",
          isSuperagentTask: false,
        };
      }
    } catch {}
  } else {
    // Linux / macOS
    try {
      const cmdlinePath = `/proc/${pid}/cmdline`;
      if (fs.existsSync(cmdlinePath)) {
        const raw = fs.readFileSync(cmdlinePath, "utf-8");
        const cmd = raw.replace(/\0/g, " ").trim();
        const commPath = `/proc/${pid}/comm`;
        const comm = fs.existsSync(commPath) ? fs.readFileSync(commPath, "utf-8").trim() : "";
        let cwd: string | undefined;
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        } catch {}
        return {
          name: comm || cmd.split(" ")[0] || "unknown",
          commandLine: cmd || comm || "unknown",
          cwd,
          isSuperagentTask: false,
        };
      }
    } catch {}

    try {
      const res = await execa("ps", ["-p", String(pid), "-o", "comm=,args="], {
        timeout: 2000,
        reject: false,
      });
      const line = res.stdout.trim();
      if (line) {
        const parts = line.split(/\s+/);
        return {
          name: parts[0] || "unknown",
          commandLine: line,
          isSuperagentTask: false,
        };
      }
    } catch {}
  }

  return {
    name: "unknown",
    commandLine: "unknown",
    isSuperagentTask: false,
  };
}

/**
 * Inspects a specific TCP port to find listening processes cross-platform.
 */
export async function inspectPort(port: number): Promise<PortInspectionResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port number: ${port}. Port must be an integer between 1 and 65535.`);
  }

  const pidsWithAddr: Array<{ pid: number; localAddress: string }> = [];

  if (process.platform === "win32") {
    try {
      const res = await execa("netstat", ["-ano", "-p", "tcp"], {
        timeout: 5000,
        reject: false,
      });
      const lines = res.stdout.split(/\r?\n/);
      const portRegex = new RegExp(`^\\s*TCP\\s+(\\S+:${port})\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "i");

      for (const line of lines) {
        const match = portRegex.exec(line);
        if (match) {
          const addr = match[1];
          const pid = parseInt(match[2], 10);
          if (pid > 0 && !pidsWithAddr.some((p) => p.pid === pid)) {
            pidsWithAddr.push({ pid, localAddress: addr });
          }
        }
      }
    } catch {}

    // Fallback via PowerShell Get-NetTCPConnection if netstat found nothing
    if (pidsWithAddr.length === 0) {
      try {
        const psCmd = `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -Property LocalAddress,LocalPort,OwningProcess | ConvertTo-Json`;
        const res = await execa("powershell", ["-NoProfile", "-Command", psCmd], {
          timeout: 4000,
          reject: false,
        });
        if (res.stdout && res.stdout.trim()) {
          const raw = JSON.parse(res.stdout.trim());
          const items = Array.isArray(raw) ? raw : [raw];
          for (const item of items) {
            const pid = Number(item.OwningProcess);
            if (pid > 0 && !pidsWithAddr.some((p) => p.pid === pid)) {
              pidsWithAddr.push({
                pid,
                localAddress: `${item.LocalAddress || "0.0.0.0"}:${port}`,
              });
            }
          }
        }
      } catch {}
    }
  } else {
    // macOS / Linux via lsof or ss
    try {
      const res = await execa("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-n", "-P", "-Fp"], {
        timeout: 3000,
        reject: false,
      });
      const lines = res.stdout.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith("p")) {
          const pid = parseInt(line.slice(1), 10);
          if (pid > 0 && !pidsWithAddr.some((p) => p.pid === pid)) {
            pidsWithAddr.push({ pid, localAddress: `0.0.0.0:${port}` });
          }
        }
      }
    } catch {}

    if (pidsWithAddr.length === 0) {
      try {
        const res = await execa("ss", ["-lptn", `sport = :${port}`], {
          timeout: 3000,
          reject: false,
        });
        const match = /pid=(\d+)/.exec(res.stdout);
        if (match) {
          const pid = parseInt(match[1], 10);
          if (pid > 0 && !pidsWithAddr.some((p) => p.pid === pid)) {
            pidsWithAddr.push({ pid, localAddress: `0.0.0.0:${port}` });
          }
        }
      } catch {}
    }
  }

  if (pidsWithAddr.length === 0) {
    return {
      port,
      status: "free",
      processes: [],
    };
  }

  const processes: PortProcessInfo[] = [];
  for (const entry of pidsWithAddr) {
    const details = await getProcessDetails(entry.pid);
    processes.push({
      pid: entry.pid,
      processName: details.name,
      commandLine: details.commandLine,
      localAddress: entry.localAddress,
      isSuperagentTask: details.isSuperagentTask,
      taskId: details.taskId,
      cwd: details.cwd,
    });
  }

  return {
    port,
    status: "listening",
    processes,
  };
}

/**
 * Safely terminates the process occupying a specific TCP port and its child process tree.
 */
export async function freePort(
  port: number,
  force: boolean = true
): Promise<{ success: boolean; message: string; killedProcesses: PortProcessInfo[] }> {
  const inspection = await inspectPort(port);
  if (inspection.status === "free" || inspection.processes.length === 0) {
    return {
      success: true,
      message: `Port ${port} is already free (no active process listening).`,
      killedProcesses: [],
    };
  }

  const killed: PortProcessInfo[] = [];
  const errors: string[] = [];

  for (const proc of inspection.processes) {
    if (isProtectedProcess(proc.processName, proc.pid)) {
      errors.push(
        `Cannot kill protected process: ${proc.processName} (PID: ${proc.pid}). This process is vital to the system.`
      );
      continue;
    }

    try {
      // If it is registered in Superagent's background tasks, clean it up gracefully
      if (proc.isSuperagentTask && proc.taskId) {
        const task = backgroundTasks.get(proc.taskId);
        if (task) {
          task.hasExited = true;
          task.exitCode = -1;
          backgroundTasks.delete(proc.taskId);
          notifyTasksChanged();
        }
      }

      killProcessTree(proc.pid);
      killed.push(proc);
    } catch (err: any) {
      errors.push(`Failed to terminate PID ${proc.pid}: ${err?.message || err}`);
    }
  }

  // Poll for up to 3000ms to verify that port is actually freed
  let isReleased = false;
  const start = Date.now();
  while (Date.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 200));
    const check = await inspectPort(port);
    if (check.status === "free") {
      isReleased = true;
      break;
    }
  }

  // Fallback targeted taskkill on Windows if still listening
  if (!isReleased && force && process.platform === "win32") {
    for (const proc of killed) {
      try {
        execSync(`taskkill /F /PID ${proc.pid}`, { stdio: "ignore" });
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 300));
    const finalCheck = await inspectPort(port);
    isReleased = finalCheck.status === "free";
  }

  if (isReleased) {
    const listStr = killed
      .map(
        (p) =>
          `- ${p.processName} (PID: ${p.pid}${p.isSuperagentTask ? `, Superagent Task: ${p.taskId}` : ""}): "${p.commandLine}"`
      )
      .join("\n");
    return {
      success: true,
      message: `Port ${port} was successfully freed.\nTerminated processes:\n${listStr}`,
      killedProcesses: killed,
    };
  }

  const errorDetail = errors.length > 0 ? `\nErrors:\n${errors.join("\n")}` : "";
  return {
    success: false,
    message: `Attempted to free port ${port}, but port remains occupied.${errorDetail}`,
    killedProcesses: killed,
  };
}

/**
 * Searches running system processes and Superagent tasks by port, process name, or command line.
 */
export async function searchProcesses(
  query: string,
  limit: number = 10
): Promise<{ query: string; results: ProcessSearchResult[] }> {
  const clean = (query || "").trim();
  if (!clean) {
    return { query, results: [] };
  }

  const results: ProcessSearchResult[] = [];
  const seenPids = new Set<number>();

  // If query is an integer port, check that port first
  const parsedPort = parseInt(clean, 10);
  if (!isNaN(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
    try {
      const portRes = await inspectPort(parsedPort);
      for (const p of portRes.processes) {
        if (!seenPids.has(p.pid)) {
          seenPids.add(p.pid);
          results.push({
            pid: p.pid,
            name: p.processName,
            commandLine: p.commandLine,
            isSuperagentTask: p.isSuperagentTask,
            taskId: p.taskId,
            cwd: p.cwd,
          });
        }
      }
    } catch {}
  }

  // Check Superagent background tasks
  const lowerQuery = clean.toLowerCase();
  for (const [id, task] of backgroundTasks.entries()) {
    const cmdLower = (task.command || "").toLowerCase();
    const pid = task.process?.pid;
    if (cmdLower.includes(lowerQuery) || id.toLowerCase().includes(lowerQuery)) {
      if (pid && !seenPids.has(pid)) {
        seenPids.add(pid);
        results.push({
          pid,
          name: path.basename(task.command.split(" ")[0] || "process"),
          commandLine: task.command,
          isSuperagentTask: true,
          taskId: id,
          cwd: task.cwd,
        });
      }
    }
  }

  // Search OS processes
  if (results.length < limit) {
    if (process.platform === "win32") {
      try {
        const escapedQuery = clean.replace(/'/g, "''").replace(/`/g, "``");
        const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*${escapedQuery}*' -or $_.CommandLine -like '*${escapedQuery}*' } | Select-Object -First ${limit} ProcessId,Name,CommandLine | ConvertTo-Json`;
        const res = await execa("powershell", ["-NoProfile", "-Command", psCmd], {
          timeout: 4000,
          reject: false,
        });
        if (res.stdout && res.stdout.trim()) {
          const raw = JSON.parse(res.stdout.trim());
          const items = Array.isArray(raw) ? raw : [raw];
          for (const item of items) {
            const pid = Number(item.ProcessId);
            if (pid > 0 && !seenPids.has(pid)) {
              seenPids.add(pid);
              results.push({
                pid,
                name: item.Name || "unknown",
                commandLine: item.CommandLine || item.Name || "unknown",
                isSuperagentTask: false,
              });
              if (results.length >= limit) break;
            }
          }
        }
      } catch {}
    } else {
      try {
        const res = await execa("ps", ["aux"], { timeout: 3000, reject: false });
        const lines = res.stdout.split(/\r?\n/);
        for (const line of lines) {
          if (line.toLowerCase().includes(lowerQuery) && !line.includes("ps aux")) {
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[1], 10);
            if (pid > 0 && !seenPids.has(pid)) {
              seenPids.add(pid);
              const cmd = parts.slice(10).join(" ");
              results.push({
                pid,
                name: parts[10] || "unknown",
                commandLine: cmd,
                isSuperagentTask: false,
              });
              if (results.length >= limit) break;
            }
          }
        }
      } catch {}
    }
  }

  return { query: clean, results: results.slice(0, limit) };
}

/**
 * Safely terminates a specific process PID and its tree.
 */
export async function killSpecificProcess(
  pid: number,
  force: boolean = true
): Promise<{ success: boolean; message: string }> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { success: false, message: `Invalid Process ID: ${pid}. PID must be a positive integer.` };
  }

  const details = await getProcessDetails(pid);
  if (isProtectedProcess(details.name, pid)) {
    return {
      success: false,
      message: `Cannot terminate protected process: ${details.name} (PID: ${pid}).`,
    };
  }

  try {
    if (details.isSuperagentTask && details.taskId) {
      const task = backgroundTasks.get(details.taskId);
      if (task) {
        task.hasExited = true;
        task.exitCode = -1;
        backgroundTasks.delete(details.taskId);
        notifyTasksChanged();
      }
    }

    killProcessTree(pid);

    if (force && process.platform === "win32") {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
      } catch {}
    }

    return {
      success: true,
      message: `Successfully terminated process ${details.name} (PID: ${pid}, Command: "${details.commandLine}").`,
    };
  } catch (err: any) {
    return {
      success: false,
      message: `Failed to terminate process PID ${pid}: ${err?.message || err}`,
    };
  }
}

// ─── TOOL DEFINITIONS ────────────────────────────────────────────────────────

export const inspectPortTool: Tool = {
  name: "inspect_port",
  description:
    "Inspect a TCP port to discover which process is listening on it, including PID, process name, full command line, and whether it is a Superagent background task.",
  parameters: {
    type: "object",
    properties: {
      port: {
        type: "integer",
        description: "The TCP port number to inspect (1-65535), e.g. 7001, 7101, 3000.",
      },
    },
    required: ["port"],
  },
  async execute(args) {
    const rawPort = args.port ?? args.portNumber;
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return `Error: Invalid port number "${rawPort}". Please provide an integer port between 1 and 65535.`;
    }

    const res = await inspectPort(port);
    if (res.status === "free" || res.processes.length === 0) {
      return `Port ${port} is FREE (no active process is listening on this port).`;
    }

    const lines: string[] = [
      `Port ${port} is currently OCCUPIED (LISTENING):`,
      ...res.processes.map((p) => {
        const taskTag = p.isSuperagentTask ? ` [Superagent Task: ${p.taskId}]` : "";
        const cwdTag = p.cwd ? `\n  Working Directory: ${p.cwd}` : "";
        return `- PID: ${p.pid}${taskTag}\n  Process: ${p.processName}\n  Command Line: ${p.commandLine}\n  Local Address: ${p.localAddress}${cwdTag}`;
      }),
      `\nRecommendation: To cleanly free this port without affecting unrelated processes, use free_port({ port: ${port} }).`,
    ];

    return lines.join("\n");
  },
};

export const freePortTool: Tool = {
  name: "free_port",
  description:
    "Safely terminate the specific process occupying a TCP port and its process tree, preventing port conflicts (EADDRINUSE) without mass-killing other development servers.",
  parameters: {
    type: "object",
    properties: {
      port: {
        type: "integer",
        description: "The TCP port number to release, e.g. 7001, 7101, 3000.",
      },
      force: {
        type: "boolean",
        description: "Whether to force-kill if graceful termination does not release the port within 2s (default: true).",
      },
    },
    required: ["port"],
  },
  async execute(args) {
    const rawPort = args.port ?? args.portNumber;
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return `Error: Invalid port number "${rawPort}". Please provide an integer port between 1 and 65535.`;
    }
    const force = args.force !== false;
    const result = await freePort(port, force);
    return result.message;
  },
};

export const findProcessTool: Tool = {
  name: "find_process",
  description:
    "Search active system processes or Superagent tasks by port number, process name (e.g. 'bun', 'vite'), or command line substring.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Port number (e.g. '7001'), process name (e.g. 'bun'), or command line substring to search for.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of process matches to return (default: 10).",
      },
    },
    required: ["query"],
  },
  async execute(args) {
    const query = String(args.query || args.q || "").trim();
    if (!query) {
      return "Error: Missing required parameter 'query'. Provide a port, process name, or command substring.";
    }
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
    const { results } = await searchProcesses(query, limit);

    if (results.length === 0) {
      return `No active processes found matching query: "${query}".`;
    }

    const lines: string[] = [
      `Found ${results.length} active process(es) matching "${query}":`,
      ...results.map((p) => {
        const taskTag = p.isSuperagentTask ? ` [Superagent Task: ${p.taskId}]` : "";
        const cwdTag = p.cwd ? ` (cwd: ${p.cwd})` : "";
        return `- PID ${p.pid}: ${p.name}${taskTag}${cwdTag}\n  Command: ${p.commandLine}`;
      }),
    ];

    return lines.join("\n");
  },
};

export const killProcessTool: Tool = {
  name: "kill_process",
  description:
    "Safely terminate a specific process by its PID and its child process tree, verifying against critical operating system processes.",
  parameters: {
    type: "object",
    properties: {
      pid: {
        type: "integer",
        description: "The Process ID (PID) to terminate.",
      },
      force: {
        type: "boolean",
        description: "Whether to force-kill if graceful termination fails (default: true).",
      },
    },
    required: ["pid"],
  },
  async execute(args) {
    const rawPid = args.pid ?? args.processId;
    const pid = Number(rawPid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return `Error: Invalid process ID "${rawPid}". Please provide a valid positive integer PID.`;
    }
    const force = args.force !== false;
    const result = await killSpecificProcess(pid, force);
    return result.message;
  },
};
