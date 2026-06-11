import { execa } from "execa";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { Tool, BackgroundTask } from "./types.js";
import { getGlobalConfigDir } from "../config.js";
import { 
  formatCommandForPowerShell, 
  truncateOutput, 
  detectInteractivePrompt, 
  resolveWindowsShell 
} from "./helpers.js";
import { 
  backgroundTasks, 
  notifyTasksChanged, 
  clearActiveToolOutput, 
  appendActiveToolOutput 
} from "./state.js";

function formatAndTruncateOutput(output: string, maxLines: number, logPath: string): string {
  const trimmed = output.trim();
  const lines = trimmed.split(/\r?\n/);
  if (lines.length > maxLines) {
    const lastLines = lines.slice(lines.length - maxLines).join("\n");
    return `${lastLines}\n\n... (output truncated, full logs saved at: ${logPath})`;
  }
  return trimmed;
}

export function killProcessTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      exec(`taskkill /F /T /PID ${pid}`);
    } catch {
      // Ignore
    }
  } else {
    try {
      exec(`pkill -P ${pid}`);
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore
    }
  }
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command. Use for git, npm, build tools, etc. Returns stdout+stderr.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to execute",
      },
      timeout: {
        type: "number",
        description: "Timeout in ms (default 600000)",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const timeout = (args.timeout as number) || 600000;
    
    let shellPath: string | boolean = true;
    if (process.platform === "win32") {
      const resolved = resolveWindowsShell();
      shellPath = resolved.shellPath;
      if (!resolved.isBash) {
        command = formatCommandForPowerShell(command);
      }
    }

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error("TimeoutError");
        err.name = "TimeoutError";
        reject(err);
      }, timeout);
    });

    try {
      clearActiveToolOutput();
      const proc = execa(command, {
        shell: shellPath,
        cwd,
        reject: false,
        all: true,
      });

      const abortHandler = () => {
        killProcessTree(proc.pid);
      };

      if (signal) {
        if (signal.aborted) {
          killProcessTree(proc.pid);
          throw new Error("AbortError");
        }
        signal.addEventListener("abort", abortHandler);
      }

      let interactiveWarning: string | null = null;
      proc.all?.on("data", (data) => {
        const text = data.toString();
        appendActiveToolOutput(text);
        const warning = detectInteractivePrompt(text);
        if (warning) {
          interactiveWarning = warning;
          killProcessTree(proc.pid);
        }
      });

      try {
        const result = await Promise.race([proc, timeoutPromise]);
        clearActiveToolOutput();
        let output = (result.all || result.stdout || "").trim();
        output = truncateOutput(output);
        
        if (interactiveWarning) {
          return `Error: Interactive prompt detected. Foreground execution aborted.\n\n${interactiveWarning}\n\nTo interact with this command, please run it in the background using 'run_background', then monitor it with 'manage_task' (action: 'status') and send inputs using 'manage_task' (action: 'send_input').`;
        }

        if (result.exitCode !== 0) {
          return `Exit code: ${result.exitCode}\n${output}`;
        }
        return output || "(no output)";
      } catch (innerErr: any) {
        if (innerErr && innerErr.name === "TimeoutError") {
          killProcessTree(proc.pid);
          return `Error executing command: Timeout of ${timeout}ms exceeded.`;
        }
        throw innerErr;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    } catch (err: unknown) {
      clearActiveToolOutput();
      if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "CancelError"))) {
        const abortErr = new Error("AbortError");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing command: ${message}`;
    }
  },
};

export const runCommandTool: Tool = {
  name: "run_command",
  description: "Run a terminal command (PowerShell on Windows, default shell on other OS).",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run",
      },
      cwd: {
        type: "string",
        description: "Optional working directory to run the command in (relative to current directory or absolute)",
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds (default 120000 / 2 minutes)",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const targetCwd = args.cwd 
      ? path.resolve(cwd, args.cwd as string)
      : cwd;
    const timeout = (args.timeout as number) || 120000;

    let shellPath: string | boolean = true;
    if (process.platform === "win32") {
      const resolved = resolveWindowsShell();
      shellPath = resolved.shellPath;
      if (!resolved.isBash) {
        command = formatCommandForPowerShell(command);
      }
    }

    let timeoutId: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        const err = new Error("TimeoutError");
        err.name = "TimeoutError";
        reject(err);
      }, timeout);
    });

    try {
      clearActiveToolOutput();
      const proc = execa(command, {
        shell: shellPath,
        cwd: targetCwd,
        reject: false,
        all: true,
      });

      const abortHandler = () => {
        killProcessTree(proc.pid);
      };

      if (signal) {
        if (signal.aborted) {
          killProcessTree(proc.pid);
          throw new Error("AbortError");
        }
        signal.addEventListener("abort", abortHandler);
      }

      let interactiveWarning: string | null = null;
      proc.all?.on("data", (data) => {
        const text = data.toString();
        appendActiveToolOutput(text);
        const warning = detectInteractivePrompt(text);
        if (warning) {
          interactiveWarning = warning;
          killProcessTree(proc.pid);
        }
      });

      try {
        const result = await Promise.race([proc, timeoutPromise]);
        clearActiveToolOutput();
        let output = (result.all || result.stdout || "").trim();
        output = truncateOutput(output);

        if (interactiveWarning) {
          return `Error: Interactive prompt detected. Foreground execution aborted.\n\n${interactiveWarning}\n\nTo interact with this command, please run it in the background using 'run_background', then monitor it with 'manage_task' (action: 'status') and send inputs using 'manage_task' (action: 'send_input').`;
        }
        return output || "(no output)";
      } catch (innerErr: any) {
        if (innerErr && innerErr.name === "TimeoutError") {
          killProcessTree(proc.pid);
          return `Error executing command: Timeout of ${timeout}ms exceeded. If this command is a long-running process (like a dev server, watcher, or database), please run it in the background using 'run_background' instead.`;
        }
        throw innerErr;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
      }
    } catch (err: unknown) {
      clearActiveToolOutput();
      if (signal?.aborted || (err instanceof Error && (err.name === "AbortError" || err.name === "CancelError"))) {
        const abortErr = new Error("AbortError");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      const message = err instanceof Error ? err.message : String(err);
      return `Error executing command: ${message}`;
    }
  },
};

export const runBackgroundTool: Tool = {
  name: "run_background",
  description: "Run a shell command in the background. Returns a task ID.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run in the background",
      },
      cwd: {
        type: "string",
        description: "Optional working directory to run the command in (relative to current directory or absolute)",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const targetCwd = args.cwd 
      ? path.resolve(cwd, args.cwd as string)
      : cwd;

    let shellPath: string | boolean = true;
    if (process.platform === "win32") {
      const resolved = resolveWindowsShell();
      shellPath = resolved.shellPath;
      if (!resolved.isBash) {
        command = formatCommandForPowerShell(command);
      }
    }
    const taskId = Math.random().toString(36).substring(2, 9);
    const tasksLogDir = path.join(getGlobalConfigDir(), "tasks");
    if (!fs.existsSync(tasksLogDir)) {
      fs.mkdirSync(tasksLogDir, { recursive: true });
    }
    const logPath = path.join(tasksLogDir, `${taskId}.log`);
    try {
      fs.writeFileSync(logPath, "");
    } catch {
      // Ignore write errors
    }

    try {
      const proc = execa(command, {
        shell: shellPath,
        cwd: targetCwd,
        reject: false,
        all: true,
      });

      const task: BackgroundTask = {
        id: taskId,
        command,
        process: proc,
        output: [],
        logPath,
      };

      backgroundTasks.set(taskId, task);
      notifyTasksChanged();

      proc.all?.on("data", (data) => {
        const text = data.toString();
        task.output.push(text);
        if (task.output.length > 1000) {
          task.output.shift();
        }
        try {
          fs.appendFileSync(logPath, text);
        } catch {
          // ignore
        }
      });

      let hasExited = false;
      let exitCode: number | null = null;

      proc.on("close", (code) => {
        hasExited = true;
        exitCode = code;
        const exitMsg = `\n[Process exited with code ${code}]`;
        task.output.push(exitMsg);
        try {
          fs.appendFileSync(logPath, exitMsg);
        } catch {
          // ignore
        }
        notifyTasksChanged();
      });

      // Settle time wait of 2000ms
      await new Promise<void>((resolve) => setTimeout(resolve, 2000));

      if (hasExited) {
        backgroundTasks.delete(taskId);
        notifyTasksChanged();
        const logs = task.output.join("");
        const formattedLogs = formatAndTruncateOutput(logs, 20, logPath);
        if (exitCode !== 0) {
          return `Error: Background task failed instantly (exit code ${exitCode}).\nLogs:\n${formattedLogs}`;
        }
        return `Background task finished successfully immediately.\nOutput:\n${formattedLogs}`;
      }

      return `Started task in background. Task ID: ${taskId}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Failed to start background task: ${message}`;
    }
  },
};

export const killTaskTool: Tool = {
  name: "kill_task",
  description: "Terminate a background task by ID.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "The Task ID returned by run_background",
      },
    },
    required: ["taskId"],
  },
  async execute(args, cwd, signal) {
    const taskId = args.taskId as string;
    const task = backgroundTasks.get(taskId);
    if (!task) {
      return `Error: No task found with ID "${taskId}"`;
    }

    try {
      killProcessTree(task.process.pid);
      backgroundTasks.delete(taskId);
      notifyTasksChanged();
      return `Task "${taskId}" has been killed successfully.`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error killing task: ${message}`;
    }
  },
};

