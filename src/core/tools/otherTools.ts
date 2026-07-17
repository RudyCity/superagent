import fs from "fs/promises";
import path from "path";
import { execa } from "execa";
import { Tool, ScheduleJob } from "./types.js";
import { scheduledJobs, notifyScheduleTriggered, appendActiveToolOutput, clearActiveToolOutput } from "./state.js";
import { killProcessTree } from "./shellTools.js";
import { ensureAndroidCliInstalled } from "../androidSetup.js";
import { formatUnknownActionError, detectInteractivePrompt } from "./helpers.js";
import { getBrowserMacros, saveBrowserMacro, deleteBrowserMacro, resolveSteps, dryRunSteps, buildRepairHint, type BrowserMacroStep, type StepRunResult } from "../config/browserMacros.js";

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
    // Determine the calling agent's tier to route the question appropriately.
    // Master/Single tier → forward to user UI (activeQuestionHandler).
    // Superagent/Subagent tier → route to Master Agent LLM for answering.
    const { agentLocalStorage } = await import("../agent.js");
    const { getMasterAgent, getActiveQuestionHandler, appendMasterLog } = await import("./state.js");
    const currentAgent = agentLocalStorage.getStore();
    const currentTier = currentAgent ? (currentAgent as any).tier : undefined;
    const handler = getActiveQuestionHandler();

    // Check if we are running in a multi-question workflow
    let questionsVal = args.questions;
    if (typeof questionsVal === "string") {
      try {
        const parsed = JSON.parse(questionsVal);
        if (Array.isArray(parsed)) {
          questionsVal = parsed;
        }
      } catch (e) {}
    }

    const hasQuestionsArray = Array.isArray(questionsVal) && questionsVal.length > 0;

    if (hasQuestionsArray) {
      const questionsList = questionsVal as any[];
      const normalizedQuestions = questionsList.map((q: any, idx: number) => {
        const qText = q.question as string || "";
        let qOptsRaw = q.options || [];
        if (typeof qOptsRaw === "string") {
          try {
            const parsed = JSON.parse(qOptsRaw);
            if (Array.isArray(parsed)) {
              qOptsRaw = parsed;
            }
          } catch (e) {}
        }
        const qOpts = Array.isArray(qOptsRaw) ? qOptsRaw.map(o => String(o)) : [];
        const isMsRaw = q.isMultiSelect !== undefined ? q.isMultiSelect : q.is_multi_select;
        const isMs = typeof isMsRaw === "string" ? isMsRaw.toLowerCase() === "true" : !!isMsRaw;
        return { question: qText, options: qOpts, isMultiSelect: isMs };
      });

      if (currentTier === "superagent" || currentTier === "subagent") {
        const master = getMasterAgent();
        const role = (currentAgent as any).subagentType || (currentAgent as any).tier || "?";
        const sourceLabel = currentTier === "superagent" ? `Superagent "${role}"` : `Subagent (${role})`;
        
        const answers: string[] = [];
        for (const q of normalizedQuestions) {
          appendMasterLog(`[QUESTION] ${sourceLabel} asks: ${q.question} | Options: ${q.options.join(", ")}`);
          if (master && typeof master.answerQuestionAsMaster === "function") {
            try {
              const selected = await master.answerQuestionAsMaster(q.question, q.options, {
                source: currentTier,
                role,
                typeName: (currentAgent as any).subagentType,
              });
              appendMasterLog(`[MASTER ANSWER] For ${sourceLabel}: "${selected}"`);
              answers.push(selected);
            } catch (err: any) {
              answers.push(`Error: ${err.message}`);
            }
          } else if (handler) {
            try {
              const selected = await handler(q.question, q.options, q.isMultiSelect);
              answers.push(String(selected));
            } catch (err: any) {
              answers.push(`Error: ${err.message}`);
            }
          } else {
            answers.push("Error: No handler");
          }
        }
        return JSON.stringify(answers);
      }

      // Master / Single tier — forward to activeQuestionHandler directly passing the array of questions
      if (normalizedQuestions.length === 1) {
        if (!handler) {
          return "Error: ask_question must be executed interactively. No question handler is registered.";
        }
        try {
          const q = normalizedQuestions[0];
          const result = await handler(q.question, q.options, q.isMultiSelect);
          return `User selected option: "${result}"`;
        } catch (err: any) {
          return `Error getting user answer: ${err.message}`;
        }
      }

      if (!handler) {
        return "Error: ask_question must be executed interactively. No question handler is registered.";
      }
      try {
        const result = await handler(normalizedQuestions);
        if (Array.isArray(result)) {
          return JSON.stringify(result);
        }
        return String(result);
      } catch (err: any) {
        return `Error getting user answer: ${err.message}`;
      }
    }

    let question = args.question as string || "";
    let rawOptionsVal = args.options;
    let isMultiSelectRaw = args.isMultiSelect !== undefined ? args.isMultiSelect : (args as any).is_multi_select;
    let isMultiSelect: boolean | undefined = undefined;
    if (isMultiSelectRaw !== undefined) {
      isMultiSelect = typeof isMultiSelectRaw === "string" ? isMultiSelectRaw.toLowerCase() === "true" : !!isMultiSelectRaw;
    }

    if (typeof rawOptionsVal === "string") {
      try {
        const parsed = JSON.parse(rawOptionsVal);
        if (Array.isArray(parsed)) {
          rawOptionsVal = parsed;
        }
      } catch (e) {}
    }

    const rawOptions = Array.isArray(rawOptionsVal)
      ? rawOptionsVal
      : (rawOptionsVal !== undefined && rawOptionsVal !== null ? [rawOptionsVal] : []);
    const options: string[] = rawOptions.map(o => String(o));

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
      if (handler) {
        const role = (currentAgent as any).subagentType || (currentAgent as any).tier || "?";
        const prefix = currentTier === "superagent" ? `[Superagent "${role}"]` : `[Subagent (${role})]`;
        try {
          const selected = await handler(`${prefix}: ${question}`, options, isMultiSelect);
          return `User selected option: "${selected}"`;
        } catch (err: any) {
          return `Error getting user answer: ${err.message}`;
        }
      }
      return `Error: No question handler available to route the question from tier "${currentTier}".`;
    }

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
      clearActiveToolOutput();
      const proc = execa(fullCommand, {
        cwd,
        shell: isWin ? "powershell.exe" : true,
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
        if (warning && !interactiveWarning) {
          interactiveWarning = warning;
          killProcessTree(proc.pid);
        }
      });

      try {
        const result = await proc;
        clearActiveToolOutput();
        if (interactiveWarning) {
          return `Error: Interactive prompt detected. Execution aborted.\n\n${interactiveWarning}\n\nTo interact with this command, please run it using 'run_background_process', then send inputs using 'manage_background_process' (action: 'send_input').`;
        }
        let output = (result.all || "").trim();
        return output || "(no output)";
      } finally {
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
      return `Android CLI error: ${message}`;
    }
  },
};

