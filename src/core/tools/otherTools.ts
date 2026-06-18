import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { Tool, ScheduleJob } from "./types.js";
import { scheduledJobs, notifyScheduleTriggered } from "./state.js";
import { ensureAndroidCliInstalled } from "../androidSetup.js";

export const askQuestionTool: Tool = {
  name: "ask_question",
  description: "Ask the user a multiple-choice question to clarify requirements or get design decisions. Returns the selected option.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user",
      },
      options: {
        type: "array",
        items: {
          type: "string",
        },
        description: "List of options for the user to choose from",
      },
      isMultiSelect: {
        type: "boolean",
        description: "If true, the user can select multiple options using space and submit with Enter",
      },
    },
    required: ["question", "options"],
  },
  async execute(args, cwd, signal) {
    let question = args.question as string || "";
    let rawOptionsVal = args.options;
    let isMultiSelect = args.isMultiSelect as boolean | undefined;

    if (Array.isArray(args.questions) && args.questions.length > 0) {
      const firstQ = args.questions[0];
      if (firstQ && typeof firstQ === "object") {
        const firstQObj = firstQ as Record<string, unknown>;
        if (typeof firstQObj.question === "string") {
          question = firstQObj.question;
        }
        if (firstQObj.options !== undefined) {
          rawOptionsVal = firstQObj.options;
        }
        if (typeof firstQObj.is_multi_select === "boolean") {
          isMultiSelect = firstQObj.is_multi_select;
        } else if (typeof firstQObj.isMultiSelect === "boolean") {
          isMultiSelect = firstQObj.isMultiSelect;
        }
      }
    }

    const rawOptions = Array.isArray(rawOptionsVal)
      ? rawOptionsVal
      : (rawOptionsVal !== undefined && rawOptionsVal !== null ? [rawOptionsVal] : []);
    const options: string[] = rawOptions.map(o => String(o));

    // Determine the calling agent's tier to route the question appropriately.
    // Master/Single tier → forward to user UI (activeQuestionHandler).
    // Superagent/Subagent tier → route to Master Agent LLM for answering.
    const { agentLocalStorage } = await import("../agent.js");
    const { getMasterAgent, getActiveQuestionHandler, appendMasterLog } = await import("./state.js");
    const currentAgent = agentLocalStorage.getStore();
    const currentTier = currentAgent ? (currentAgent as any).tier : undefined;

    if (currentTier === "superagent" || currentTier === "subagent") {
      const master = getMasterAgent();
      if (master && typeof master.answerQuestionAsMaster === "function") {
        const role = (currentAgent as any).subagentType || (currentAgent as any).tier || "?";
        const sourceLabel = currentTier === "superagent" ? `Superagent "${role}"` : `Subagent (${role})`;
        appendMasterLog(`[QUESTION] ${sourceLabel} asks: ${question} | Options: ${options.join(", ")}`);
        try {
          const selected = await master.answerQuestionAsMaster(question, options, {
            source: currentTier,
            role,
            typeName: (currentAgent as any).subagentType,
          });
          appendMasterLog(`[MASTER ANSWER] For ${sourceLabel}: "${selected}"`);
          return `Master Agent selected option: "${selected}"`;
        } catch (err: any) {
          return `Error getting Master Agent answer: ${err.message}`;
        }
      }
      // Single-mode fallback (no Master registered): route to user UI
      const fallbackHandler = getActiveQuestionHandler();
      if (fallbackHandler) {
        const role = (currentAgent as any).subagentType || (currentAgent as any).tier || "?";
        const prefix = currentTier === "superagent" ? `[Superagent "${role}"]` : `[Subagent (${role})]`;
        try {
          const selected = await fallbackHandler(`${prefix}: ${question}`, options, isMultiSelect);
          return `User selected option: "${selected}"`;
        } catch (err: any) {
          return `Error getting user answer: ${err.message}`;
        }
      }
      return `Error: No question handler available to route the question from tier "${currentTier}".`;
    }

    // Master / Single tier — forward to user UI as before
    const handler = getActiveQuestionHandler();
    if (!handler) {
      return `Error: ask_question must be executed interactively. No question handler is registered.`;
    }

    try {
      const selected = await handler(question, options, isMultiSelect);
      return `User selected option: "${selected}"`;
    } catch (err: any) {
      return `Error getting user answer: ${err.message}`;
    }
  },
};

