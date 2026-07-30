import { execa } from "execa";
import { exec } from "child_process";
import path from "path";
import fs from "fs";
import { Tool, BackgroundTask } from "./types.js";
import { getGlobalConfigDir, getRootConfigDir, getWorkspaceTasksLogDir } from "../config.js";
import { 
  formatCommandForPowerShell, 
  truncateOutput, 
  detectInteractivePrompt, 
  resolveWindowsShell,
  normalizeGitPaths,
  normalizeWindowsPackageRunner,
  formatUnknownActionError
} from "./helpers.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import { 
  sshRunCommandExecute, 
  sshRunBackgroundProcessExecute,
  sshKillBackgroundProcessExecute,
  sshViewBackgroundProcessesExecute,
  sshManageBackgroundProcessExecute
} from "../ssh/sshCommands.js";
import { 
  backgroundTasks, 
  notifyTasksChanged, 
  clearActiveToolOutput, 
  appendActiveToolOutput 
} from "./state.js";
import net from "net";

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

async function findAvailablePort(startPort: number): Promise<number> {
  let port = startPort;
  while (!(await isPortAvailable(port))) {
    port++;
  }
  return port;
}

export async function adjustCommandPorts(command: string): Promise<string> {
  let adjusted = command;
  const portRegexes = [
    /(PORT=)(\d+)/gi,
    /(--port\s+)(\d+)/gi,
    /(-p\s+)(\d+)/gi
  ];

  for (const regex of portRegexes) {
    let match;
    while ((match = regex.exec(adjusted)) !== null) {
      const prefix = match[1];
      const originalPort = parseInt(match[2], 10);
      if (!isNaN(originalPort)) {
        const newPort = await findAvailablePort(originalPort);
        if (newPort !== originalPort) {
          adjusted = adjusted.replace(match[0], `${prefix}${newPort}`);
        }
      }
    }
  }
  return adjusted;
}