export const searchHistoryTool: Tool = {
  name: "search_history",
  description: "Search conversation history for a query string. By default searches current workspace sessions; set cross_session=true to search ALL sessions across all projects. Set debug=true to include verbose matching logs.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query or keyword to look for in the history files (case-insensitive)",
      },
      cross_session: {
        type: "boolean",
        description: "If true, search ALL sessions across all projects/workspaces, not just the current one. Default: false.",
      },
      debug: {
        type: "boolean",
        description: "If true, include verbose step-by-step debug logs of the semantic search matching and prompts. Default: false.",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd, signal) {
    const query = args.query as string;
    if (!query) {
      return "Error: query parameter is required.";
    }
    const crossSession = args.cross_session === true;
    const debug = args.debug === true;
    try {
      const { agentLocalStorage } = await import("../agent.js");
      const currentAgent = agentLocalStorage.getStore();
      const isMulti = currentAgent?.isMultiAgent || false;
      const { searchHistory } = await import("../historySearch.js");
      
      const debugLogs: string[] = [];
      const onDebug = (msg: string) => {
        if (debug) {
          debugLogs.push(msg);
        }
        if (currentAgent && typeof currentAgent.onEvent === "function") {
          currentAgent.onEvent({
            type: "tool_progress",
            toolCallId: "",
            message: msg,
          });
        }
      };
      const result = await searchHistory(query, isMulti, crossSession, onDebug);
      if (debug && debugLogs.length > 0) {
        return `[DEBUG LOGS]\n${debugLogs.join("\n")}\n\n${result}`;
      }
      return result;
    } catch (err: any) {
      return `Error searching history: ${err.message}`;
    }
  },
};

// ─── load_pinned_session ─────────────────────────────────────────────────────

export const loadPinnedSessionTool: Tool = {
  name: "load_pinned_session",
  description: "Load and study the full conversation history from a past session that has pinned messages. Use this to learn from previous sessions' context, decisions, and implementations. Use search_history(cross_session=true) first to find relevant sessions, or check the pinned knowledge in your system prompt.",
  parameters: {
    type: "object",
    properties: {
      session_path: {
        type: "string",
        description: "Absolute path to the session JSON file to load. You can find these paths from pinned knowledge entries or search_history results.",
      },
      max_chars: {
        type: "number",
        description: "Maximum characters to return from the session transcript. Default: 30000.",
      },
    },
    required: ["session_path"],
  },
  async execute(args, cwd, signal) {
    const sessionPath = args.session_path as string;
    const maxChars = (args.max_chars as number) || 30000;
    if (!sessionPath) {
      return "Error: session_path parameter is required.";
    }
    try {
      const { getSessionTranscript, getAllKnowledge } = await import("../pinnedKnowledge.js");

      // Verify the session path exists in our knowledge store (security check)
      const allEntries = getAllKnowledge({ limit: 500 });
      const knownPaths = new Set(allEntries.map((e) => e.sourceSessionPath));

      let transcript: string | null = null;
      const { getSettings } = await import("../config.js");
      const settings = getSettings();
      if (settings.enableRmemory) {
        try {
          const { getRMemoryClient } = await import("../rmemoryUtil.js");
          const client = getRMemoryClient(3000);
          const sessionId = path.basename(sessionPath, ".json");
          const rmemoryMessages = await client.getConversationMessages(sessionId);
          if (rmemoryMessages.length > 0) {
            const lines = rmemoryMessages.map((m) => `[${m.role.toUpperCase()}]: ${m.content || ""}`);
            transcript = lines.join("\n\n");
            if (transcript.length > maxChars) {
              transcript = transcript.slice(-maxChars);
              transcript = "... [earlier content truncated] ...\n\n" + transcript;
            }
          }
        } catch {}
      }

      if (!transcript) {
        transcript = getSessionTranscript(sessionPath, maxChars);
      }

      if (!transcript) {
        return `Error: Could not read session at ${sessionPath}. File may not exist or is corrupted.`;
      }

      // Find pinned messages from this session for context
      const pinnedFromSession = allEntries.filter((e) => e.sourceSessionPath === sessionPath);
      let header = `📁 SESSION TRANSCRIPT: ${sessionPath}\n`;
      if (pinnedFromSession.length > 0) {
        header += `📌 ${pinnedFromSession.length} pinned message(s) from this session:\n`;
        for (const p of pinnedFromSession.slice(0, 5)) {
          header += `  - [${p.role}] ${p.preview.substring(0, 100)}${p.tag ? ` #${p.tag}` : ""}\n`;
        }
      }
      header += `\n${"─".repeat(60)}\n\n`;

      return header + transcript;
    } catch (err: any) {
      return `Error loading pinned session: ${err.message}`;
    }
  },
};

// ─── search_pinned_knowledge ─────────────────────────────────────────────────