export const scheduleTool: Tool = {
  name: "schedule",
  description: "Schedule a one-shot timer or recurring notification in the background. Optionally wait for it synchronously.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The message prompt to display when triggered",
      },
      durationSeconds: {
        type: "number",
        description: "Wait duration in seconds before triggering (for one-shot)",
      },
      cronExpression: {
        type: "string",
        description: "Simple interval (e.g. '1s' for 1 second, '5m' for 5 minutes, '1h' for 1 hour) for recurring checks",
      },
      wait: {
        type: "boolean",
        description: "Whether the tool should block and wait synchronously for the duration before returning control to the agent",
      },
    },
    required: ["prompt"],
  },
  async execute(args, cwd, signal) {
    const prompt = args.prompt as string;
    const durationSeconds = args.durationSeconds as number;
    const cronExpression = args.cronExpression as string;
    const wait = args.wait as boolean ?? false;
    const jobId = Math.random().toString(36).substring(2, 9);

    if (!durationSeconds && !cronExpression) {
      return "Error: Either durationSeconds or cronExpression must be provided.";
    }

    const job: ScheduleJob = { id: jobId, prompt };

    if (durationSeconds) {
      const ms = durationSeconds * 1000;
      
      if (wait) {
        // Limit blocking wait to a maximum of 300 seconds to prevent infinite lockups
        const MAX_WAIT_SECONDS = 300;
        if (durationSeconds > MAX_WAIT_SECONDS) {
          return `Error: Maximum blocking wait duration is ${MAX_WAIT_SECONDS} seconds (requested: ${durationSeconds}s). Use background scheduling (wait: false) for longer delays.`;
        }

        // Active waiting with visual countdown feedback
        await new Promise<void>((resolve, reject) => {
          let secondsLeft = durationSeconds;
          
          const interval = setInterval(() => {
            secondsLeft--;
            if (secondsLeft > 0) {
              process.stdout.write(`\r⏳ Active waiting: ${secondsLeft}s remaining... `);
            } else {
              process.stdout.write(`\r⏳ Active waiting: done!          \n`);
              clearInterval(interval);
            }
          }, 1000);

          const timeout = setTimeout(() => {
            clearInterval(interval);
            console.log(`\n[Schedule Triggered (ID: ${jobId})]: ${prompt}`);
            cleanup();
            resolve();
          }, ms);

          const onAbort = () => {
            clearInterval(interval);
            clearTimeout(timeout);
            cleanup();
            const err = new Error("AbortError");
            err.name = "AbortError";
            reject(err);
          };

          const cleanup = () => {
            if (signal) {
              signal.removeEventListener("abort", onAbort);
            }
          };

          if (signal) {
            signal.addEventListener("abort", onAbort);
          }
          
          process.stdout.write(`⏳ Active waiting: ${secondsLeft}s remaining... `);
        });
        
        return `One-shot timer ID: ${jobId} triggered after waiting ${durationSeconds} seconds. Prompt: ${prompt}`;
      } else {
        job.timer = setTimeout(() => {
          console.log(`\n[Schedule Triggered (ID: ${jobId})]: ${prompt}`);
          notifyScheduleTriggered(jobId, prompt);
          scheduledJobs.delete(jobId);
        }, ms);
        scheduledJobs.set(jobId, job);
        return `One-shot timer scheduled with ID: ${jobId} (triggers in ${durationSeconds} seconds)`;
      }
    }

    if (cronExpression) {
      const match = cronExpression.match(/^(\d+)([smh])$/);
      if (!match) {
        return "Error: cronExpression must be a simple interval like '10s', '5m', or '2h'.";
      }
      const val = parseInt(match[1], 10);
      const unit = match[2];
      let ms = val * 1000;
      if (unit === "m") ms *= 60;
      if (unit === "h") ms *= 3600;

      job.interval = setInterval(() => {
        console.log(`\n[Recurring Schedule Triggered (ID: ${jobId})]: ${prompt}`);
        notifyScheduleTriggered(jobId, prompt);
      }, ms);
      scheduledJobs.set(jobId, job);
      return `Recurring schedule configured with ID: ${jobId} (triggers every ${cronExpression})`;
    }

    return "Error scheduling job.";
  },
};

