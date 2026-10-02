/**
 * backgroundProcessTools.ts — Background process management tools for Superagent.
 *
 * Tools for killing, viewing, and managing background tasks launched via run_background_process.
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
      lines.push(`Process ID: ${id} | Command: ${task.command}`);
    }
    return lines.join("\n");
  },
};

export const manageBackgroundProcessTool: Tool = {
  name: "manage_background_process",
  description: "Manage background processes: list them, check status/output, send input, wait for completion, or kill them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "logs", "log", "send_input", "kill", "wait", "stream"],
        description: "Action to perform. Use 'status' or 'logs' to inspect output. Use 'stream' to sample live output (default 5s). Use 'wait' to block until process exits.",
      },
      processId: {
        type: "string",
        description: "The background process ID",
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
      return await sshManageBackgroundProcessExecute(action, processId, input);
    }

    if (action === "list") {
      if (backgroundTasks.size === 0) return "No active background processes.";
      const lines: string[] = [];
      for (const [id, task] of backgroundTasks.entries()) {
        lines.push(`Process ID: ${id} | Command: ${task.command}`);
      }
      return lines.join("\n");
    }

    if (!processId) {
      return "Error: processId is required for status, send_input, kill, and wait actions.";
    }

    const task = backgroundTasks.get(processId);
    if (!task) {
      return `Error: No background process found with ID "${processId}"`;
    }

    if (action === "status" || action === "logs" || action === "log") {
      const fullOutput = task.output.join("");
      const formattedOutput = formatAndTruncateOutput(fullOutput, 50, task.logPath || "");
      return `Process: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${formattedOutput}`;
    }

    if (action === "send_input") {
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
      if (task.hasExited) {
        return `Process "${processId}" has already exited with code ${task.exitCode}. Use 'status' to read its final output.`;
      }
      clearActiveToolOutput();
      appendActiveToolOutput(`[Streaming output from background process "${processId}"...]\n`);

      // Default stream sampling duration: 5 seconds (not 10 minutes) to avoid freezing agents on servers
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

    return formatUnknownActionError(action, ["list", "status", "logs", "send_input", "kill", "wait", "stream"], "Use 'list' to inspect available process IDs.");
  },
};