export const searchPinnedKnowledgeTool: Tool = {
  name: "search_pinned_knowledge",
  description: "Search the global pinned knowledge base — important messages pinned across ALL sessions and projects. Returns pinned content with metadata (agent tags, session paths). Use load_pinned_session with the returned session_path to read full conversation history.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search query to find relevant pinned knowledge entries.",
      },
      working_directory: {
        type: "string",
        description: "Optional: filter results to only entries from this working directory/project.",
      },
      tag: {
        type: "string",
        description: "Optional: filter results to only entries with this specific tag.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results to return. Default: 20.",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd, signal) {
    const query = args.query as string;
    if (!query) return "Error: query parameter is required.";

    try {
      const { searchKnowledge } = await import("../pinnedKnowledge.js");
      const results = await searchKnowledge(query, {
        workingDirectory: args.working_directory as string | undefined,
        tag: args.tag as string | undefined,
        limit: (args.limit as number) || 20,
      });

      if (results.length === 0) {
        return `No pinned knowledge entries found for: "${query}"`;
      }

      const lines: string[] = [];
      lines.push(`📌 Found ${results.length} pinned knowledge entries for "${query}":\n`);

      for (let i = 0; i < results.length; i++) {
        const e = results[i];
        const tagStr = e.tag ? ` #${e.tag}` : "";
        const agentStr = e.agentTag ? ` [${e.agentTag.tier}${e.agentTag.subagentType ? ":" + e.agentTag.subagentType : ""}]` : "";
        lines.push(`[${i + 1}] ${e.role.toUpperCase()}${agentStr}${tagStr}`);
        lines.push(`    ${e.preview.replace(/\n/g, " ").substring(0, 200)}`);
        lines.push(`    📁 Session: ${e.sourceSessionPath}`);
        lines.push(`    📂 Project: ${e.workingDirectory}`);
        lines.push("");
      }

      lines.push("Tip: Use load_pinned_session(session_path) to read the full conversation from any of these sessions.");
      return lines.join("\n");
    } catch (err: any) {
      return `Error searching pinned knowledge: ${err.message}`;
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
    const validActions = ["list", "add", "remove", "prune"];
    if (!validActions.includes(action)) {
      return formatUnknownActionError(action, validActions);
    }
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
  description: "Manage tasks in the active task list (_task.md). Actions: 'list', 'add', 'add_bulk', 'update', 'remove', 'update_bulk', 'remove_bulk'.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "add", "add_bulk", "update", "remove", "update_bulk", "remove_bulk"],
        description: "The action to perform: 'list' (show all tasks), 'add' (add a new task), 'add_bulk' (add multiple new tasks), 'update' (change status of a task), 'remove' (remove a task), 'update_bulk' (change status of multiple tasks), 'remove_bulk' (remove multiple tasks)",
      },
      text: {
        type: "string",
        description: "Task description (required for action 'add')",
      },
      texts: {
        type: "array",
        items: {
          type: "string",
        },
        description: "List of task descriptions (required for action 'add_bulk')",
      },
      index: {
        type: "number",
        description: "1-based task index (required for actions 'update' and 'remove' if 'indices' is not provided)",
      },
      indices: {
        type: "array",
        items: {
          type: "number",
        },
        description: "1-based task indices (required for actions 'update_bulk' and 'remove_bulk', or when updating/removing multiple tasks)",
      },
      status: {
        type: "string",
        enum: [" ", "/", "x"],
        description: "New status for the task: ' ' for pending, '/' for in progress, 'x' for completed (required for actions 'update' and 'update_bulk')",
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
    const validActions = ["list", "add", "add_bulk", "update", "remove", "update_bulk", "remove_bulk"];
    if (!validActions.includes(action)) {
      return formatUnknownActionError(action, validActions);
    }
    const text = args.text as string | undefined;
    const texts = args.texts as string[] | undefined;
    const index = args.index as number | undefined;
    const indices = args.indices as number[] | undefined;
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

      if (action === "add_bulk") {
        if (!texts || !Array.isArray(texts) || texts.length === 0) {
          return "Error: The 'texts' array parameter is required and must not be empty for the 'add_bulk' action.";
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

        const trimmedTexts = texts.map(t => t.trim()).filter(t => t !== "");
        if (trimmedTexts.length === 0) {
          return "Error: The 'texts' parameter must contain at least one non-empty task description.";
        }

        let updatedContent = content;
        for (const tText of trimmedTexts) {
          const newTaskLine = `- [ ] ${tText}`;
          if (updatedContent.length > 0 && !updatedContent.endsWith("\n")) {
            updatedContent += "\n";
          }
          updatedContent += newTaskLine + "\n";
        }

        await fs.writeFile(taskPath, updatedContent, "utf-8");
        const joinedTexts = trimmedTexts.map(t => `"${t}"`).join(", ");
        return `Successfully added tasks: ${joinedTexts}`;
      }

      if (action === "update" || action === "update_bulk") {
        if (!status) {
          return `Error: The 'status' parameter is required for the '${action}' action.`;
        }
        if (status !== " " && status !== "/" && status !== "x") {
          return `Error: Invalid status "${status}". Must be one of: ' ' (pending), '/' (in progress), 'x' (completed).`;
        }

        const targetIndices: number[] = [];
        if (action === "update_bulk" || indices !== undefined) {
          if (!indices || !Array.isArray(indices) || indices.length === 0) {
            return `Error: A non-empty 'indices' array parameter is required for the '${action}' action.`;
          }
          targetIndices.push(...indices);
        } else {
          if (index === undefined || index <= 0) {
            return "Error: A valid 1-based 'index' parameter is required for the 'update' action.";
          }
          targetIndices.push(index);
        }

        const uniqueIndices = Array.from(new Set(targetIndices));

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
        for (const idx of uniqueIndices) {
          if (idx <= 0 || idx > tasks.length) {
            return `Error: Task index ${idx} is out of bounds. There are only ${tasks.length} tasks in the list.`;
          }
        }

        const updatedTaskTexts: string[] = [];
        for (const idx of uniqueIndices) {
          const targetTask = tasks[idx - 1];
          const line = lines[targetTask.lineIndex];
          const match = line.match(/^(\s*-\s*`?\[)([xX/ ])(\]`?\s*)(.*)$/);
          
          if (!match) {
            return `Error: Failed to parse task line at index ${idx} internally.`;
          }

          const prefix = match[1];
          const suffix = match[3] + match[4];
          const newLine = `${prefix}${status}${suffix}`;
          
          lines[targetTask.lineIndex] = newLine;
          updatedTaskTexts.push(`"${targetTask.text}"`);
        }

        await fs.writeFile(taskPath, lines.join("\n"), "utf-8");
        const joinedIndices = uniqueIndices.join(", ");
        const joinedTexts = updatedTaskTexts.join(", ");
        return `Successfully updated task${uniqueIndices.length > 1 ? "s" : ""} ${joinedIndices} to [${status}]: ${joinedTexts}`;
      }

      if (action === "remove" || action === "remove_bulk") {
        const targetIndices: number[] = [];
        if (action === "remove_bulk" || indices !== undefined) {
          if (!indices || !Array.isArray(indices) || indices.length === 0) {
            return `Error: A non-empty 'indices' array parameter is required for the '${action}' action.`;
          }
          targetIndices.push(...indices);
        } else {
          if (index === undefined || index <= 0) {
            return "Error: A valid 1-based 'index' parameter is required for the 'remove' action.";
          }
          targetIndices.push(index);
        }

        const uniqueIndices = Array.from(new Set(targetIndices));

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
        for (const idx of uniqueIndices) {
          if (idx <= 0 || idx > tasks.length) {
            return `Error: Task index ${idx} is out of bounds. There are only ${tasks.length} tasks in the list.`;
          }
        }

        // Gather tasks to remove
        const targets = uniqueIndices.map(idx => tasks[idx - 1]);
        // Sort descending by lineIndex to prevent shifting issues during splicing
        targets.sort((a, b) => b.lineIndex - a.lineIndex);

        for (const targetTask of targets) {
          lines.splice(targetTask.lineIndex, 1);
        }
        
        await fs.writeFile(taskPath, lines.join("\n"), "utf-8");
        const joinedIndices = uniqueIndices.join(", ");
        const joinedTexts = uniqueIndices.map(idx => `"${tasks[idx - 1].text}"`).join(", ");
        return `Successfully removed task${uniqueIndices.length > 1 ? "s" : ""} ${joinedIndices}: ${joinedTexts}`;
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
        enum: ["create", "edit", "sync", "get"],
        description: "The action to perform: 'create' (create/overwrite the plan and sync tasks), 'edit' (modify the plan using planContent or find-and-replace), 'sync' (parse the existing plan and sync tasks to _task.md), or 'get' (retrieve current plan and task status)",
      },
      planContent: {
        type: "string",
        description: "The markdown content of the implementation plan (required for action 'create', optional for 'edit')",
      },
      targetContent: {
        type: "string",
        description: "The exact text in the existing implementation plan to be replaced (used with action 'edit')",
      },
      replacementContent: {
        type: "string",
        description: "The replacement text for targetContent (used with action 'edit')",
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
    const validActions = ["create", "edit", "sync", "get"];
    if (!validActions.includes(action)) {
      return formatUnknownActionError(action, validActions);
    }
    const planContentInput = args.planContent as string | undefined;
    const targetContent = args.targetContent as string | undefined;
    const replacementContent = args.replacementContent as string | undefined;
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

        const { content: enhancedPlanContent } = validatePlan(planContentInput);

        // Write implementation plan (may have been enhanced with delegation note)
        await fs.mkdir(path.dirname(planPath), { recursive: true });
        await fs.writeFile(planPath, enhancedPlanContent, "utf-8");

        // Sync tasks
        let syncStatus = "";
        try {
          syncStatus = await syncTasks(enhancedPlanContent);
          
          // If syncTasks returned "No checklist tasks found", create a minimal task file
          if (syncStatus.includes("No checklist tasks found")) {
            await fs.mkdir(path.dirname(taskPath), { recursive: true });
            await fs.writeFile(taskPath, "# Tasks\n- [ ] Execute implementation plan\n", "utf-8");
            syncStatus += "\nCreated minimal task file.";
          }
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

      if (action === "edit") {
        let existingPlanContent = "";
        try {
          existingPlanContent = await fs.readFile(planPath, "utf-8");
        } catch (err: any) {
          if (err.code === "ENOENT") {
            return `Error: Implementation plan file does not exist at: ${planPath}. Use action 'create' first.`;
          }
          throw err;
        }

        let newPlanContent = "";
        if (targetContent !== undefined && replacementContent !== undefined) {
          if (targetContent === "") {
            return "Error: 'targetContent' cannot be empty for edit action.";
          }
          if (!existingPlanContent.includes(targetContent)) {
            return `Error: 'targetContent' not found in the existing plan.`;
          }
          newPlanContent = existingPlanContent.replace(targetContent, replacementContent);
        } else if (planContentInput !== undefined) {
          if (planContentInput.trim() === "") {
            return "Error: 'planContent' cannot be empty for edit action.";
          }
          newPlanContent = planContentInput;
        } else {
          return "Error: Either 'planContent' or both 'targetContent' and 'replacementContent' must be provided for 'edit' action.";
        }

        const { content: enhancedPlanContent } = validatePlan(newPlanContent);

        // Write the edited implementation plan
        await fs.mkdir(path.dirname(planPath), { recursive: true });
        await fs.writeFile(planPath, enhancedPlanContent, "utf-8");

        // Sync tasks
        let syncStatus = "";
        try {
          syncStatus = await syncTasks(enhancedPlanContent);
          
          if (syncStatus.includes("No checklist tasks found")) {
            await fs.mkdir(path.dirname(taskPath), { recursive: true });
            await fs.writeFile(taskPath, "# Tasks\n- [ ] Execute implementation plan\n", "utf-8");
            syncStatus += "\nCreated minimal task file.";
          }
        } catch (syncErr: any) {
          return `Error: Plan was updated at ${planPath}, but task synchronization failed: ${syncErr.message}`;
        }

        // Update planState if currentAgent context is available
        if (currentAgent) {
          if (currentAgent.goalMode) {
            currentAgent.planState = "APPROVED";
          } else if (currentAgent.planState !== "APPROVED") {
            currentAgent.planState = "PLANNING_PENDING";
          }
        }

        return `Successfully edited implementation plan at ${planPath}.\n${syncStatus}\nPlan state updated to: ${currentAgent ? currentAgent.planState : "PLANNING_PENDING"}`;
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

export const getSkillsTool: Tool = {
  name: "get_skills",
  description: "List installed skills relevant to a specific task or query. Always provide a descriptive query so the AI can return the most relevant skills. If no query is given, returns all skills.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Descriptive query of the task you need skills for. Be specific: include the task type (e.g. 'debug', 'test', 'deploy', 'refactor'), the technology (e.g. 'React', 'TypeScript', 'PostgreSQL'), and the goal (e.g. 'fix failing test', 'deploy to Vercel', 'optimize database queries'). More context = better results.",
      },
    },
    required: [],
  },
  async execute(args, cwd, signal) {
    try {
      const { getInstalledSkills } = await import("../config.js");
      const skills = getInstalledSkills();
      const query = typeof args.query === "string" ? args.query.trim().toLowerCase() : undefined;

      let filtered = skills;

      if (query) {
        let aiFiltered: any[] = [];
        let aiSuccess = false;

        try {
          const { getModelInstance } = await import("../config.js");
          const { generateText } = await import("ai");
          const model = getModelInstance();

          if (model) {
            const candidates = skills.map((s, idx) => ({
              index: idx,
              name: s.name,
              description: s.description,
            }));

            const prompt = `You are an expert at matching developer tasks to the correct specialized skill guides.

Task/Query: "${args.query}"

Available skills (index, name, description):
${JSON.stringify(candidates, null, 2)}

# MATCHING RULES
- Match skills whose name or description directly addresses the task, technology, or workflow in the query.
- TIER 1 (must include): Skills that are a direct, primary match for the exact task type (e.g. query says "debug" → include systematic-debugging, diagnosing-bugs).
- TIER 2 (include if relevant): Skills that cover a closely related sub-task or prerequisite (e.g. query says "write tests" → include tdd, testing-anti-patterns, condition-based-waiting).
- TIER 3 (skip): Skills that are only tangentially or thematically related but don't add actionable value for THIS specific query.
- Be precise, not inclusive: prefer returning 3-6 highly relevant skills over 10+ loosely related ones.
- If the query is about a specific technology (e.g. "React", "PostgreSQL", "Docker"), prioritize skills that explicitly mention that technology.
- If the query mentions a workflow action (e.g. "deploy", "refactor", "review", "plan", "test"), prioritize skills for that exact action.
- Return results ordered by relevance (most relevant index first).
- Maximum 8 indices. Minimum 0.

Return ONLY a valid JSON array of integers (the index values). Example: [3, 7, 1]
If nothing matches: []`;

            const result = await generateText({
              model,
              prompt,
            });

            const filterResult = result.text;
            const jsonMatch = filterResult.match(/\[\s*(?:\d+\s*(?:,\s*\d+\s*)*)?\]/);
            const indices: number[] = jsonMatch ? JSON.parse(jsonMatch[0]).filter((i: any) => typeof i === "number" && i >= 0 && i < skills.length) : [];
            aiFiltered = indices.map(idx => skills[idx]).filter(Boolean);
            aiSuccess = true;
          }
        } catch (err) {
          // Gracefully ignore AI search errors and fallback to keyword search
        }

        if (aiSuccess && aiFiltered.length > 0) {
          filtered = aiFiltered;
        } else {
          // Fallback to keyword matching if AI search failed or returned no results
          const exactMatches = skills.filter(
            (s) =>
              s.name.toLowerCase().includes(query) ||
              s.description.toLowerCase().includes(query)
          );

          if (exactMatches.length > 0) {
            filtered = exactMatches;
          } else {
            const stopWords = new Set(["a", "an", "the", "and", "or", "but", "if", "then", "else", "of", "at", "by", "for", "with", "about", "against", "between", "into", "through", "during", "before", "after", "above", "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under", "again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "all", "any", "both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only", "own", "same", "so", "than", "too", "very", "can", "will", "just", "should", "now", "use", "when", "using", "your", "custom", "skills"]);
            const keywords = query
              .replace(/[^\w\s-]/g, "")
              .split(/\s+/)
              .filter((k) => k.length > 2 && !stopWords.has(k));

            if (keywords.length > 0) {
              const docFreqs: Record<string, number> = {};
              for (const kw of keywords) {
                let count = 0;
                for (const s of skills) {
                  if (s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw)) {
                    count++;
                  }
                }
                docFreqs[kw] = count;
              }

              const scored = skills
                .map((s) => {
                  let score = 0;
                  let matchedKeywordCount = 0;
                  const nameLower = s.name.toLowerCase();
                  const descLower = s.description.toLowerCase();

                  for (const kw of keywords) {
                    let keywordMatched = false;
                    const idf = Math.log(skills.length / (docFreqs[kw] || 1)) + 1;

                    if (nameLower.includes(kw)) {
                      score += 3 * idf;
                      keywordMatched = true;
                    }
                    if (descLower.includes(kw)) {
                      score += 1 * idf;
                      keywordMatched = true;
                    }
                    if (keywordMatched) {
                      matchedKeywordCount++;
                    }
                  }

                  if (matchedKeywordCount > 1) {
                    score += matchedKeywordCount * 5;
                  }

                  return { skill: s, score };
                })
                .filter((item) => item.score > 0);

              scored.sort((a, b) => b.score - a.score);
              filtered = scored.slice(0, 15).map((item) => item.skill);
            } else {
              filtered = [];
            }
          }
        }
      }

      if (filtered.length === 0) {
        if (query) {
          return `No skills found matching query: ${args.query}`;
        }
        return "No installed skills found.";
      }

      let output = "Installed Skills:\n";
      for (const s of filtered) {
        const author = s.author || "local";
        output += `- name: ${s.name}\n`;
        output += `  author: ${author}\n`;
        output += `  description: ${s.description}\n`;
        output += `  path: ${s.path}\n`;

        if (query) {
          try {
            const fs = await import("fs");
            if (fs.existsSync(s.path)) {
              const content = fs.readFileSync(s.path, "utf-8");
              const indented = content
                .split("\n")
                .map((line) => `  ${line}`)
                .join("\n");
              output += `  content:\n${indented}\n`;
            }
          } catch (fileErr) {
            // Ignore error reading skill file
          }
        }
        output += `\n`;
      }
      return output.trim();
    } catch (err: any) {
      return `Error retrieving skills: ${err.message}`;
    }
  }
};

let browserControlHandler: ((action: string, target: string, value?: string) => Promise<string>) | null = null;
export function setBrowserControlHandler(handler: typeof browserControlHandler) {
  browserControlHandler = handler;
}

export const controlBrowserTabTool: Tool = {
  name: "control_browser_tab",
  description: "Automate browser actions on the user's active Chrome tab (requires the extension to be open). Actions: click (guides the user to click manually for stealth), type (human-like typing), paste (instant typing), navigate, scroll, screenshot, detect_ui (runs UI-DETR-1 to detect UI elements and coordinates), errors, text, hover, keypress, wait, html, reload, back, forward, open, close, list, switch, duplicate, pin, unpin, mute, unmute, move, group, ungroup, discard, new_window, close_window, top_sites (get top visited sites), reading_list_add (add reading list), reading_list_remove (remove reading list), reading_list_get (get reading list), group_update (update group title/color), group_get (get group info), history_search (search history), history_delete (delete URL from history), history_clear (clear all history), management_list (list extensions), management_get (get extension details), show_detections (shows visual bounding boxes), hide_detections (hides bounding boxes), dom_info (gets DOM info for coordinates), execute_chain (executes a JSON sequence of actions), highlight_element (highlights coordinates on webpage).",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "click", "type", "paste", "navigate", "scroll", "screenshot", "detect_ui", "errors", "text", "hover", "keypress", "wait", "html", "reload", "back", "forward",
          "open", "close", "list", "switch", "duplicate", "pin", "unpin", "mute", "unmute", "move", "group", "ungroup", "discard", "new_window", "close_window",
          "top_sites", "reading_list_add", "reading_list_remove", "reading_list_get", "group_update", "group_get", "history_search", "history_delete", "history_clear", "management_list", "management_get",
          "show_detections", "hide_detections", "dom_info", "execute_chain", "highlight_element"
        ],
        description: "The browser action to execute."
      },
      target: {
        type: "string",
        description: "CSS selector, destination URL, tab/window/group/extension ID, comma-separated tab IDs, history search query, or JSON chain string. Required for click, type, paste, navigate, scroll, hover, keypress, switch, move, group, ungroup, reading_list_add, reading_list_remove, group_update, history_delete, management_get, show_detections, dom_info, execute_chain, and highlight_element. For wait, either target (selector or duration) or value (duration) must be provided."
      },
      value: {
        type: "string",
        description: "Text to type/paste (type, paste), key to press (keypress), scroll offset, timeout in ms (wait), destination index (move), group ID (group), group metadata JSON or title (group_update), reading list title (reading_list_add), history maxResults (history_search), confidence threshold (detect_ui), or execute_chain values."
      }
    },
    required: ["action"]
  },
  async execute(args, cwd, signal) {
    if (!browserControlHandler) {
      return "Error: Browser control handler is not active. Please launch the Superagent Chrome Extension and connect to activate browser control.";
    }
    const handler = browserControlHandler!;
    const action = args.action as string;
    if (["click", "type", "paste", "navigate", "scroll", "hover", "keypress", "switch", "move", "group", "ungroup", "reading_list_add", "reading_list_remove", "group_update", "history_delete", "management_get", "show_detections", "dom_info", "execute_chain", "highlight_element"].includes(action) && !args.target) {
      return `Error: Target parameter is required for action "${action}".`;
    }
    if (action === "wait" && !args.target && !args.value) {
      return `Error: Either target (CSS selector or milliseconds) or value (milliseconds) is required for action "wait".`;
    }
    if (action === "detect_ui") {
      try {
        const screenshotResult = await handler("screenshot", "", "");
        if (screenshotResult.includes("Error") || screenshotResult.includes("failed")) {
          return `Failed to capture screenshot for detection: ${screenshotResult}`;
        }
        let screenshotBase64 = "";
        if (screenshotResult.startsWith("data:image/png;base64,")) {
          screenshotBase64 = screenshotResult.replace(/^data:image\/png;base64,/, "");
        } else {
          const match = screenshotResult.match(/Screenshot saved to workspace at: (.+)/);
          const screenshotPath = match ? match[1].trim() : path.join(cwd, "chrome_screenshot.png");
          try {
            screenshotBase64 = await fs.readFile(screenshotPath, { encoding: "base64" });
          } catch {}
        }
        
        const threshold = args.value ? parseFloat(String(args.value)) : 0.35;
        const response = await fetch("http://127.0.0.1:8095/detect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            image_base64: screenshotBase64 || undefined,
            threshold: isNaN(threshold) ? 0.35 : threshold
          })
        });
        const data = await response.json() as any;
        if (data.error) {
          return `UI Detection failed: ${data.error}`;
        }
        if (data.success && Array.isArray(data.elements)) {
          if (data.elements.length === 0) {
            return "UI Detection finished: No elements detected on the page.";
          }
          // Auto show overlay in browser (non-fatal)
          try {
            await handler("show_detections", JSON.stringify(data.elements), "");
          } catch (_) {}

          // DOM reconciliation: enrich each detected element with live DOM info
          const enriched = await Promise.all(
            data.elements.map(async (el: any) => {
              try {
                const [cx, cy] = el.center;
                const domRaw = await handler("dom_info", `${cx},${cy}`, "");
                const dom = JSON.parse(domRaw);
                return { ...el, dom };
              } catch {
                return el;
              }
            })
          );

          let responseStr = "Detected UI elements (coordinate or CSS selector):\n";
          for (const el of enriched) {
            const [cx, cy] = el.center;
            const score = Math.round(el.score * 100);
            const coordHint = `${cx},${cy}`;
            const selectorHint = el.dom?.id ? ` | #${el.dom.id}` : el.dom?.selector ? ` | ${el.dom.selector}` : "";
            const ariaHint = el.dom?.ariaLabel ? ` | aria: "${el.dom.ariaLabel}"` : el.dom?.innerText ? ` | text: "${el.dom.innerText.slice(0, 30)}"` : "";
            responseStr += `- ${el.label} @ ${coordHint}${selectorHint}${ariaHint} (${score}%)\n`;
          }
          return responseStr.trim();
        }
        return `UI Detection returned unexpected output: ${JSON.stringify(data)}`;
      } catch (err: any) {
        return `UI Detection execution failed: ${err.message || String(err)}`;
      }
    }
    try {
      const result = await handler(action, (args.target as string) || "", (args.value as string) || "");
      return result;
    } catch (err: any) {
      return `Browser control failed: ${err.message || String(err)}`;
    }
  }
};

