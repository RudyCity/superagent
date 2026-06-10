import { execa } from "execa";
import { Tool, BackgroundTask } from "./types.js";
import { formatCommandForPowerShell, truncateOutput, detectInteractivePrompt } from "./helpers.js";
import { 
  backgroundTasks, 
  notifyTasksChanged, 
  clearActiveToolOutput, 
  appendActiveToolOutput 
} from "./state.js";

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
    const isWin = process.platform === "win32";
    if (isWin) {
      command = formatCommandForPowerShell(command);
    }

    try {
      clearActiveToolOutput();
      const proc = execa(command, {
        shell: isWin ? "powershell.exe" : true,
        cwd,
        timeout,
        reject: false,
        all: true,
        cancelSignal: signal,
      });

      let interactiveWarning: string | null = null;
      proc.all?.on("data", (data) => {
        const text = data.toString();
        appendActiveToolOutput(text);
        const warning = detectInteractivePrompt(text);
        if (warning) {
          interactiveWarning = warning;
        }
      });

      const result = await proc;
      clearActiveToolOutput();
      let output = (result.all || result.stdout || "").trim();
      output = truncateOutput(output);
      
      if (interactiveWarning) {
        output = `${interactiveWarning}\n\n${output}`;
      }

      if (result.exitCode !== 0) {
        return `Exit code: ${result.exitCode}\n${output}`;
      }
      return output || "(no output)";
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
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const isWin = process.platform === "win32";
    if (isWin) {
      command = formatCommandForPowerShell(command);
    }
    const shell = isWin ? "powershell.exe" : true;
    try {
      clearActiveToolOutput();
      const proc = execa(command, {
        shell,
        cwd,
        reject: false,
        all: true,
        cancelSignal: signal,
      });

      let interactiveWarning: string | null = null;
      proc.all?.on("data", (data) => {
        const text = data.toString();
        appendActiveToolOutput(text);
        const warning = detectInteractivePrompt(text);
        if (warning) {
          interactiveWarning = warning;
        }
      });

      const result = await proc;
      clearActiveToolOutput();
      let output = (result.all || result.stdout || "").trim();
      output = truncateOutput(output);

      if (interactiveWarning) {
        output = `${interactiveWarning}\n\n${output}`;
      }
      return output || "(no output)";
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
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    let command = args.command as string;
    const isWin = process.platform === "win32";
    if (isWin) {
      command = formatCommandForPowerShell(command);
    }
    const taskId = Math.random().toString(36).substring(2, 9);

    try {
      const proc = execa(command, {
        shell: isWin ? "powershell.exe" : true,
        cwd,
        reject: false,
        all: true,
      });

      const task: BackgroundTask = {
        id: taskId,
        command,
        process: proc,
        output: [],
      };

      backgroundTasks.set(taskId, task);
      notifyTasksChanged();

      proc.all?.on("data", (data) => {
        const text = data.toString();
        task.output.push(text);
        if (task.output.length > 1000) {
          task.output.shift();
        }
      });

      proc.on("close", (code) => {
        task.output.push(`\n[Process exited with code ${code}]`);
        notifyTasksChanged();
      });

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
      task.process.kill();
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
      return `Task: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${task.output.join("")}`;
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
      return `Task: ${task.command}\nStatus: ${task.process.killed ? "Killed" : "Running/Completed"}\nOutput:\n${task.output.join("")}`;
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
        task.process.kill();
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
