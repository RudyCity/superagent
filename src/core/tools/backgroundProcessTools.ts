/**
 * backgroundProcessTools.ts — Background process management tools for Superagent.
 *
 * Tools for killing, viewing, inspecting, grepping, slicing, and managing background tasks launched via run_background_process.
 */

import { Tool } from "./types.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import {
  sshKillBackgroundProcessExecute,
  sshViewBackgroundProcessesExecute,
  sshManageBackgroundProcessExecute,
} from "../ssh/sshCommands.js";
import {
  backgroundTasks,
  notifyTasksChanged,
  clearActiveToolOutput,
  appendActiveToolOutput,
} from "./state.js";
import { killProcessTree, formatAndTruncateOutput } from "./shellTools.js";
import { formatUnknownActionError } from "./helpers.js";
import {
  resolveTaskLogInfo,
  performLogGrep,
  performLogSlice,
  performLogTail,
  performLogHead,
  performListLogs,
  stripAnsi,
} from "./backgroundLogService.js";

export {
  resolveTaskLogInfo,
  performLogGrep,
  performLogSlice,
  performLogTail,
  performLogHead,
  performListLogs,
  stripAnsi,
};

export const killBackgroundProcessTool: Tool = {
  name: "kill_background_process",
  description: "Terminate a background process by ID.",
  parameters: {
    type: "object",
    properties: {
      processId: {
        type: "string",
        description: "The Process ID returned by run_background_process",
      },
    },
    required: ["processId"],
  },
  async execute(args, cwd, signal) {
    const processId = args.processId as string;
    if (workspaceMode.isSsh()) {
      return await sshKillBackgroundProcessExecute(processId);
    }
    const task = backgroundTasks.get(processId);
    if (!task) {
      return `Error: No background process found with ID "${processId}"`;
    }

    try {
      killProcessTree(task.process.pid);
      backgroundTasks.delete(processId);
      notifyTasksChanged();
      return `Background process "${processId}" has been killed successfully.`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error killing background process: ${message}`;
    }
  },
};

export const viewBackgroundProcessesTool: Tool = {
  name: "view_background_processes",
  description: "List running background processes and show their recent output logs.",
  parameters: {
    type: "object",
    properties: {
      processId: {
        type: "string",
        description: "Optional Process ID to view detailed output for. If omitted, lists all processes.",
      },
    },
  },
  async execute(args, cwd, signal) {
    const processId = args.processId as string;
    if (workspaceMode.isSsh()) {
      return await sshViewBackgroundProcessesExecute(processId);
    }
    if (processId) {
      const task = backgroundTasks.get(processId);
      if (!task) return `No background process found with ID "${processId}"`;
      const fullOutput = task.output.join("");
      const formattedOutput = formatAndTruncateOutput(fullOutput, 50, task.logPath || "");
      return `Process: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${formattedOutput}`;
    }

    if (backgroundTasks.size === 0) return "No active background processes.";
    const lines: string[] = [];
    for (const [id, task] of backgroundTasks.entries()) {
      const pidStr = task.process?.pid ? ` | PID: ${task.process.pid}` : "";
      const statusStr = task.hasExited ? ` | Status: Exited (${task.exitCode ?? 0})` : (task.process?.killed ? " | Status: Killed" : " | Status: Running");
      const logStr = task.logPath ? ` | Log: ${task.logPath}` : "";
      lines.push(`Process ID: ${id}${pidStr}${statusStr} | Command: ${task.command}${logStr}`);
    }
    return lines.join("\n");
  },
};

export const manageBackgroundProcessTool: Tool = {
  name: "manage_background_process",
  description: "Manage background processes: list them, inspect/grep/tail logs, send input, wait for completion, or kill them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "logs", "log", "send_input", "kill", "wait", "stream", "grep", "search", "tail", "head", "read", "slice", "list_logs"],
        description: "Action to perform: 'status'/'logs' for recent output; 'grep'/'search' to find matching lines; 'tail' for last N lines; 'head' for first N lines; 'read'/'slice' for a line range; 'list_logs' to list log files on disk; 'wait' to block until process exits; 'kill' to terminate.",
      },
      processId: {
        type: "string",
        description: "The background process ID (e.g. returned by run_background_process)",
      },
      logPath: {
        type: "string",
        description: "Direct path to a .log file on disk (optional alternative to processId)",
      },
      query: {
        type: "string",
        description: "Search string or regex pattern (for 'grep' or 'search')",
      },
      contextLines: {
        type: "number",
        description: "Number of context lines before/after matches in grep (default 2)",
      },
      offset: {
        type: "number",
        description: "Starting line number, 1-indexed (for 'read'/'slice')",
      },
      limit: {
        type: "number",
        description: "Max lines or matches to return (default 100 for slice/read, 50 for grep/tail)",
      },
      lines: {
        type: "number",
        description: "Number of lines for tail/head (default 50)",
      },
      caseSensitive: {
        type: "boolean",
        description: "Case-sensitive search for grep (default false)",
      },
      isRegex: {
        type: "boolean",
        description: "Treat query as regular expression (default false)",
      },
      input: {
        type: "string",
        description: "The input string to send (required for send_input)",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds to wait for the process (default 600000 / 10 minutes)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const processId = args.processId as string;
    const input = args.input as string;

    if (workspaceMode.isSsh()) {
      return await sshManageBackgroundProcessExecute(action, processId, input, {
        query: (args.query || args.pattern) as string | undefined,
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
        lines: (args.lines || args.limit) as number | undefined,
        contextLines: args.contextLines as number | undefined,
      });
    }

    if (action === "list") {
      if (backgroundTasks.size === 0) return "No active background processes.";
      const lines: string[] = [];
      for (const [id, task] of backgroundTasks.entries()) {
        const pidStr = task.process?.pid ? ` | PID: ${task.process.pid}` : "";
        const statusStr = task.hasExited ? ` | Status: Exited (${task.exitCode ?? 0})` : (task.process?.killed ? " | Status: Killed" : " | Status: Running");
        const logStr = task.logPath ? ` | Log: ${task.logPath}` : "";
        lines.push(`Process ID: ${id}${pidStr}${statusStr} | Command: ${task.command}${logStr}`);
      }
      return lines.join("\n");
    }

    if (action === "list_logs") {
      return performListLogs(args.limit as number | undefined);
    }

    if (action === "grep" || action === "search") {
      const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
      if (!resolved.success) return resolved.error;
      return performLogGrep(resolved.data, {
        query: (args.query || args.pattern) as string,
        isRegex: args.isRegex as boolean | undefined,
        caseSensitive: args.caseSensitive as boolean | undefined,
        contextLines: args.contextLines as number | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
    }

    if (action === "read" || action === "slice") {
      const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
      if (!resolved.success) return resolved.error;
      return performLogSlice(resolved.data, {
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
      });
    }

    if (action === "tail") {
      const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
      if (!resolved.success) return resolved.error;
      return performLogTail(resolved.data, {
        lines: (args.lines || args.limit) as number | undefined,
      });
    }

    if (action === "head") {
      const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
      if (!resolved.success) return resolved.error;
      return performLogHead(resolved.data, {
        lines: (args.lines || args.limit) as number | undefined,
      });
    }

    if (action === "status" || action === "logs" || action === "log") {
      if (args.query || args.pattern) {
        const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
        if (!resolved.success) return resolved.error;
        return performLogGrep(resolved.data, {
          query: (args.query || args.pattern) as string,
          isRegex: args.isRegex as boolean | undefined,
          caseSensitive: args.caseSensitive as boolean | undefined,
          contextLines: args.contextLines as number | undefined,
          limit: args.limit as number | undefined,
          offset: args.offset as number | undefined,
        });
      }

      if (args.offset !== undefined || (args.limit !== undefined && action !== "status")) {
        const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
        if (!resolved.success) return resolved.error;
        return performLogSlice(resolved.data, {
          offset: args.offset as number | undefined,
          limit: args.limit as number | undefined,
        });
      }

      if (args.lines !== undefined) {
        const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
        if (!resolved.success) return resolved.error;
        return performLogTail(resolved.data, {
          lines: args.lines as number | undefined,
        });
      }

      if (!processId) {
        return "Error: processId is required for status, send_input, kill, and wait actions.";
      }

      const task = backgroundTasks.get(processId);
      if (!task) {
        return `Error: No background process found with ID "${processId}"`;
      }

      const fullOutput = task.output.join("");
      const formattedOutput = formatAndTruncateOutput(fullOutput, 50, task.logPath || "");
      return `Process: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${formattedOutput}`;
    }

    if (action === "send_input") {
      if (!processId) {
        return "Error: processId is required for status, send_input, kill, and wait actions.";
      }
      const task = backgroundTasks.get(processId);
      if (!task) {
        return `Error: No background process found with ID "${processId}"`;
      }
      if (input === undefined) {
        return "Error: input is required for send_input action.";
      }
      try {
        task.process.stdin?.write(input + "\n");
        return `Sent input to process "${processId}".`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error sending input: ${message}`;
      }
    }

    if (action === "kill") {
      if (!processId) {
        return "Error: processId is required for status, send_input, kill, and wait actions.";
      }
      const task = backgroundTasks.get(processId);
      if (!task) {
        return `Error: No background process found with ID "${processId}"`;
      }
      try {
        killProcessTree(task.process.pid);
        backgroundTasks.delete(processId);
        notifyTasksChanged();
        return `Process "${processId}" has been killed successfully.`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error killing process: ${message}`;
      }
    }

    if (action === "wait") {
      if (!processId) {
        return "Error: processId is required for status, send_input, kill, and wait actions.";
      }
      const task = backgroundTasks.get(processId);
      if (!task) {
        return `Error: No background process found with ID "${processId}"`;
      }

      if (task.hasExited) {
        const logs = task.output.join("");
        const formattedLogs = formatAndTruncateOutput(logs, 50, task.logPath || "");
        return `Process has completed with exit code ${task.exitCode}.\nOutput:\n${formattedLogs}`;
      }

      const timeoutMs = (args.timeout as number) || 600000;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const err = new Error("TimeoutError");
          err.name = "TimeoutError";
          reject(err);
        }, timeoutMs);
      });

      const exitPromise = new Promise<void>((resolve) => {
        const check = () => {
          if (task.hasExited) {
            resolve();
            return true;
          }
          return false;
        };

        if (check()) return;

        const interval = setInterval(() => {
          if (check()) {
            clearInterval(interval);
          }
        }, 50);

        try {
          task.process.once("close", () => {
            clearInterval(interval);
            resolve();
          });
        } catch {
          // ignore if process emitter not available
        }
      });

      const onAbort = () => {
        if (timeoutId) clearTimeout(timeoutId);
        const err = new Error("AbortError");
        err.name = "AbortError";
        throw err;
      };

      if (signal) {
        if (signal.aborted) {
          if (timeoutId) clearTimeout(timeoutId);
          throw new Error("AbortError");
        }
        signal.addEventListener("abort", onAbort);
      }

      try {
        await Promise.race([exitPromise, timeoutPromise]);
        if (timeoutId) clearTimeout(timeoutId);
        const logs = task.output.join("");
        const formattedLogs = formatAndTruncateOutput(logs, 50, task.logPath || "");
        return `Process completed with exit code ${task.exitCode}.\nOutput:\n${formattedLogs}`;
      } catch (err: any) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err && err.name === "TimeoutError") {
          return `Error: Timeout of ${timeoutMs}ms exceeded while waiting for background process "${processId}".`;
        }
        throw err;
      } finally {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
      }
    }

    if (action === "stream") {
      if (!processId) {
        return "Error: processId is required for status, send_input, kill, and wait actions.";
      }
      const task = backgroundTasks.get(processId);
      if (!task) {
        return `Error: No background process found with ID "${processId}"`;
      }
      if (task.hasExited) {
        return `Process "${processId}" has already exited with code ${task.exitCode}. Use 'status' to read its final output.`;
      }
      clearActiveToolOutput();
      appendActiveToolOutput(`[Streaming output from background process "${processId}"...]\n`);

      const streamDurationMs = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : 5000;

      let listener: ((data: Buffer) => void) | undefined;
      let timer: NodeJS.Timeout | undefined;
      const streamPromise = new Promise<void>((resolve) => {
        listener = (data: Buffer) => {
          appendActiveToolOutput(data.toString());
        };
        task.process.all?.on("data", listener);

        timer = setTimeout(() => {
          resolve();
        }, streamDurationMs);

        const onExit = () => {
          if (timer) clearTimeout(timer);
          resolve();
        };

        task.process.once("close", onExit);

        if (signal) {
          signal.addEventListener("abort", () => {
            if (timer) clearTimeout(timer);
            resolve();
          }, { once: true });
        }
      });

      try {
        await streamPromise;
      } finally {
        if (timer) clearTimeout(timer);
        if (listener) {
          task.process.all?.removeListener("data", listener);
        }
        clearActiveToolOutput();
      }

      const logs = task.output.join("");
      const formattedLogs = formatAndTruncateOutput(logs, 50, task.logPath || "");
      if (task.hasExited) {
        return `Process "${processId}" completed with exit code ${task.exitCode}.\nFull output:\n${formattedLogs}`;
      }
      return `Streaming finished for process "${processId}" (${streamDurationMs}ms window; process is still running).\nRecent output:\n${formattedLogs}`;
    }

    return formatUnknownActionError(
      action,
      ["list", "status", "logs", "grep", "search", "tail", "head", "read", "slice", "list_logs", "send_input", "kill", "wait", "stream"],
      "Use 'list' to inspect active processes or 'list_logs' to see log files."
    );
  },
};

export const inspectBackgroundLogTool: Tool = {
  name: "inspect_background_log",
  description: "Inspect, slice, tail, head, grep, or search background process output logs. Specify processId or direct logPath.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["grep", "search", "tail", "head", "read", "slice", "list_logs"],
        description: "Action to perform on the log: 'grep'/'search' to find matching lines, 'tail' for recent lines, 'head' for initial lines, 'read'/'slice' for specific line range, 'list_logs' to list available log files.",
      },
      processId: {
        type: "string",
        description: "The background process ID (e.g. returned by run_background_process)",
      },
      logPath: {
        type: "string",
        description: "Direct file path to a .log file on disk (optional alternative to processId)",
      },
      query: {
        type: "string",
        description: "Search string or regex pattern (for 'grep' or 'search')",
      },
      contextLines: {
        type: "number",
        description: "Number of context lines before/after matches in grep (default 2)",
      },
      offset: {
        type: "number",
        description: "Starting line number, 1-indexed (for 'read'/'slice')",
      },
      limit: {
        type: "number",
        description: "Max lines or matches to return (default 100 for slice/read, 50 for grep/tail)",
      },
      lines: {
        type: "number",
        description: "Number of lines for tail/head (default 50)",
      },
      caseSensitive: {
        type: "boolean",
        description: "Case-sensitive search for grep (default false)",
      },
      isRegex: {
        type: "boolean",
        description: "Treat query as regular expression (default false)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    if (action === "list_logs") {
      return performListLogs(args.limit as number | undefined);
    }
    const resolved = resolveTaskLogInfo(args as { processId?: string; logPath?: string }, cwd);
    if (!resolved.success) {
      return resolved.error;
    }
    if (action === "grep" || action === "search") {
      return performLogGrep(resolved.data, {
        query: (args.query || args.pattern) as string,
        isRegex: args.isRegex as boolean | undefined,
        caseSensitive: args.caseSensitive as boolean | undefined,
        contextLines: args.contextLines as number | undefined,
        limit: args.limit as number | undefined,
        offset: args.offset as number | undefined,
      });
    }
    if (action === "read" || action === "slice") {
      return performLogSlice(resolved.data, {
        offset: args.offset as number | undefined,
        limit: args.limit as number | undefined,
      });
    }
    if (action === "tail") {
      return performLogTail(resolved.data, {
        lines: (args.lines || args.limit) as number | undefined,
      });
    }
    if (action === "head") {
      return performLogHead(resolved.data, {
        lines: (args.lines || args.limit) as number | undefined,
      });
    }
    return formatUnknownActionError(action, ["grep", "search", "tail", "head", "read", "slice", "list_logs"]);
  },
};
