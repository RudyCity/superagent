/**
 * commandLogger.ts — Automatic real-time logging for shell command executions in Superagent.
 *
 * Provides persistent command execution logs under ~/.superagent-r/logs/commands/
 * and maintains a rolling ~/.superagent-r/logs/latest-command.log pointer.
 * Enables live progress inspection, crash/timeout log preservation, MCP tracking,
 * and clean output truncation referencing the full log file on disk.
 */

import fs from "fs";
import path from "path";
import { getRootConfigDir } from "../config/paths.js";

export interface CommandLogger {
  id: string;
  logPath: string;
  latestLogPath: string;
  command: string;
  cwd: string;
  startTime: number;
  write: (chunk: string) => void;
  end: (exitCode?: number | null, error?: string) => void;
}

let activeCommandLogPath: string | undefined = undefined;

export function getCurrentCommandLogPath(): string | undefined {
  return activeCommandLogPath;
}

export function getCommandLogsDir(): string {
  const dir = path.join(getRootConfigDir(), "logs", "commands");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getLatestCommandLogPath(): string {
  const logsDir = path.join(getRootConfigDir(), "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return path.join(logsDir, "latest-command.log");
}

/**
 * Prunes old command log files if they exceed maxFiles to prevent unbounded disk usage.
 */
function pruneOldLogs(commandsDir: string, maxFiles: number = 50): void {
  try {
    const files = fs.readdirSync(commandsDir);
    if (files.length <= maxFiles) return;

    const fileStats = files
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const fullPath = path.join(commandsDir, f);
        try {
          return { fullPath, mtime: fs.statSync(fullPath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { fullPath: string; mtime: number } => item !== null)
      .sort((a, b) => a.mtime - b.mtime);

    const removeCount = fileStats.length - maxFiles;
    for (let i = 0; i < removeCount; i++) {
      try {
        fs.unlinkSync(fileStats[i].fullPath);
      } catch {}
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Creates an automatic log file and streaming logger for a foreground shell command.
 */
export function createCommandLog(command: string, cwd: string): CommandLogger {
  const commandsDir = getCommandLogsDir();
  pruneOldLogs(commandsDir, 50);

  const timestamp = Date.now();
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  const id = `cmd_${timestamp}_${randomSuffix}`;
  const logPath = path.join(commandsDir, `${id}.log`);
  const latestLogPath = getLatestCommandLogPath();

  const isoTime = new Date(timestamp).toISOString();
  const header = [
    "================================================================================",
    "Superagent Command Execution Log",
    `ID:        ${id}`,
    `Command:   ${command}`,
    `CWD:       ${cwd}`,
    `Started:   ${isoTime}`,
    "================================================================================",
    "",
  ].join("\n");

  try {
    fs.writeFileSync(logPath, header, "utf-8");
  } catch {
    // Ignore write failure if filesystem is constrained
  }

  try {
    fs.writeFileSync(latestLogPath, header, "utf-8");
  } catch {}

  activeCommandLogPath = logPath;

  let isEnded = false;

  const write = (chunk: string) => {
    if (!chunk) return;
    try {
      fs.appendFileSync(logPath, chunk, "utf-8");
    } catch {}
    try {
      fs.appendFileSync(latestLogPath, chunk, "utf-8");
    } catch {}
  };

  const end = (exitCode?: number | null, error?: string) => {
    if (isEnded) return;
    isEnded = true;

    const endTime = new Date().toISOString();
    const footerLines = [
      "",
      "--------------------------------------------------------------------------------",
      `Completed: ${endTime} | Exit Code: ${exitCode !== undefined && exitCode !== null ? exitCode : "N/A"}`,
    ];
    if (error) {
      footerLines.push(`Error:     ${error}`);
    }
    footerLines.push("================================================================================", "");
    const footer = footerLines.join("\n");

    try {
      fs.appendFileSync(logPath, footer, "utf-8");
    } catch {}
    try {
      fs.appendFileSync(latestLogPath, footer, "utf-8");
    } catch {}

    if (activeCommandLogPath === logPath) {
      activeCommandLogPath = undefined;
    }
  };

  return {
    id,
    logPath,
    latestLogPath,
    command,
    cwd,
    startTime: timestamp,
    write,
    end,
  };
}

/**
 * Truncates output to a maximum number of lines while appending a reference
 * to the persistent log file on disk so the user and AI know where to view full logs.
 */
export function formatOutputWithLogReference(output: string, maxLines: number, logPath: string): string {
  const trimmed = output.trim();
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) {
    const lastLines = lines.slice(lines.length - maxLines).join("\n");
    return `${lastLines}\n\n... (output truncated to last ${maxLines} lines, full log saved at: ${logPath})`;
  }
  return trimmed;
}