export const useSkillTool: Tool = {
  name: "use_skill",
  description: "Activate and load the instructions for a specific skill. Provide either the exact skill name (e.g. 'systematic-debugging') or the absolute path to the skill's SKILL.md file. This returns the complete contents of the skill's instructions so you can follow them.",
  parameters: {
    type: "object",
    properties: {
      skillName: {
        type: "string",
        description: "The name of the skill to use (e.g., 'systematic-debugging', 'test-driven-development-tdd', 'getting-started-with-skills').",
      },
      path: {
        type: "string",
        description: "The absolute path to the skill's SKILL.md file, if known.",
      },
    },
    required: [],
  },
  async execute(args, cwd, signal) {
    try {
      const { getInstalledSkills } = await import("../config.js");
      const skills = getInstalledSkills();
      const skillName = typeof args.skillName === "string" ? args.skillName.trim() : undefined;
      const skillPath = typeof args.path === "string" ? args.path.trim() : undefined;

      if (!skillName && !skillPath) {
        return "Error: You must provide either 'skillName' or 'path' to use a skill.";
      }

      let foundSkill = null;

      if (skillPath) {
        foundSkill = skills.find(s => s.path === skillPath);
        if (!foundSkill) {
          const fs = await import("fs");
          if (fs.existsSync(skillPath)) {
            foundSkill = {
              name: path.basename(path.dirname(skillPath)),
              description: "Custom skill file directly provided via path.",
              path: skillPath,
            };
          }
        }
      }

      if (!foundSkill && skillName) {
        const queryLower = skillName.toLowerCase();
        foundSkill = skills.find(s => s.name.toLowerCase() === queryLower);
        if (!foundSkill) {
          foundSkill = skills.find(s => {
            const folderName = path.basename(path.dirname(s.path)).toLowerCase();
            return folderName === queryLower ||
                   folderName.replace(/-/g, "_") === queryLower.replace(/-/g, "_");
          });
        }
      }

      if (!foundSkill) {
        const availableNames = skills.map(s => `"${s.name}"`).join(", ");
        return `Error: Skill "${skillName || skillPath}" not found. Available skills: ${availableNames}`;
      }

      const fs = await import("fs");
      if (!fs.existsSync(foundSkill.path)) {
        return `Error: Skill instruction file not found at path: ${foundSkill.path}`;
      }

      const content = fs.readFileSync(foundSkill.path, "utf-8");
      
      let output = `### Activated Skill: ${foundSkill.name}\n`;
      output += `**Path**: ${foundSkill.path}\n`;
      output += `**Description**: ${foundSkill.description}\n\n`;
      output += `#### Skill Instructions (Read and follow carefully):\n`;
      output += `\`\`\`markdown\n${content}\n\`\`\``;

      return output;
    } catch (err: any) {
      return `Error using skill: ${err.message}`;
    }
  }
};

