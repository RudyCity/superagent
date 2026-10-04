/**
 * backgroundLogService.ts — Log inspection, slicing, tailing, grepping, and listing service for Superagent background processes.
 */

import fs from "fs";
import path from "path";
import { backgroundTasks } from "./state.js";
import { getWorkspaceTasksLogDir, getWorkspaceId } from "../config.js";
import { getWorkspaceTasksFromDb } from "../storage/historyDb.js";

/**
 * Strip ANSI color and escape codes from log lines for clean search matching and display.
 */
export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTimeAgo(timestampMs: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - timestampMs) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

export interface ResolvedTaskLog {
  task?: any;
  logPath?: string;
  lines: string[];
  totalLines: number;
  fileSizeBytes: number;
  source: "file" | "memory" | "empty";
  statusText: string;
}

/**
 * Resolve target background task and its output log lines from processId or direct logPath.
 */
export function resolveTaskLogInfo(
  args: { processId?: string; logPath?: string },
  cwd: string
): { success: true; data: ResolvedTaskLog } | { success: false; error: string } {
  let task: any = undefined;
  let resolvedLogPath: string | undefined = undefined;

  // 1. Direct logPath provided
  if (args.logPath && typeof args.logPath === "string") {
    const candidatePath = path.isAbsolute(args.logPath) ? args.logPath : path.resolve(cwd, args.logPath);
    if (fs.existsSync(candidatePath)) {
      resolvedLogPath = candidatePath;
      for (const t of backgroundTasks.values()) {
        if (t.logPath === candidatePath) {
          task = t;
          break;
        }
      }
      if (!task) {
        try {
          const dbTasks = getWorkspaceTasksFromDb(getWorkspaceId());
          const foundDb = dbTasks.find((t) => t.logPath === candidatePath);
          if (foundDb) task = foundDb;
        } catch {}
      }
    } else {
      return { success: false, error: `Error: Log file not found at path: ${candidatePath}` };
    }
  }

  // 2. processId provided
  const processId = args.processId;
  if (!resolvedLogPath && processId) {
    if (backgroundTasks.has(processId)) {
      task = backgroundTasks.get(processId);
      resolvedLogPath = task?.logPath;
    }
    if (!task) {
      try {
        const dbTasks = getWorkspaceTasksFromDb(getWorkspaceId());
        const found = dbTasks.find((t) => t.id === processId);
        if (found) {
          task = found;
          resolvedLogPath = found.logPath;
        }
      } catch {}
    }
    if (!resolvedLogPath) {
      try {
        const logDir = getWorkspaceTasksLogDir();
        const candidateFile = path.join(logDir, `${processId}.log`);
        const candidateFileBg = path.join(logDir, `bg_${processId}.log`);
        if (fs.existsSync(candidateFile)) {
          resolvedLogPath = candidateFile;
        } else if (fs.existsSync(candidateFileBg)) {
          resolvedLogPath = candidateFileBg;
        }
      } catch {}
    }
  }

  // 3. Fallback when neither processId nor logPath specified
  if (!resolvedLogPath && !task) {
    if (backgroundTasks.size === 1) {
      task = [...backgroundTasks.values()][0];
      resolvedLogPath = task?.logPath;
    } else if (backgroundTasks.size > 1) {
      const activeList = [...backgroundTasks.entries()]
        .map(([id, t]) => `  - ID: ${id} | Command: ${t.command}`)
        .join("\n");
      return {
        success: false,
        error: `Error: Multiple active background processes found. Please specify processId. Available:\n${activeList}`,
      };
    } else {
      return {
        success: false,
        error: `Error: processId or logPath is required. Use action: 'list_logs' to see available log files, or 'run_background_process' to start a task.`,
      };
    }
  }

  // Determine status text
  let statusText = "Unknown";
  if (task) {
    if (task.hasExited) {
      statusText = `Exited (code ${task.exitCode ?? 0})`;
    } else if (task.process?.killed) {
      statusText = "Killed";
    } else {
      statusText = "Running";
    }
  }

  // Read content lines
  let lines: string[] = [];
  let fileSizeBytes = 0;
  let source: "file" | "memory" | "empty" = "empty";

  if (resolvedLogPath && fs.existsSync(resolvedLogPath)) {
    try {
      const stat = fs.statSync(resolvedLogPath);
      fileSizeBytes = stat.size;
      const content = fs.readFileSync(resolvedLogPath, "utf-8");
      lines = content.split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      source = "file";
    } catch {
      // Fallback to memory
    }
  }

  if (lines.length === 0 && task && task.output && task.output.length > 0) {
    const raw = task.output.join("");
    lines = raw.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }
    fileSizeBytes = Buffer.byteLength(raw, "utf-8");
    source = "memory";
  }

  return {
    success: true,
    data: {
      task,
      logPath: resolvedLogPath || task?.logPath,
      lines,
      totalLines: lines.length,
      fileSizeBytes,
      source,
      statusText,
    },
  };
}