export const gitActionTool: Tool = {
  name: "git_action",
  description: "Execute a structured Git action (status, log, diff, commit, add, restore, clean).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "diff", "commit", "log", "add", "restore", "clean"],
        description: "The git action to perform",
      },
      message: {
        type: "string",
        description: "Commit message (required for commit)",
      },
      limit: {
        type: "number",
        description: "Max commit log entries (default 5)",
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "List of files/paths to stage or restore (used for add and restore)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const files = args.files as string[] || [];
    try {
      if (action === "status") {
        const { stdout } = await execa("git", ["status", "--porcelain"], { cwd, cancelSignal: signal });
        return stdout || "Clean working tree.";
      }
      if (action === "diff") {
        const { stdout } = await execa("git", ["diff"], { cwd, cancelSignal: signal });
        const truncateOutput = (await import("./helpers.js")).truncateOutput;
        return truncateOutput(stdout, 120) || "No unstaged changes.";
      }
      if (action === "commit") {
        const message = args.message as string;
        if (!message) return "Error: Commit message is required.";
        await execa("git", ["add", "-A"], { cwd, cancelSignal: signal });
        const { stdout } = await execa("git", ["commit", "-m", message], { cwd, cancelSignal: signal });
        return stdout;
      }
      if (action === "log") {
        const limit = (args.limit as number) || 5;
        const { stdout } = await execa("git", ["log", `-${limit}`, "--oneline"], { cwd, cancelSignal: signal });
        return stdout;
      }
      if (action === "add") {
        const targets = files.length > 0 ? files : ["-A"];
        await execa("git", ["add", ...targets], { cwd, cancelSignal: signal });
        return `Successfully staged files: ${targets.join(", ")}`;
      }
      if (action === "restore") {
        if (files.length === 0) {
          return "Error: The 'files' parameter is required for the restore action.";
        }
        await execa("git", ["restore", ...files], { cwd, cancelSignal: signal });
        return `Successfully restored files: ${files.join(", ")}`;
      }
      if (action === "clean") {
        const { stdout } = await execa("git", ["clean", "-fd"], { cwd, cancelSignal: signal });
        return stdout || "Cleaned untracked files/directories successfully.";
      }
      return "Unknown git action.";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Git action error: ${message}`;
    }
  },
};

export const screenshotTool: Tool = {
  name: "screenshot",
  description: "Capture current desktop screenshot to debug visual compose UI.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(args, cwd, signal) {
    const outputPath = path.resolve(cwd, `screenshot_${Date.now()}.png`);
    try {
      if (process.platform === "win32") {
        const psCommand = `
          Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
          $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
          $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
          $graphics = [System.Drawing.Graphics]::FromImage($bmp);
          $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size);
          $bmp.Save('${outputPath.replace(/\\/g, "\\\\")}');
          $graphics.Dispose();
          $bmp.Dispose();
        `.replace(/\n/s, " ");
        await execa("powershell.exe", ["-Command", psCommand], { cancelSignal: signal });
        return `Screenshot successfully captured: ${outputPath}`;
      } else if (process.platform === "darwin") {
        await execa("screencapture", ["-x", outputPath], { cancelSignal: signal });
        return `Screenshot successfully captured: ${outputPath}`;
      } else if (process.platform === "linux") {
        try {
          await execa("scrot", [outputPath], { cancelSignal: signal });
          return `Screenshot successfully captured: ${outputPath}`;
        } catch {
          try {
            await execa("gnome-screenshot", ["-f", outputPath], { cancelSignal: signal });
            return `Screenshot successfully captured: ${outputPath}`;
          } catch (err: any) {
            return `Failed to capture screenshot on Linux: scrot or gnome-screenshot must be installed.`;
          }
        }
      } else {
        return `Screenshot tool is not supported on platform: ${process.platform}`;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Failed to capture screenshot: ${message}`;
    }
  },
};