export async function acquireNpmLock(): Promise<() => void> {
  const lockPath = path.join(getRootConfigDir(), "npm_install.lock");
  const start = Date.now();
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      };
    } catch (err: any) {
      if (err.code === "EEXIST") {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > 120000) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
        } catch {}
      }
      if (Date.now() - start > 60000) {
        return () => {};
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

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
    const rawCommand = (args.command ?? args.cmd) as string | undefined;
    if (!rawCommand || typeof rawCommand !== "string" || rawCommand.trim() === "") {
      return "Error: Missing required parameter 'command'. Provide the shell command to execute.";
    }
    if (workspaceMode.isSsh()) {
      // In SSH mode, default cwd to remote workspace cwd so commands like `dir`, `pwd`, `ls`
      // resolve correctly without violating workspace boundaries.
      // Skip pathHelpers boundary validation entirely — sshProxy.normalizePosixPath enforces
      // it correctly for remote paths.
      const sshCfg = workspaceMode.getConfig();
      const remoteCwd = sshCfg?.remoteCwd || ".";
      const requestedCwd = (args.cwd as string | undefined) || remoteCwd;
      return await sshRunCommandExecute(rawCommand, requestedCwd, undefined, signal);
    }
    let command = normalizeGitPaths(rawCommand);
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
          return `Error: Interactive prompt detected. Foreground execution aborted.\n\n${interactiveWarning}\n\nTo interact with this command, please run it in the background using 'run_background_process', then monitor it with 'manage_background_process' (action: 'status') and send inputs using 'manage_background_process' (action: 'send_input').`;
        }

        const exitCodeNum = typeof result.exitCode === "number" ? result.exitCode : 0;
        if (exitCodeNum !== 0) {
          return `Exit code: ${exitCodeNum}\n${output}`;
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
  description: "Run a terminal command (Git Bash or PowerShell on Windows, default shell on other OS).",
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
    const rawCommand = (args.command ?? args.cmd) as string | undefined;
    if (!rawCommand || typeof rawCommand !== "string" || rawCommand.trim() === "") {
      return "Error: Missing required parameter 'command'. Provide the shell command to execute.";
    }
    if (workspaceMode.isSsh()) {
      return await sshRunCommandExecute(rawCommand, args.cwd as string | undefined, undefined, signal);
    }
    let command = normalizeGitPaths(rawCommand);
    const targetCwd = args.cwd 
      ? path.resolve(cwd, args.cwd as string)
      : cwd;
    const timeout = (args.timeout as number) || 120000;

    command = await adjustCommandPorts(command);

    let releaseLock: (() => void) | undefined;
    if (command.includes("npm install") || command.includes("npm i") || command.includes("yarn install") || command.includes("bun install") || command.includes("bun i")) {
      releaseLock = await acquireNpmLock();
    }

    let shellPath: string | boolean = true;
    if (process.platform === "win32") {
      const resolved = resolveWindowsShell();
      shellPath = resolved.shellPath;
      if (resolved.isBash && /^(npm|npx|pnpm|yarn|bun)(\s|$)/.test(command)) {
        command = normalizeWindowsPackageRunner(command);
      } else if (!resolved.isBash) {
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
          return `Error: Interactive prompt detected. Foreground execution aborted.\n\n${interactiveWarning}\n\nTo interact with this command, please run it in the background using 'run_background_process', then monitor it with 'manage_background_process' (action: 'status') and send inputs using 'manage_background_process' (action: 'send_input').`;
        }

        const exitCodeNum = typeof result.exitCode === "number" ? result.exitCode : 0;
        if (exitCodeNum !== 0) {
          const reporterHint = /Failed to load custom Reporter from (\w+)/.exec(output)?.[1];
          const hint = reporterHint ? `\nFix: Vitest reporter "${reporterHint}" is unavailable. Use default output, --reporter=dot, or --reporter=json.` : "";
          return `Exit code: ${exitCodeNum}\n${output}${hint}`;
        }

        return output || "(no output)";
      } catch (innerErr: any) {
        if (innerErr && innerErr.name === "TimeoutError") {
          killProcessTree(proc.pid);
          return `Error executing command: Timeout of ${timeout}ms exceeded. If this command is a long-running process (like a dev server, watcher, or database), please run it in the background using 'run_background_process' instead.`;
        }
        throw innerErr;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (signal) {
          signal.removeEventListener("abort", abortHandler);
        }
        if (releaseLock) releaseLock();
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

import http from "http";
import url from "url";

async function pingPort(port: number, host: string = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host, timeout: 1000 });
    socket.on("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => {
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function pingHttp(targetUrl: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const parsed = url.parse(targetUrl);
      const req = http.get({
        hostname: parsed.hostname || "localhost",
        port: parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.path || "/",
        timeout: 1000,
      }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on("error", () => {
        resolve(false);
      });
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

export const runBackgroundProcessTool: Tool = {
  name: "run_background_process",
  description: "Run a shell command in the background. Returns a process ID.",
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
      autoRetry: {
        type: "boolean",
        description: "Automatically prefix with package runner and retry if the command fails during health check",
      },
      onExit: {
        type: "string",
        description: "Lifecycle action on exit, e.g. 'restart'",
      },
      healthCheckUrl: {
        type: "string",
        description: "Optional HTTP URL (e.g. 'http://localhost:3000') to check if the process is healthy during start/retry.",
      },
      healthCheckPort: {
        type: "integer",
        description: "Optional TCP port number to check if the process is healthy during start/retry.",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    const rawCommand = (args.command ?? args.cmd) as string | undefined;
    if (!rawCommand || typeof rawCommand !== "string" || rawCommand.trim() === "") {
      return "Error: Missing required parameter 'command'. Provide the command to run in the background.";
    }
    if (workspaceMode.isSsh()) {
      return await sshRunBackgroundProcessExecute(rawCommand, args.cwd as string | undefined);
    }
    const targetCwd = args.cwd 
      ? path.resolve(cwd, args.cwd as string)
      : cwd;

    const autoRetry = !!args.autoRetry;
    const onExit = args.onExit as string | undefined;

    let commandToRun = normalizeGitPaths(rawCommand);

    let shellPath: string | boolean = true;
    if (process.platform === "win32") {
      const resolved = resolveWindowsShell();
      shellPath = resolved.shellPath;
    }

    const taskId = Math.random().toString(36).substring(2, 9);
    let sessionPath = process.env.SUPERAGENT_SESSION_PATH;
    try {
      const { agentLocalStorage } = await import("../agent.js");
      const activeAgent = agentLocalStorage.getStore();
      if (activeAgent) {
        sessionPath = activeAgent.getCurrentHistoryFilePath() || sessionPath;
      }
    } catch {
      // Ignored
    }

    const tasksLogDir = sessionPath
      ? path.join(path.dirname(sessionPath), "tasks")
      : getWorkspaceTasksLogDir();
    if (!fs.existsSync(tasksLogDir)) {
      fs.mkdirSync(tasksLogDir, { recursive: true });
    }
    const logPath = path.join(tasksLogDir, `${taskId}.log`);
    try {
      fs.writeFileSync(logPath, "");
    } catch {
      // Ignore write errors
    }

    let currentProc: any = null;
    let hasExited = false;
    let exitCode: number | null = null;
    let restartAttempts = 0;
    const maxRestarts = 5;
    let task: any = undefined;

    const startProcess = async () => {
      hasExited = false;
      exitCode = null;

      let finalCommand = await adjustCommandPorts(commandToRun);
      if (process.platform === "win32") {
        const resolved = resolveWindowsShell();
        if (!resolved.isBash) {
          finalCommand = formatCommandForPowerShell(finalCommand);
        }
      }

      currentProc = execa(finalCommand, {
        shell: shellPath,
        cwd: targetCwd,
        reject: false,
        all: true,
      });

      let currentTask: BackgroundTask;
      if (!task) {
        currentTask = {
          id: taskId,
          command: commandToRun,
          process: currentProc,
          output: [],
          logPath,
          autoRetry,
          onExit,
          cwd: targetCwd,
        };
        task = currentTask;
        backgroundTasks.set(taskId, task);
      } else {
        task.process = currentProc;
        task.command = commandToRun;
        task.hasExited = false;
        task.exitCode = undefined;
        task.cwd = targetCwd;
        currentTask = task;
      }

      notifyTasksChanged();

      currentProc.all?.on("data", (data: any) => {
        const text = data.toString();
        currentTask.output.push(text);
        if (currentTask.output.length > 1000) {
          currentTask.output.shift();
        }
        try {
          fs.appendFileSync(logPath, text);
        } catch {
          // ignore
        }
      });

      currentProc.on("close", async (code: number | null) => {
        hasExited = true;
        exitCode = code;
        currentTask.hasExited = true;
        currentTask.exitCode = code;
        const exitMsg = `\n[Process exited with code ${code}]`;
        currentTask.output.push(exitMsg);
        try {
          fs.appendFileSync(logPath, exitMsg);
        } catch {
          // ignore
        }
        notifyTasksChanged();

        if (code !== 0 && code !== null) {
          if (onExit === "restart" && restartAttempts < maxRestarts) {
            restartAttempts++;
            const restartMsg = `\n[System: Restarting background process (attempt ${restartAttempts}/${maxRestarts})...]\n`;
            currentTask.output.push(restartMsg);
            try {
              fs.appendFileSync(logPath, restartMsg);
            } catch {}
            startProcess();
            return;
          }

          try {
            const { agentLocalStorage } = await import("../agent.js");
            const activeAgent = agentLocalStorage.getStore();
            if (activeAgent && typeof activeAgent.getHistory === "function") {
              activeAgent.getHistory().addMessage({
                role: "system",
                content: `[NOTIFICATION] Background process "${taskId}" (${commandToRun}) exited unexpectedly with code ${code}.`,
                timestamp: Date.now(),
              });
              await activeAgent.saveHistory();
            }
          } catch (err) {
            // Ignored
          }
        }
      });
    };

    let fallbackPrefix = "bunx";
    if (fs.existsSync(path.join(targetCwd, "pnpm-lock.yaml"))) {
      fallbackPrefix = "pnpm dlx";
    } else if (fs.existsSync(path.join(targetCwd, "yarn.lock"))) {
      fallbackPrefix = "yarn dlx";
    } else if (fs.existsSync(path.join(targetCwd, "bun.lockb")) || fs.existsSync(path.join(targetCwd, "bun.lock"))) {
      fallbackPrefix = "bunx";
    }

    const waitForHealth = async (): Promise<boolean> => {
      let elapsedMs = 0;
      const checkInterval = 100;
      const timeoutMs = (args.healthCheckUrl || args.healthCheckPort) ? 3000 : 2000;
      
      while (elapsedMs < timeoutMs) {
        if (hasExited) {
          return exitCode === 0;
        }
        
        if (args.healthCheckUrl || args.healthCheckPort) {
          let healthPassed = true;
          if (args.healthCheckUrl) {
            healthPassed = await pingHttp(args.healthCheckUrl as string);
          } else if (args.healthCheckPort) {
            healthPassed = await pingPort(Number(args.healthCheckPort));
          }

          if (healthPassed) {
            return true;
          }
        }

        await new Promise<void>((resolve) => setTimeout(resolve, checkInterval));
        elapsedMs += checkInterval;
      }
      return !(args.healthCheckUrl || args.healthCheckPort);
    };

    try {
      await startProcess();

      let isHealthy = await waitForHealth();

      if (!isHealthy) {
        const trimmedLower = commandToRun.trim().toLowerCase();
        const hasPrefix = trimmedLower.startsWith("npx") || trimmedLower.startsWith("pnpm") || trimmedLower.startsWith("yarn") || trimmedLower.startsWith("bun");
        if (autoRetry && !hasPrefix) {
          if (currentProc && !hasExited) {
            currentProc.kill("SIGKILL");
          }
          commandToRun = `${fallbackPrefix} ${commandToRun}`;
          const retryMsg = `\n[System: Process failed health check. Retrying with '${fallbackPrefix}' prefix...]\n`;
          try {
            fs.appendFileSync(logPath, retryMsg);
          } catch {}
          
          await startProcess();

          isHealthy = await waitForHealth();
        }
      }

      if (!isHealthy) {
        if (hasExited) {
          backgroundTasks.delete(taskId);
          notifyTasksChanged();
          const logs = (task?.output || []).join("");
          const formattedLogs = formatAndTruncateOutput(logs, 20, logPath);
          if (args.healthCheckUrl || args.healthCheckPort) {
            return `Error: Background process failed health check (exited with code ${exitCode}).\nLogs:\n${formattedLogs}`;
          } else {
            return `Error: Background process failed instantly (exit code ${exitCode}).\nLogs:\n${formattedLogs}`;
          }
        } else {
          if (currentProc && typeof currentProc.kill === "function" && !hasExited) {
            currentProc.kill("SIGKILL");
          }
          backgroundTasks.delete(taskId);
          notifyTasksChanged();
          return `Error: Background process failed health check (did not become healthy on URL/port within 3s).`;
        }
      }

      if (hasExited) {
        backgroundTasks.delete(taskId);
        notifyTasksChanged();
        const logs = (task?.output || []).join("");
        const formattedLogs = formatAndTruncateOutput(logs, 20, logPath);
        if (exitCode !== 0) {
          return `Error: Background process failed instantly (exit code ${exitCode}).\nLogs:\n${formattedLogs}`;
        }
        return `Background process finished successfully immediately.\nOutput:\n${formattedLogs}`;
      }

      return `Started background process. Process ID: ${taskId}`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Failed to start background process: ${message}`;
    }
  },
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

      const unsubscribe = task.process.all?.on("data", (data: Buffer) => {
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
