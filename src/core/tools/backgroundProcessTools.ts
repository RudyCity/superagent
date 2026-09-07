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
        enum: ["list", "status", "send_input", "kill", "wait", "stream"],
        description: "Action to perform. Use 'stream' to pipe a running background process's future output live to the SYSTEM_CALL_OUTPUT (LIVE) console.",
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

    if (action === "status") {
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

      const timeoutMs = (args.timeout as number) || 600000;
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          const err = new Error("TimeoutError");
          err.name = "TimeoutError";
          reject(err);
        }, timeoutMs);
      });

      task.process.all?.on("data", (data: Buffer) => {
        appendActiveToolOutput(data.toString());
      });

      const exitPromise = new Promise<void>((resolve) => {
        if (task.hasExited) { resolve(); return; }
        try {
          task.process.once("close", () => resolve());
        } catch {
          resolve();
        }
      });

      const onAbort = () => { if (timeoutId) clearTimeout(timeoutId); };
      if (signal) {
        if (signal.aborted) {
          if (timeoutId) clearTimeout(timeoutId);
          clearActiveToolOutput();
          return "Aborted.";
        }
        signal.addEventListener("abort", onAbort);
      }

      try {
        await Promise.race([exitPromise, timeoutPromise]);
        if (timeoutId) clearTimeout(timeoutId);
        clearActiveToolOutput();
        const logs = task.output.join("");
        const formattedLogs = formatAndTruncateOutput(logs, 50, task.logPath || "");
        return `Process "${processId}" completed with exit code ${task.exitCode}.\nFull output:\n${formattedLogs}`;
      } catch (err: any) {
        if (timeoutId) clearTimeout(timeoutId);
        clearActiveToolOutput();
        if (err && err.name === "TimeoutError") {
          return `Streaming stopped: Timeout of ${timeoutMs}ms exceeded. Process "${processId}" is still running.`;
        }
        throw err;
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
      }
    }

    return formatUnknownActionError(action, ["list", "status", "send_input", "kill", "wait", "stream"], "Use 'list' to inspect available process IDs.");
  },
};