export const androidCliTool: Tool = {
  name: "android_cli",
  description: "Execute an Android CLI command (e.g., 'sdk list', 'emulator list', 'run'). Returns the output.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The android subcommand and options to run (e.g., 'sdk list', 'emulator list', 'info'). Do not include the 'android' command prefix.",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    const subCommand = args.command as string;
    await ensureAndroidCliInstalled();
    const isWin = process.platform === "win32";
    let exe = "android";
    if (isWin) {
      const userProfile = process.env.USERPROFILE || process.env.HOMEPATH || "C:\\Users\\USER";
      const winPath = path.join(userProfile, "AppData", "AndroidCLI", "android.exe");
      try {
        await fs.access(winPath);
        exe = `"${winPath}"`;
      } catch {}
    } else {
      const home = process.env.HOME || "";
      const unixPath = path.join(home, ".android-cli", "bin", "android");
      try {
        await fs.access(unixPath);
        exe = unixPath;
      } catch {}
    }
    const fullCommand = isWin ? `& ${exe} ${subCommand}` : `${exe} ${subCommand}`;
    try {
      const { stdout, stderr } = await execa(fullCommand, {
        cwd,
        cancelSignal: signal,
        shell: isWin ? "powershell.exe" : true,
      });
      return (stdout || stderr || "").trim() || "(no output)";
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Android CLI error: ${message}`;
    }
  },
};

export const searchHistoryTool: Tool = {
  name: "search_history",
  description: "Search all previous local workspace conversation history files for a query string.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query or keyword to look for in the history files (case-insensitive)",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd, signal) {
    const query = args.query as string;
    if (!query) {
      return "Error: query parameter is required.";
    }
    try {
      const { agentLocalStorage } = await import("../agent.js");
      const currentAgent = agentLocalStorage.getStore();
      const isMulti = currentAgent?.isMultiAgent || false;
      const { searchHistory } = await import("../historySearch.js");
      return await searchHistory(query, isMulti);
    } catch (err: any) {
      return `Error searching history: ${err.message}`;
    }
  },
};

// ─── git_worktree ────────────────────────────────────────────────────────────

export const gitWorktreeTool: Tool = {
  name: "git_worktree",
  description: "Manage Git worktrees (list, add, remove, prune) to inspect or clean up isolated workspaces.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "remove", "prune"],
        description: "The action to perform: 'list' (list worktrees), 'add' (create a worktree), 'remove' (remove a worktree), 'prune' (prune stale worktree metadata)",
      },
      path: {
        type: "string",
        description: "Path for the worktree directory (required for add and remove)",
      },
      branch: {
        type: "string",
        description: "Branch name or commit hash to check out (optional/required for add)",
      },
      force: {
        type: "boolean",
        description: "Force remove the worktree (optional for remove)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const worktreePath = args.path as string;
    const branch = args.branch as string;
    const force = args.force === true;

    try {
      if (action === "list") {
        const { stdout } = await execa("git", ["worktree", "list"], { cwd, cancelSignal: signal });
        return stdout || "No Git worktrees found.";
      }

      if (action === "prune") {
        const { stdout } = await execa("git", ["worktree", "prune"], { cwd, cancelSignal: signal });
        return stdout || "Git worktrees pruned successfully.";
      }

      if (action === "add") {
        if (!worktreePath) {
          return "Error: path parameter is required to add a worktree.";
        }
        const absolutePath = path.resolve(cwd, worktreePath);
        const argsList = ["worktree", "add", absolutePath];
        if (branch) {
          argsList.push(branch);
        }
        const { stdout } = await execa("git", argsList, { cwd, cancelSignal: signal });
        return stdout || `Worktree added at ${absolutePath}`;
      }

      if (action === "remove") {
        if (!worktreePath) {
          return "Error: path parameter is required to remove a worktree.";
        }
        const absolutePath = path.resolve(cwd, worktreePath);
        const argsList = ["worktree", "remove", absolutePath];
        if (force) {
          argsList.push("--force");
        }
        try {
          const { stdout } = await execa("git", argsList, { cwd, cancelSignal: signal });
          return stdout || `Worktree at ${absolutePath} removed successfully.`;
        } catch (err: any) {
          const message = err instanceof Error ? err.message : String(err);
          if (force && /not a working tree/i.test(message)) {
            const { stdout } = await execa("git", ["worktree", "prune"], { cwd, cancelSignal: signal });
            return stdout
              ? `Worktree metadata pruned after stale remove.\n${stdout}`
              : "Worktree metadata pruned after stale remove.";
          }

          if (force && /(filename too long|directory not empty|failed to delete)/i.test(message)) {
            await fs.rm(path.toNamespacedPath(absolutePath), {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 100,
            });
            const { stdout } = await execa("git", ["worktree", "prune"], { cwd, cancelSignal: signal });
            return stdout
              ? `Worktree directory removed with filesystem fallback: ${absolutePath}\n${stdout}`
              : `Worktree directory removed with filesystem fallback: ${absolutePath}`;
          }

          throw err;
        }
      }

      return `Error: Unknown action "${action}"`;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Git worktree error: ${message}`;
    }
  },
};

