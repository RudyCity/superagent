import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execa } from "execa";
import { Tool } from "./types.js";
import { appendActiveToolOutput, clearActiveToolOutput } from "./state.js";
import { killProcessTree } from "./shellTools.js";
import { ensureAndroidCliInstalled } from "../androidSetup.js";
import { formatUnknownActionError, detectInteractivePrompt } from "./helpers.js";

export { askQuestionTool, scheduleTool } from "./interactionTools.js";


async function syncChildTasksToMaster(childTaskPath: string, currentAgent: any) {
  try {
    const { getMasterAgent, notifyTasksChanged } = await import("./state.js");
    const master = getMasterAgent();
    if (!master || master === currentAgent) {
      return;
    }
    const masterTaskPath = master.getTaskFilePath ? master.getTaskFilePath() : null;
    if (!masterTaskPath || masterTaskPath === childTaskPath) {
      return;
    }

    // Read child tasks
    let childContent = "";
    try {
      childContent = await fs.readFile(childTaskPath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    const { parseChecklistTasks } = await import("../taskChecklist.js");
    const childTasks = parseChecklistTasks(childContent);

    // Read master tasks
    let masterContent = "";
    try {
      masterContent = await fs.readFile(masterTaskPath, "utf-8");
    } catch (err: any) {
      if (err.code === "ENOENT") return;
      throw err;
    }

    const masterLines = masterContent.split(/\r?\n/);
    let masterModified = false;

    // Normalization helper
    const normalize = (text: string) => {
      return text
        .replace(/^\[agent:\s*[^\]]+\]\s*/i, "")
        .toLowerCase()
        .replace(/[`'"]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    };

    // Map of normalized child task text -> status
    const childMap = new Map<string, string>();
    for (const t of childTasks) {
      childMap.set(normalize(t.text), t.status);
    }

    // Update master tasks in place (preserving lines formatting)
    for (let i = 0; i < masterLines.length; i++) {
      const line = masterLines[i];
      const match =
        line.match(/^(\s*-\s*`?\[)([xX/ ])(\]`?\s*)(.*)$/) ||
        line.match(/^(\s*-\s*\[)([xX/ ])(\]\s*)(.*)$/);
      if (match) {
        const prefix = match[1];
        const oldStatus = match[2];
        const suffix = match[3] + match[4];
        const taskText = match[4].trim();

        const normalizedText = normalize(taskText);
        const newStatus = childMap.get(normalizedText);

        if (newStatus !== undefined && newStatus !== oldStatus.toLowerCase()) {
          masterLines[i] = `${prefix}${newStatus}${suffix}`;
          masterModified = true;
        }
      }
    }

    // Append child tasks that don't exist in master
    const masterNormalizedSet = new Set(
      masterLines
        .map((line) => {
          const match =
            line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/) ||
            line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
          return match ? normalize(match[2].trim()) : "";
        })
        .filter(Boolean)
    );

    const toAppend: string[] = [];
    for (const t of childTasks) {
      if (!masterNormalizedSet.has(normalize(t.text))) {
        const role = currentAgent.role ? `[agent: ${currentAgent.role}] ` : "";
        toAppend.push(`- [${t.status}] ${role}${t.text}`);
        masterModified = true;
      }
    }

    if (toAppend.length > 0) {
      let lastItemIdx = -1;
      for (let i = masterLines.length - 1; i >= 0; i--) {
        if (/^\s*-\s*\[.?\]/.test(masterLines[i])) {
          lastItemIdx = i;
          break;
        }
      }
      if (lastItemIdx >= 0) {
        masterLines.splice(lastItemIdx + 1, 0, ...toAppend);
      } else {
        masterLines.push(...toAppend);
      }
    }

    // If a task with currentAgent's role prefix exists in master task list,
    // but is NOT present in the child's checklist anymore, remove it!
    const rolePrefix = currentAgent.role ? `[agent: ${currentAgent.role}]` : "";
    const activeChildNormalizedSet = new Set(childTasks.map((t) => normalize(t.text)));

    for (let i = masterLines.length - 1; i >= 0; i--) {
      const line = masterLines[i];
      const match =
        line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/) ||
        line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
      if (match) {
        const taskText = match[2].trim();
        if (rolePrefix && taskText.startsWith(rolePrefix)) {
          const contentWithoutPrefix = taskText.slice(rolePrefix.length).trim();
          if (!activeChildNormalizedSet.has(normalize(contentWithoutPrefix))) {
            masterLines.splice(i, 1);
            masterModified = true;
          }
        }
      }
    }

    if (masterModified) {
      await fs.writeFile(masterTaskPath, masterLines.join("\n"), "utf-8");
      notifyTasksChanged();
    }
  } catch (err) {
    console.error(`[SYNC] Failed to synchronize tasks to master:`, err);
  }
}

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
    let action = args.action as string | undefined;
    const validActions = ["list", "add", "add_bulk", "update", "remove", "update_bulk", "remove_bulk"];
    
    // Auto-infer action if missing based on provided parameters
    if (!action || typeof action !== "string") {
      if (args.status !== undefined && (args.index !== undefined || args.indices !== undefined)) {
        action = Array.isArray(args.indices) ? "update_bulk" : "update";
      } else if (args.texts !== undefined && Array.isArray(args.texts)) {
        action = "add_bulk";
      } else if (args.text !== undefined && typeof args.text === "string") {
        action = "add";
      } else if (args.indices !== undefined && Array.isArray(args.indices)) {
        action = "remove_bulk";
      } else if (args.index !== undefined) {
        action = "remove";
      }
    }

    if (!action || !validActions.includes(action)) {
      return formatUnknownActionError(action as any, validActions);
    }
    const text = args.text as string | undefined;
    const texts = args.texts as string[] | undefined;
    const index = typeof args.index === "string" ? parseInt(args.index, 10) : (args.index as number | undefined);
    const rawIndices = args.indices as any[] | undefined;
    const indices: number[] | undefined = Array.isArray(rawIndices)
      ? rawIndices.map(i => typeof i === "string" ? parseInt(i, 10) : i).filter(i => typeof i === "number" && !isNaN(i))
      : undefined;
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
          .map((t, idx) => {
            // Parse optional [agent: role] annotation from task text for display
            const agentMatch = t.text.match(/^\[agent:\s*([^\]]+)\]\s*/i);
            const agentTag = agentMatch ? ` (agent: ${agentMatch[1].trim()})` : "";
            const displayText = agentMatch ? t.text.slice(agentMatch[0].length) : t.text;
            return `${idx + 1}. [${t.status}] ${displayText}${agentTag}`;
          })
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
        await syncChildTasksToMaster(taskPath, currentAgent);
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
        await syncChildTasksToMaster(taskPath, currentAgent);
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
        await syncChildTasksToMaster(taskPath, currentAgent);
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
        await syncChildTasksToMaster(taskPath, currentAgent);
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
  async execute(rawArgs, cwd, signal) {
    const args: Record<string, any> = (rawArgs && typeof rawArgs === "object" && (rawArgs as any).arguments) ? (rawArgs as any).arguments : (rawArgs as Record<string, any>);
    const action = args?.action as string;
    const validActions = ["create", "edit", "sync", "get"];
    if (!validActions.includes(action)) {
      return formatUnknownActionError(action, validActions);
    }
    const planContentInput = args?.planContent as string | undefined;
    const targetContent = args?.targetContent as string | undefined;
    const replacementContent = args?.replacementContent as string | undefined;
    const sessionId = args?.sessionId as string | undefined;

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
          const { searchSkillsByQuery } = await import("../rmemoryUtil.js");
          const semanticResults = await searchSkillsByQuery(query, skills, 8);
          if (semanticResults.length > 0) {
            aiFiltered = semanticResults;
            aiSuccess = true;
          }
        } catch (err) {
          // Gracefully ignore embedding errors and fallback to keyword search
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
            if (fsSync.existsSync(s.path)) {
              const content = fsSync.readFileSync(s.path, "utf-8");
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

export {
  browserControlHandler,
  setBrowserControlHandler,
  controlBrowserTabTool,
  controlBrowserMacroSaveTool,
  controlBrowserMacroRunTool
} from "./browserMacroTools.js";

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
          if (fsSync.existsSync(skillPath)) {
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

      if (!fsSync.existsSync(foundSkill.path)) {
        return `Error: Skill instruction file not found at path: ${foundSkill.path}`;
      }

      const content = fsSync.readFileSync(foundSkill.path, "utf-8");
      
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