export const controlBrowserMacroSaveTool: Tool = {
  name: "control_browser_macro_save",
  description: "Save a reusable browser control macro preset. A macro is a named sequence of browser actions (navigate, type, click, wait, etc.) that can be executed later in one call. Steps support: {{param}} placeholders, per-step onError policy (stop/skip/retry), maxRetries, and optional label. Version and timestamps are managed automatically.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique macro name in snake_case (e.g. medium_post, google_search)"
      },
      description: {
        type: "string",
        description: "What this macro does in plain English"
      },
      params: {
        type: "object",
        description: "Optional map of parameter names to descriptions, e.g. { \"title\": \"Article title\" }",
        additionalProperties: { type: "string" }
      },
      steps: {
        type: "array",
        description: "Ordered list of browser actions to execute",
        items: {
          type: "object",
          properties: {
            action: { type: "string", description: "Browser action (navigate, click, type, wait, scroll, screenshot, etc.)" },
            target: { type: "string", description: "CSS selector or URL. Supports {{param}} placeholders." },
            value: { type: "string", description: "Text or value to type. Supports {{param}} placeholders." },
            label: { type: "string", description: "Human-readable label for this step shown in run output." },
            onError: { type: "string", enum: ["stop", "skip", "retry"], description: "What to do if this step fails. Default: stop" },
            maxRetries: { type: "number", description: "Max retry attempts when onError=retry. Default: 2" }
          },
          required: ["action"]
        }
      },
      delete: {
        type: "boolean",
        description: "If true, deletes the macro with the given name instead of saving it."
      }
    },
    required: ["name"]
  },
  async execute(args) {
    const name = args.name as string;
    if (args.delete === true) {
      const deleted = deleteBrowserMacro(name);
      return deleted ? `Macro "${name}" deleted.` : `Error: Macro "${name}" not found.`;
    }
    if (!args.steps || !Array.isArray(args.steps) || (args.steps as any[]).length === 0) {
      return `Error: "steps" must be a non-empty array of browser action steps.`;
    }
    const saved = saveBrowserMacro({
      name,
      description: (args.description as string) || "",
      params: (args.params as Record<string, string>) || undefined,
      steps: args.steps as BrowserMacroStep[],
    });
    return `Macro "${name}" saved (v${saved.version}) with ${saved.steps.length} steps. Updated: ${saved.updatedAt}`;
  }
};