export const manageTasksTool: Tool = {
  name: "manage_tasks",
  description: "Manage tasks in the active task list (_task.md). Actions: 'list', 'add', 'update', 'remove'.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "update", "remove"],
        description: "The action to perform: 'list' (show all tasks), 'add' (add a new task), 'update' (change status of a task), 'remove' (remove a task)",
      },
      text: {
        type: "string",
        description: "Task description (required for action 'add')",
      },
      index: {
        type: "number",
        description: "1-based task index (required for actions 'update' and 'remove')",
      },
      status: {
        type: "string",
        enum: [" ", "/", "x"],
        description: "New status for the task: ' ' for pending, '/' for in progress, 'x' for completed (required for action 'update')",
      },
      sessionId: {
        type: "string",
        description: "Optional session ID of another agent to manage tasks for (multi-agent mode)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const text = args.text as string | undefined;
    const index = args.index as number | undefined;
    const status = args.status as string | undefined;
    const sessionId = args.sessionId as string | undefined;

    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();
    let taskPath: string;
    if (sessionId) {
      const { getRootConfigDir } = await import("../config.js");
      taskPath = path.join(getRootConfigDir(), "history", "multi", sessionId, `${sessionId}_task.md`);
    } else {
      taskPath = currentAgent ? currentAgent.getTaskFilePath() : path.resolve(cwd, "task.md");
    }

    const parseTasks = (content: string) => {
      const lines = content.split(/\r?\n/);
      const tasks: { lineIndex: number; line: string; status: string; text: string }[] = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const match = line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/);
        if (match) {
          tasks.push({
            lineIndex: i,
            line,
            status: match[1].toLowerCase(),
            text: match[2].trim(),
          });
        }
      }
      return { lines, tasks };
    };

    try {
      if (action === "list") {
        let content = "";
        try {
          content = await fs.readFile(taskPath, "utf-8");
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return `No active task list found at: ${taskPath}. Use action 'add' to create it.`;
          }
          throw err;
        }

        const { tasks } = parseTasks(content);
        if (tasks.length === 0) {
          return "The task list is currently empty.";
        }

        return tasks
          .map((t, idx) => `${idx + 1}. [${t.status}] ${t.text}`)
          .join("\n");
      }

      if (action === "add") {
        if (!text || text.trim() === "") {
          return "Error: The 'text' parameter is required for the 'add' action.";
        }

        let content = "";
        try {
          content = await fs.readFile(taskPath, "utf-8");
        } catch (err: any) {
          if (err.code !== "ENOENT") {
            throw err;
          }
          await fs.mkdir(path.dirname(taskPath), { recursive: true });
        }

        const newTaskLine = `- [ ] ${text.trim()}`;
        let updatedContent = content;
        if (content.length > 0 && !content.endsWith("\n")) {
          updatedContent += "\n";
        }
        updatedContent += newTaskLine + "\n";

        await fs.writeFile(taskPath, updatedContent, "utf-8");
        return `Successfully added task: "${text.trim()}"`;
      }

      if (action === "update") {
        if (index === undefined || index <= 0) {
          return "Error: A valid 1-based 'index' parameter is required for the 'update' action.";
        }
        if (!status) {
          return "Error: The 'status' parameter is required for the 'update' action.";
        }
        if (status !== " " && status !== "/" && status !== "x") {
          return `Error: Invalid status "${status}". Must be one of: ' ' (pending), '/' (in progress), 'x' (completed).`;
        }

        let content = "";
        try {
          content = await fs.readFile(taskPath, "utf-8");
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return `Error: Task list file does not exist at: ${taskPath}. Add a task first.`;
          }
          throw err;
        }

        const { lines, tasks } = parseTasks(content);
        if (index > tasks.length) {
          return `Error: Task index ${index} is out of bounds. There are only ${tasks.length} tasks in the list.`;
        }

        const targetTask = tasks[index - 1];
        const line = lines[targetTask.lineIndex];
        const match = line.match(/^(\s*-\s*`?\[)([xX/ ])(\]`?\s*)(.*)$/);
        
        if (!match) {
          return `Error: Failed to parse task line at index ${index} internally.`;
        }

        const prefix = match[1];
        const suffix = match[3] + match[4];
        const newLine = `${prefix}${status}${suffix}`;
        
        lines[targetTask.lineIndex] = newLine;
        await fs.writeFile(taskPath, lines.join("\n"), "utf-8");
        return `Successfully updated task ${index} to [${status}]: "${targetTask.text}"`;
      }

      if (action === "remove") {
        if (index === undefined || index <= 0) {
          return "Error: A valid 1-based 'index' parameter is required for the 'remove' action.";
        }

        let content = "";
        try {
          content = await fs.readFile(taskPath, "utf-8");
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return `Error: Task list file does not exist at: ${taskPath}.`;
          }
          throw err;
        }

        const { lines, tasks } = parseTasks(content);
        if (index > tasks.length) {
          return `Error: Task index ${index} is out of bounds. There are only ${tasks.length} tasks in the list.`;
        }

        const targetTask = tasks[index - 1];
        lines.splice(targetTask.lineIndex, 1);
        
        await fs.writeFile(taskPath, lines.join("\n"), "utf-8");
        return `Successfully removed task ${index}: "${targetTask.text}"`;
      }

      return `Error: Unknown action "${action}"`;
    } catch (err: any) {
      return `Error managing tasks: ${err.message}`;
    }
  }
};