export function performLogGrep(
  resolved: ResolvedTaskLog,
  options: {
    query: string;
    isRegex?: boolean;
    caseSensitive?: boolean;
    contextLines?: number;
    limit?: number;
    offset?: number;
  }
): string {
  const { lines, totalLines, logPath, task, statusText } = resolved;
  const query = options.query;
  if (!query) {
    return "Error: query or pattern parameter is required for grep/search action.";
  }

  let isMatch: (line: string) => boolean;
  try {
    if (options.isRegex) {
      const flags = options.caseSensitive ? "g" : "gi";
      const regex = new RegExp(query, flags);
      isMatch = (line: string) => {
        regex.lastIndex = 0;
        return regex.test(stripAnsi(line));
      };
    } else {
      if (options.caseSensitive) {
        isMatch = (line: string) => stripAnsi(line).includes(query);
      } else {
        const qLower = query.toLowerCase();
        isMatch = (line: string) => stripAnsi(line).toLowerCase().includes(qLower);
      }
    }
  } catch (err: any) {
    return `Error invalid regular expression query "${query}": ${err?.message || err}`;
  }

  const contextLines = Math.max(0, options.contextLines ?? 2);
  const maxMatches = Math.max(1, options.limit ?? 50);
  const startFromIndex = Math.max(0, (options.offset ?? 1) - 1);

  const matchedIndices: number[] = [];
  for (let i = startFromIndex; i < lines.length; i++) {
    if (isMatch(lines[i])) {
      matchedIndices.push(i);
      if (matchedIndices.length >= maxMatches) {
        break;
      }
    }
  }

  const pidStr = task?.process?.pid ? `PID: ${task.process.pid} | ` : "";
  const cmdStr = task?.command ? ` | Command: ${task.command}` : "";
  const idStr = task?.id ? `process "${task.id}"` : (logPath ? `file "${path.basename(logPath)}"` : "log");

  if (matchedIndices.length === 0) {
    return `Search query: "${query}" in ${idStr} (${pidStr}Status: ${statusText}${cmdStr})\nLog File: ${logPath || "in-memory"}\nTotal lines searched: ${totalLines}\n\nNo matching lines found.`;
  }

  // Merge overlapping context blocks
  const blocks: Array<{ start: number; end: number }> = [];
  for (const idx of matchedIndices) {
    const blockStart = Math.max(0, idx - contextLines);
    const blockEnd = Math.min(lines.length - 1, idx + contextLines);
    if (blocks.length === 0) {
      blocks.push({ start: blockStart, end: blockEnd });
    } else {
      const prev = blocks[blocks.length - 1];
      if (blockStart <= prev.end + 1) {
        prev.end = Math.max(prev.end, blockEnd);
      } else {
        blocks.push({ start: blockStart, end: blockEnd });
      }
    }
  }

  const matchSet = new Set(matchedIndices);
  const maxLineNum = blocks[blocks.length - 1].end + 1;
  const padWidth = Math.max(String(maxLineNum).length, 3);

  const outputSections: string[] = [];
  for (const block of blocks) {
    const blockLines: string[] = [];
    for (let i = block.start; i <= block.end; i++) {
      const lineNumStr = String(i + 1).padStart(padWidth, " ");
      const isHit = matchSet.has(i);
      const marker = isHit ? ">" : " ";
      blockLines.push(`${marker} ${lineNumStr} | ${stripAnsi(lines[i])}`);
    }
    outputSections.push(blockLines.join("\n"));
  }

  const cappedNote = matchedIndices.length >= maxMatches ? ` (capped at ${maxMatches} matches)` : "";
  return `Search query: "${query}" in ${idStr} (${matchedIndices.length} matches found${cappedNote}, total lines: ${totalLines})\n${pidStr}Status: ${statusText}${cmdStr}\nLog File: ${logPath || "in-memory"}\n\n[Matches]:\n${outputSections.join("\n  ---\n")}`;
}