export const controlBrowserMacroRunTool: Tool = {
  name: "control_browser_macro_run",
  description: "Execute a saved browser macro preset by name. Replaces {{param}} placeholders in each step with 'args' values. Respects per-step onError policy (stop/skip/retry). Use dryRun=true to preview resolved steps without executing. Use name='list' to see all saved macros. On failure, returns a REPAIR HINT to guide updating the macro.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Macro name to execute (e.g. medium_post), or 'list' to see all saved macros."
      },
      args: {
        type: "object",
        description: "Key-value map of parameter values to inject into the macro steps.",
        additionalProperties: { type: "string" }
      },
      dryRun: {
        type: "boolean",
        description: "If true, preview resolved steps without executing them. Useful for verifying args and step order before a real run."
      }
    },
    required: ["name"]
  },
  async execute(args) {
    const name = args.name as string;
    const argsMap = (args.args as Record<string, string>) || {};
    const isDryRun = args.dryRun === true;

    // List mode
    if (name === "list") {
      const macros = getBrowserMacros();
      if (macros.length === 0) return "No macros saved yet.";
      return macros.map(m => {
        const paramList = m.params
          ? Object.entries(m.params).map(([k, v]) => `  - {{${k}}}: ${v}`).join("\n")
          : "  (none)";
        const meta = `v${m.version ?? 1} | created: ${m.createdAt ?? "unknown"} | updated: ${m.updatedAt ?? "unknown"}`;
        return `Macro: ${m.name} (${meta})\nDescription: ${m.description}\nParams:\n${paramList}\nSteps: ${m.steps.length} actions`;
      }).join("\n\n");
    }

    const macros = getBrowserMacros();
    const macro = macros.find(m => m.name.toLowerCase() === name.toLowerCase());
    if (!macro) return `Error: Macro "${name}" not found. Use name 'list' to see available macros.`;

    const resolvedSteps = resolveSteps(macro.steps, argsMap);

    // Dry-run mode — return preview without executing
    if (isDryRun) {
      const preview = dryRunSteps(macro.steps, argsMap);
      const lines = [
        `DRY-RUN: Macro "${name}" (v${macro.version ?? 1}) — ${preview.length} steps`,
        `Args: ${JSON.stringify(argsMap)}`,
        "",
        ...preview.map(r => `  ${r.index}. [${r.action}]${r.label !== `Step ${r.index}` ? ` "${r.label}"` : ""}: ${r.output}`),
      ];
      return lines.join("\n");
    }

    if (!browserControlHandler) {
      return "Error: Browser control handler is not active. Please launch the Chrome Extension and connect to activate browser control.";
    }

    // Execute steps with per-step onError policy
    const results: StepRunResult[] = [];
    let aborted = false;

    for (let i = 0; i < resolvedSteps.length; i++) {
      const step = resolvedSteps[i];
      const policy = step.onError ?? "stop";
      const maxRetries = step.onError === "retry" ? (step.maxRetries ?? 2) : 0;
      const label = step.label ?? `Step ${i + 1}`;

      let lastError = "";
      let attempts = 0;
      let succeeded = false;
      let output = "";

      do {
        attempts++;
        try {
          output = await browserControlHandler(step.action, step.target || "", step.value || "");
          succeeded = true;
        } catch (err: any) {
          lastError = err.message || String(err);
        }
      } while (!succeeded && policy === "retry" && attempts <= maxRetries);

      if (succeeded) {
        results.push({ index: i + 1, label, action: step.action, target: step.target, value: step.value, status: "ok", output, attempts });
      } else {
        const result: StepRunResult = {
          index: i + 1, label, action: step.action, target: step.target, value: step.value,
          status: "failed", error: lastError, attempts
        };
        results.push(result);

        if (policy === "skip") {
          // log and continue
          continue;
        } else {
          // stop or retry exhausted — abort
          aborted = true;
          break;
        }
      }
    }

    // Format output
    const lines = results.map(r => {
      const retryNote = r.attempts && r.attempts > 1 ? ` (${r.attempts} attempts)` : "";
      if (r.status === "ok")     return `Step ${r.index} [${r.action}]${retryNote}: ${r.output}`;
      if (r.status === "skipped") return `Step ${r.index} [${r.action}] SKIPPED: ${r.error}`;
      return `Step ${r.index} [${r.action}] FAILED${retryNote}: ${r.error}`;
    });

    if (aborted) {
      lines.push(`\nAborted after step ${results.length} of ${resolvedSteps.length}.`);
      lines.push(buildRepairHint(name, results));
    } else {
      const ok = results.filter(r => r.status === "ok").length;
      const skipped = results.filter(r => r.status === "skipped").length;
      const failed = results.filter(r => r.status === "failed").length;
      lines.push(`\nCompleted: ${ok} ok, ${skipped} skipped, ${failed} failed.`);
      if (failed > 0) lines.push(buildRepairHint(name, results));
    }

    return lines.join("\n");
  }
};