export const listPeerSuperagentsTool: Tool = {
  name: "list_peer_superagents",
  description: "List all other active and completed Superagents running in parallel, including their roles, branches, tasks, and session IDs.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute(args, cwd, signal) {
    const { superagentInstances } = await import("./state.js");
    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();

    const peers = [...superagentInstances.entries()].filter(([id, inst]) => {
      if (currentAgent && inst.agent === currentAgent) {
        return false;
      }
      return true;
    });

    if (peers.length === 0) {
      return "No other active or completed Superagents found in this session.";
    }

    let report = "### Active and Completed Peer Superagents:\n\n";
    for (const [id, inst] of peers) {
      const planFile = inst.historyFilePath ? inst.historyFilePath.replace(/\.json$/, "_implementation_plan.md") : "";
      const taskFile = inst.historyFilePath ? inst.historyFilePath.replace(/\.json$/, "_task.md") : "";

      report += `- **Session ID**: ${id}\n`;
      report += `  - **Role**: ${inst.role}\n`;
      report += `  - **Branch**: ${inst.branch}\n`;
      report += `  - **Status**: ${inst.status}\n`;
      report += `  - **Task**: "${inst.task}"\n`;
      report += `  - **Worktree**: ${inst.worktreePath}\n`;
      if (planFile) {
        report += `  - **Plan File**: ${planFile}\n`;
      }
      if (taskFile) {
        report += `  - **Task File**: ${taskFile}\n`;
      }
      report += "\n";
    }

    return report.trim();
  }
};