export const viewBackgroundTasksTool: Tool = {
  name: "view_background_tasks",
  description: "List running background tasks and show their recent output logs.",
  parameters: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Optional Task ID to view detailed output for. If omitted, lists all tasks.",
      },
    },
  },
  async execute(args, cwd, signal) {
    const taskId = args.taskId as string;
    if (taskId) {
      const task = backgroundTasks.get(taskId);
      if (!task) return `No task found with ID "${taskId}"`;
      const fullOutput = task.output.join("");
      const formattedOutput = formatAndTruncateOutput(fullOutput, 50, task.logPath || "");
      return `Task: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${formattedOutput}`;
    }

    if (backgroundTasks.size === 0) return "No active background tasks.";
    const lines: string[] = [];
    for (const [id, task] of backgroundTasks.entries()) {
      lines.push(`Task ID: ${id} | Command: ${task.command}`);
    }
    return lines.join("\n");
  },
};

export const manageTaskTool: Tool = {
  name: "manage_task",
  description: "Manage background tasks: list them, check status/output, send input, or kill them.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "status", "send_input", "kill"],
        description: "Action to perform",
      },
      taskId: {
        type: "string",
        description: "The background task ID",
      },
      input: {
        type: "string",
        description: "The input string to send (required for send_input)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const taskId = args.taskId as string;
    const input = args.input as string;

    if (action === "list") {
      if (backgroundTasks.size === 0) return "No active background tasks.";
      const lines: string[] = [];
      for (const [id, task] of backgroundTasks.entries()) {
        lines.push(`Task ID: ${id} | Command: ${task.command}`);
      }
      return lines.join("\n");
    }

    if (!taskId) {
      return "Error: taskId is required for status, send_input, and kill actions.";
    }

    const task = backgroundTasks.get(taskId);
    if (!task) {
      return `Error: No task found with ID "${taskId}"`;
    }

    if (action === "status") {
      const fullOutput = task.output.join("");
      const formattedOutput = formatAndTruncateOutput(fullOutput, 50, task.logPath || "");
      return `Task: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${formattedOutput}`;
    }

    if (action === "send_input") {
      if (input === undefined) {
        return "Error: input is required for send_input action.";
      }
      try {
        task.process.stdin?.write(input + "\n");
        return `Sent input to task "${taskId}".`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error sending input: ${message}`;
      }
    }

    if (action === "kill") {
      try {
        killProcessTree(task.process.pid);
        backgroundTasks.delete(taskId);
        notifyTasksChanged();
        return `Task "${taskId}" has been killed successfully.`;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error killing task: ${message}`;
      }
    }

    return `Error: Unknown action "${action}"`;
  },
};
