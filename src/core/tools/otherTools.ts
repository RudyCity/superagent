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
    },
    required: ["question", "options"],
  },
  async execute(args, cwd, signal) {
    const question = args.question as string;
    const rawOptions = (args.options as unknown[]) || [];
    const options: string[] = rawOptions.map(o => String(o));

    const handler = (await import("./state.js")).getActiveQuestionHandler();
    if (!handler) {
      return `Error: ask_question must be executed interactively. No question handler is registered.`;
    }

    try {
      const selected = await handler(question, options);
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
        description: "Simple interval (e.g. '5m' for 5 minutes, '1h' for 1 hour) for recurring checks",
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
      const { searchHistory } = await import("../historySearch.js");
      return await searchHistory(query);
    } catch (err: any) {
      return `Error searching history: ${err.message}`;
    }
  },
};