export const managePlanTool: Tool = {
  name: "manage_plan",
  description: "Create, update, or sync the implementation plan (_implementation_plan.md) and automatically connect/synchronize it with the task checklist (_task.md).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "sync", "get"],
        description: "The action to perform: 'create' (create/overwrite the plan and sync tasks), 'sync' (parse the existing plan and sync tasks to _task.md), or 'get' (retrieve current plan and task status)",
      },
      planContent: {
        type: "string",
        description: "The markdown content of the implementation plan (required for action 'create')",
      },
      sessionId: {
        type: "string",
        description: "Optional session ID of another agent to manage implementation plan for (multi-agent mode)",
      },
    },
    required: ["action"],
  },
  async execute(args, cwd, signal) {
    const action = args.action as string;
    const planContentInput = args.planContent as string | undefined;
    const sessionId = args.sessionId as string | undefined;

    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();

    let planPath: string;
    let taskPath: string;

    if (sessionId) {
      const { getRootConfigDir } = await import("../config.js");
      const sessionDir = path.join(getRootConfigDir(), "history", "multi", sessionId);
      planPath = path.join(sessionDir, `${sessionId}_implementation_plan.md`);
      taskPath = path.join(sessionDir, `${sessionId}_task.md`);
    } else {
      planPath = currentAgent ? currentAgent.getPlanFilePath() : path.resolve(cwd, "implementation_plan.md");
      taskPath = currentAgent ? currentAgent.getTaskFilePath() : path.resolve(cwd, "task.md");
    }

    const tier = currentAgent ? currentAgent.tier : "superagent";

    // Validation function
    const validatePlan = (content: string): { missing: string[]; content: string } => {
      const hasTitle = /^#\s+.+/m.test(content);
      const hasProposedChanges = /##\s+(proposed\s+changes|rencana\s+perubahan)/i.test(content);
      const hasVerificationPlan = /##\s+(verification\s+plan|rencana\s+verifikasi)/i.test(content);
      const hasAutomatedTests = /###\s+(automated\s+tests|test\s+otomatis)/i.test(content);
      const hasManualVerification = /###\s+(manual\s+verification|verifikasi\s+manual|manual\s+testing)/i.test(content);

      const missing: string[] = [];
      if (!hasTitle) missing.push("Main Title (e.g., '# Goal Description')");
      if (!hasProposedChanges) missing.push("Proposed Changes section ('## Proposed Changes')");
      if (!hasVerificationPlan) missing.push("Verification Plan section ('## Verification Plan')");
      if (!hasAutomatedTests) missing.push("Automated Tests sub-section ('### Automated Tests')");
      if (!hasManualVerification) missing.push("Manual Verification sub-section ('### Manual Verification')");

      if (tier === "master") {
        const hasSuperagentOrDelegate = /superagent|spawning|delegate|worktree/i.test(content);
        if (!hasSuperagentOrDelegate) {
          // Auto-inject delegation context instead of rejecting
          const delegationNote = "\n\n> **Note**: This plan will be executed by spawning Superagents in isolated git worktrees for parallel feature development.";
          content = content + delegationNote;
          console.log("[INFO] Auto-injected delegation context into implementation plan");
        }
      }
      return { missing, content };
    };

    // Task parsing function
    const parseTasksFromContent = (content: string): string[] => {
      const lines = content.split(/\r?\n/);
      const tasks: string[] = [];
      for (const line of lines) {
        const match = line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/);
        if (match) {
          tasks.push(match[2].trim());
        }
      }
      return tasks;
    };

    // Auto-inject missing Master Agent tasks
    const injectMasterAgentTasks = (tasks: string[]): string[] => {
      const combinedText = tasks.join("\n").toLowerCase();
      const hasSpawn = /spawn|invoke|create.*superagent|start.*superagent/i.test(combinedText);
      const hasMonitor = /monitor|await|wait|track|check.*status/i.test(combinedText);
      const hasMerge = /merge|combine|integrate.*superagent/i.test(combinedText);

      const injected: string[] = [...tasks];

      if (!hasSpawn) {
        injected.unshift("Spawn Superagents for parallel task execution");
      }
      if (!hasMonitor) {
        injected.push("Monitor Superagent progress and await completion");
      }
      if (!hasMerge) {
        injected.push("Merge Superagent branches into main codebase");
      }

      return injected;
    };

    // Task merging and writing function
    const syncTasks = async (planText: string): Promise<string> => {
      let newTasks = parseTasksFromContent(planText);
      if (newTasks.length === 0) {
        return "No checklist tasks found in the implementation plan. Tasks should be formatted as '- [ ] task description'.";
      }

      // If Master Agent, auto-inject missing orchestration tasks
      let injectedCount = 0;
      if (tier === "master") {
        const originalCount = newTasks.length;
        newTasks = injectMasterAgentTasks(newTasks);
        injectedCount = newTasks.length - originalCount;
        if (injectedCount > 0) {
          console.log(`[INFO] Auto-injected ${injectedCount} missing Master Agent task(s): spawn, monitor, merge`);
        }
      }

      // Read existing tasks if any
      let existingTasks: { text: string; status: string }[] = [];
      try {
        const existingContent = await fs.readFile(taskPath, "utf-8");
        const lines = existingContent.split(/\r?\n/);
        for (const line of lines) {
          const match = line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/);
          if (match) {
            existingTasks.push({
              status: match[1].toLowerCase(),
              text: match[2].trim(),
            });
          }
        }
      } catch (err: any) {
        if (err.code !== "ENOENT") {
          throw err;
        }
      }

      // Merge: keep status of existing tasks if they match
      const mergedTasks = newTasks.map(t => {
        const existing = existingTasks.find(et => et.text === t);
        return {
          text: t,
          status: existing ? existing.status : " ",
        };
      });

      // Write task file
      const taskLines = mergedTasks.map(t => `- [${t.status}] ${t.text}`).join("\n") + "\n";
      await fs.mkdir(path.dirname(taskPath), { recursive: true });
      await fs.writeFile(taskPath, taskLines, "utf-8");

      if (injectedCount > 0) {
        return `Successfully synchronized ${mergedTasks.length} tasks to ${taskPath}. Auto-injected ${injectedCount} missing Master Agent task(s).`;
      }
      return `Successfully synchronized ${mergedTasks.length} tasks to ${taskPath}.`;
    };

    try {
      if (action === "create") {
        if (!planContentInput || planContentInput.trim() === "") {
          return "Error: The 'planContent' parameter is required for the 'create' action.";
        }

        const { missing: missingHeaders, content: enhancedPlanContent } = validatePlan(planContentInput);
        if (missingHeaders.length > 0) {
          return `Error: The implementation plan is invalid or lacks deep structure. A valid global plan must include:\n${missingHeaders.map(m => `- ${m}`).join("\n")}\n\nPlease rewrite the plan with all required sections and headers included.`;
        }

        // Write implementation plan (may have been enhanced with delegation note)
        await fs.mkdir(path.dirname(planPath), { recursive: true });
        await fs.writeFile(planPath, enhancedPlanContent, "utf-8");

        // Sync tasks
        let syncStatus = "";
        try {
          syncStatus = await syncTasks(enhancedPlanContent);
        } catch (syncErr: any) {
          return `Error: Plan was written to ${planPath}, but task synchronization failed: ${syncErr.message}`;
        }

        // Update planState if currentAgent context is available
        if (currentAgent) {
          if (currentAgent.goalMode) {
            currentAgent.planState = "APPROVED";
          } else if (currentAgent.planState !== "APPROVED") {
            currentAgent.planState = "PLANNING_PENDING";
          }
        }

        return `Successfully created implementation plan at ${planPath}.\n${syncStatus}\nPlan state updated to: ${currentAgent ? currentAgent.planState : "PLANNING_PENDING"}`;
      }

      if (action === "sync") {
        let planContentText = "";
        try {
          planContentText = await fs.readFile(planPath, "utf-8");
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return `Error: Implementation plan file does not exist at: ${planPath}. Use action 'create' first.`;
          }
          throw err;
        }

        const syncStatus = await syncTasks(planContentText);
        return `Successfully synchronized tasks from existing plan.\n${syncStatus}`;
      }

      if (action === "get") {
        let planExists = false;
        let planContentText = "";
        try {
          planContentText = await fs.readFile(planPath, "utf-8");
          planExists = true;
        } catch {}

        let tasksListText = "";
        let tasksCount = 0;
        try {
          const taskContent = await fs.readFile(taskPath, "utf-8");
          const lines = taskContent.split(/\r?\n/);
          const list: string[] = [];
          for (const line of lines) {
            const match = line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/);
            if (match) {
              list.push(`${list.length + 1}. [${match[1]}] ${match[2].trim()}`);
            }
          }
          tasksCount = list.length;
          tasksListText = list.join("\n");
        } catch {}

        let statusText = `### Implementation Plan Status:\n`;
        statusText += `- **Plan File**: ${planPath} (${planExists ? "Exists" : "Does not exist"})\n`;
        statusText += `- **Task File**: ${taskPath} (${tasksCount > 0 ? `${tasksCount} tasks` : "Empty or does not exist"})\n`;
        statusText += `- **Current Agent Plan State**: ${currentAgent ? currentAgent.planState : "N/A"}\n\n`;

        if (planExists) {
          statusText += `#### Implementation Plan (Preview first 500 chars):\n\`\`\`markdown\n${planContentText.substring(0, 500)}${planContentText.length > 500 ? "..." : ""}\n\`\`\`\n\n`;
        }
        if (tasksCount > 0) {
          statusText += `#### Synchronized Tasks:\n${tasksListText}\n`;
        }

        return statusText.trim();
      }

      return `Error: Unknown action "${action}"`;
    } catch (err: any) {
      return `Error managing implementation plan: ${err.message}`;
    }
  }
};