export function performLogSlice(
  resolved: ResolvedTaskLog,
  options: {
    offset?: number;
    limit?: number;
  }
): string {
  const { lines, totalLines, logPath, task, statusText, fileSizeBytes } = resolved;
  const pidStr = task?.process?.pid ? `PID: ${task.process.pid} | ` : "";
  const cmdStr = task?.command ? ` | Command: ${task.command}` : "";
  const idStr = task?.id ? `process "${task.id}"` : (logPath ? `file "${path.basename(logPath)}"` : "log");

  if (totalLines === 0) {
    return `${idStr} (${pidStr}Status: ${statusText}${cmdStr})\nLog File: ${logPath || "in-memory"}\nTotal lines: 0 (empty log).`;
  }

  let startLine: number;
  if (options.offset !== undefined && options.offset < 0) {
    startLine = Math.max(1, totalLines + options.offset + 1);
  } else {
    startLine = Math.max(1, options.offset ?? 1);
  }

  const limit = Math.min(1000, Math.max(1, options.limit ?? 100));
  const endLine = Math.min(totalLines, startLine + limit - 1);

  if (startLine > totalLines) {
    return `Notice: Requested offset (${startLine}) is beyond total lines (${totalLines}).\nLog File: ${logPath || "in-memory"}\nUse action: 'tail' to view recent lines.`;
  }

  const padWidth = Math.max(String(endLine).length, 3);
  const formattedLines: string[] = [];
  for (let i = startLine - 1; i < endLine; i++) {
    const lineNumStr = String(i + 1).padStart(padWidth, " ");
    formattedLines.push(`  ${lineNumStr} | ${stripAnsi(lines[i])}`);
  }

  const sizeStr = fileSizeBytes > 0 ? ` (${formatBytes(fileSizeBytes)})` : "";
  const remaining = totalLines - endLine;
  const navHint =
    remaining > 0
      ? `\n\n[Showing ${endLine - startLine + 1} lines. Remaining: ${remaining} lines. Next chunk: offset=${endLine + 1}, limit=${limit}]`
      : `\n\n[End of log (${totalLines} lines total)]`;

  return `Lines ${startLine}-${endLine} of ${totalLines}${sizeStr} from ${idStr}\n${pidStr}Status: ${statusText}${cmdStr}\nLog File: ${logPath || "in-memory"}\n\n${formattedLines.join("\n")}${navHint}`;
}

export function performLogTail(
  resolved: ResolvedTaskLog,
  options: {
    lines?: number;
    limit?: number;
  }
): string {
  const { totalLines } = resolved;
  const count = Math.min(totalLines, Math.max(1, options.lines ?? options.limit ?? 50));
  const startLine = Math.max(1, totalLines - count + 1);
  return performLogSlice(resolved, { offset: startLine, limit: count });
}

export function performLogHead(
  resolved: ResolvedTaskLog,
  options: {
    lines?: number;
    limit?: number;
  }
): string {
  const { totalLines } = resolved;
  const count = Math.min(totalLines, Math.max(1, options.lines ?? options.limit ?? 50));
  return performLogSlice(resolved, { offset: 1, limit: count });
}

export function performListLogs(limit?: number): string {
  const logDir = getWorkspaceTasksLogDir();
  if (!fs.existsSync(logDir)) {
    return "No background task logs directory found.";
  }

  const entries = fs.readdirSync(logDir).filter((f) => f.endsWith(".log"));
  if (entries.length === 0) {
    return `No background process log files found in ${logDir}.`;
  }

  const dbTasks = getWorkspaceTasksFromDb(getWorkspaceId());
  const maxItems = Math.max(1, limit ?? 20);

  const fileInfos = entries
    .map((file) => {
      const fullPath = path.join(logDir, file);
      try {
        const stat = fs.statSync(fullPath);
        const taskId = file.replace(/\.log$/, "");
        const activeTask = backgroundTasks.get(taskId);
        const dbTask = dbTasks.find((t) => t.id === taskId || t.logPath === fullPath);
        const command = activeTask?.command || dbTask?.command || "Unknown command";
        const pid = activeTask?.process?.pid || dbTask?.pid;
        let status = "Completed";
        if (activeTask) {
          status = activeTask.hasExited ? `Exited (${activeTask.exitCode ?? 0})` : "Running";
        } else if (dbTask) {
          status = dbTask.hasExited ? `Exited (${dbTask.exitCode ?? 0})` : "Exited";
        }

        let lineCount = 0;
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const split = content.split(/\r?\n/);
          lineCount = split[split.length - 1] === "" ? split.length - 1 : split.length;
        } catch {}

        return {
          file,
          fullPath,
          taskId,
          command,
          pid,
          status,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          lineCount,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{
      file: string;
      fullPath: string;
      taskId: string;
      command: string;
      pid?: number;
      status: string;
      size: number;
      mtimeMs: number;
      lineCount: number;
    }>;

  fileInfos.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const displayed = fileInfos.slice(0, maxItems);

  const items = displayed.map((info) => {
    const pidStr = info.pid ? ` | PID: ${info.pid}` : "";
    return `- [${info.status}] ID: ${info.taskId}${pidStr} | Command: "${info.command}"\n  Log File: ${info.fullPath} (${info.lineCount.toLocaleString()} lines, ${formatBytes(info.size)}, updated ${formatTimeAgo(info.mtimeMs)})`;
  });

  const moreNotice = fileInfos.length > maxItems ? `\n... and ${fileInfos.length - maxItems} older log files.` : "";
  return `Background Task Log Files (${fileInfos.length} total in ${logDir}):\n${items.join("\n")}${moreNotice}\n\nTip: Use manage_background_process(action: 'grep', processId: '<id>', query: '<term>') to search, or (action: 'tail', processId: '<id>') to view recent output.`;
}
