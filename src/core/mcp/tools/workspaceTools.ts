/**
 * workspaceTools.ts — Workspace switching, worktree operations, command execution, file tools, search, and checklist tools for MCP.
 */

import fs from "fs";
import path from "path";
import { execa } from "execa";
import { McpToolResult } from "../types.js";

import { getMcpWorkspacePath } from "./workspaceContext.js";
import { loadRegistry, removeEntries } from "../../tools/superagentRegistry.js";
import { addTrustedDirectory, ensureDirectoryTrusted } from "../../config.js";
import {
  isYoloMode,
  isFullYoloMode,
  isSystemDestructiveCommand,
  isPathWithinYoloScope,
  isToolCallWithinYoloScope,
  getYoloAllowedRoot,
} from "../../permissions.js";
import { mapConcurrentOrdered } from "../../concurrency.js";
import {
  resolveWindowsShell,
  formatCommandForPowerShell,
  augmentWindowsEnvPath,
  killProcessTree,
} from "../../tools/helpers.js";


export async function handleSwitchWorkspace(
  args: any,
  onWorkspaceChange?: (workspacePath: string) => void,
): Promise<McpToolResult> {
  const ws = String(args.workspacePath || args.workspace || args.path || args.dir || "");
  if (!ws) {
    return { content: [{ type: "text", text: "Error: 'workspacePath' is required." }], isError: true };
  }
  const resolved = path.resolve(getMcpWorkspacePath(), ws);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
  }

  // Scoped checks use the current MCP connection's workspace, not process-global cwd.
  const currentWorkspace = getMcpWorkspacePath();
  if (!isFullYoloMode() && !isPathWithinYoloScope(resolved, currentWorkspace)) {
    const allowedRoot = getYoloAllowedRoot(currentWorkspace);
    return {
      content: [{
        type: "text",
        text: `Error: Switching workspace to "${resolved}" is blocked by Scoped YOLO boundary (allowed scope: ${allowedRoot}). Use /yolo full in SuperAgent CLI for unrestricted directory switching.`,
      }],
      isError: true,
    };
  }

  addTrustedDirectory(resolved);
  await ensureDirectoryTrusted(resolved);
  // Keep selection per MCP server instance. process.chdir() and the shared HTTP
  // server's last-active workspace are process-global and unsafe for concurrency.
  onWorkspaceChange?.(resolved);
  return { content: [{ type: "text", text: `Switched active Superagent workspace to: ${resolved}` }] };
}

export async function handleGetWorkspace(): Promise<McpToolResult> {
  const cwd = getMcpWorkspacePath();
  let branch = "unknown";
  try {
    const { execSync } = await import("child_process");
    branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, encoding: "utf-8" }).trim();
  } catch {}

  const registry = loadRegistry();
  const lines = [
    `Current Workspace: ${cwd}`,
    `Git Branch: ${branch}`,
    `Registered Feature Worktrees (${registry.length}):`,
  ];
  for (const r of registry) {
    lines.push(`  - [${r.id}] ${r.role} -> ${r.branch} (${r.status}) at ${r.worktreePath}`);
  }
  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleExecCommand(args: any): Promise<McpToolResult> {
  const command = String(args.command || args.cmd || args.commandLine || "");
  const targetCwd = args.cwd || args.workspace || (args.worktreePath ? path.resolve(String(args.worktreePath)) : getMcpWorkspacePath());
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 30000;

  if (!command) {
    return { content: [{ type: "text", text: "Error: 'command' is required." }], isError: true };
  }

  // Layer 2: Defense-in-depth safety checks for command execution
  if (!isFullYoloMode()) {
    if (isSystemDestructiveCommand(command)) {
      return {
        content: [{
          type: "text",
          text: "Error: Command execution blocked by safety policy. Destructive system operations are prohibited in Scoped YOLO mode. Use /yolo full in SuperAgent CLI if this was intentional.",
        }],
        isError: true,
      };
    }
    const inScope = isToolCallWithinYoloScope({ name: "superagent_exec_command", args: { command, cwd: targetCwd } }, targetCwd);
    if (!inScope) {
      const allowedRoot = getYoloAllowedRoot(targetCwd);
      return {
        content: [{
          type: "text",
          text: `Error: Command execution blocked by Scoped YOLO boundary. Target directory or command traverses outside allowed scope (${allowedRoot}) or accesses protected config files. Use /yolo full in SuperAgent CLI for unrestricted access.`,
        }],
        isError: true,
      };
    }
  }

  let childPid: number | undefined;
  try {
    const isWin = process.platform === "win32";
    let shellPath: string | boolean = true;
    let formattedCommand = command;
    if (isWin) {
      const resolved = resolveWindowsShell();
      shellPath = resolved.shellPath;
      if (!resolved.isBash) {
        formattedCommand = formatCommandForPowerShell(command);
      }
    } else {
      shellPath = process.env.SHELL || "/bin/bash";
    }

    const unbufferedEnv = augmentWindowsEnvPath({
      ...process.env,
      PYTHONUNBUFFERED: "1",
      CI: "1",
    });

    const proc = execa(formattedCommand, {
      shell: shellPath,
      cwd: targetCwd,
      timeout: timeoutMs,
      reject: false,
      stripFinalNewline: true,
      stdin: "ignore",
      env: unbufferedEnv,
    });
    childPid = proc.pid;

    const result = await proc;

    const output = [
      `Command: ${command}`,
      `Directory: ${targetCwd}`,
      `Exit Code: ${result.exitCode}`,
      result.stdout ? `\n--- STDOUT ---\n${result.stdout}` : "",
      result.stderr ? `\n--- STDERR ---\n${result.stderr}` : "",
    ].filter(Boolean).join("\n");

    return {
      content: [{ type: "text", text: output }],
      isError: result.exitCode !== 0,
    };
  } catch (err: any) {
    if (childPid) {
      killProcessTree(childPid);
    }
    return {
      content: [{ type: "text", text: `Command execution error: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleReadFile(args: any): Promise<McpToolResult> {
  const filePath = String(args.filePath || args.path || args.file || "");
  const startLine = typeof args.startLine === "number" ? Math.max(1, args.startLine) : 1;
  const endLine = typeof args.endLine === "number" ? args.endLine : undefined;
  const targetCwd = args.cwd || args.workspace || getMcpWorkspacePath();

  if (!filePath) {
    return { content: [{ type: "text", text: "Error: 'filePath' is required." }], isError: true };
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath);
  if (!fs.existsSync(resolved)) {
    return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
  }

  try {
    const content = await fs.promises.readFile(resolved, "utf-8");
    const lines = content.split(/\r?\n/);
    const selected = endLine ? lines.slice(startLine - 1, endLine) : lines.slice(startLine - 1);
    const numbered = selected.map((line, idx) => `${startLine + idx}: ${line}`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: `File: ${resolved} (Lines ${startLine} to ${endLine || lines.length}/${lines.length})\n\n${numbered}`,
        },
      ],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error reading file: ${err.message}` }], isError: true };
  }
}

/** Read multiple files in one MCP call. The single-file handler remains as a disabled legacy endpoint. */
export async function handleReadFiles(args: any): Promise<McpToolResult> {
  const entries = args.files ?? args.filePaths;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { content: [{ type: "text", text: "Error: 'files' must be a non-empty array of file paths or { filePath, startLine?, endLine? } objects." }], isError: true };
  }
  if (entries.length > 50) {
    return { content: [{ type: "text", text: "Error: A single read_files call is limited to 50 files." }], isError: true };
  }

  const targetCwd = args.cwd || args.workspace || getMcpWorkspacePath();
  const perFileResults = await mapConcurrentOrdered(entries, 6, async (entry) => {
    const filePath = typeof entry === "string" ? entry : String(entry?.filePath || entry?.path || "");
    if (!filePath) {
      return { isError: true, output: "Error: Each files entry must be a path string or an object with 'filePath'." };
    }

    const result = await handleReadFile({
      filePath,
      startLine: typeof entry === "object" && entry?.startLine !== undefined ? entry.startLine : args.startLine,
      endLine: typeof entry === "object" && entry?.endLine !== undefined ? entry.endLine : args.endLine,
      cwd: targetCwd,
    });
    const output = (result.content || []).map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
    return { isError: !!result.isError, output: output || `No text returned for: ${filePath}` };
  });
  const successes = perFileResults.filter((result) => !result.isError).length;
  const failures = perFileResults.length - successes;
  const sections = perFileResults.map((result) => result.output);

  return {
    content: [{ type: "text", text: `Read files: ${successes} succeeded, ${failures} failed.\n\n${sections.join("\n\n---\n\n")}` }],
    isError: successes === 0,
  };
}

export async function handleWriteFile(args: any): Promise<McpToolResult> {
  const filePath = String(args.filePath || args.path || args.file || "");
  const content = String(args.content ?? args.code ?? args.text ?? "");
  const overwrite = args.overwrite !== false;
  const targetCwd = args.cwd || args.workspace || getMcpWorkspacePath();

  if (!filePath) {
    return { content: [{ type: "text", text: "Error: 'filePath' is required." }], isError: true };
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath);

  // Layer 2: Defense-in-depth safety checks for file write
  if (!isFullYoloMode()) {
    if (path.basename(resolved).toLowerCase() === "model-config.json") {
      return {
        content: [{ type: "text", text: "Error: Writing to model-config.json is strictly protected and prohibited via MCP." }],
        isError: true,
      };
    }
    if (!isPathWithinYoloScope(resolved, targetCwd)) {
      const allowedRoot = getYoloAllowedRoot(targetCwd);
      return {
        content: [{
          type: "text",
          text: `Error: File write blocked by Scoped YOLO boundary: "${resolved}" is outside allowed scope (${allowedRoot}). Use /yolo full in SuperAgent CLI for unrestricted access.`,
        }],
        isError: true,
      };
    }
  }

  if (fs.existsSync(resolved) && !overwrite) {
    return { content: [{ type: "text", text: `File already exists: ${resolved}. Set overwrite: true to overwrite.` }], isError: true };
  }

  try {
    const { checkFileLock, releaseFile } = await import("../../storage/sharedMemory.js");
    const lockCheck = checkFileLock(resolved, undefined, targetCwd);
    if (lockCheck.locked) {
      if (isYoloMode()) releaseFile(resolved, undefined, targetCwd, true);
      else return { content: [{ type: "text", text: `Error: [LOCK_CONFLICT] File "${resolved}" is locked by session ${lockCheck.owner?.sessionId || "unknown"}. Use superagent_unlock_file with action: "force_unlock" or switch to /yolo mode to override.` }], isError: true };
    }
  } catch (err: any) {
    if (err?.code === "LOCK_CONFLICT") return { content: [{ type: "text", text: `Error: [LOCK_CONFLICT] ${err.message}` }], isError: true };
  }

  try {
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await fs.promises.writeFile(resolved, content, "utf-8");
    return { content: [{ type: "text", text: `Successfully wrote ${content.length} characters to: ${resolved}` }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error writing file: ${err.message}` }], isError: true };
  }
}

/** Write multiple files in one MCP call; each item reuses the single-file safety and lock checks. */
export async function handleWriteFiles(args: any): Promise<McpToolResult> {
  const entries = args.files;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { content: [{ type: "text", text: "Error: 'files' must be a non-empty array of { filePath, content, overwrite? } objects." }], isError: true };
  }
  if (entries.length > 50) {
    return { content: [{ type: "text", text: "Error: A single write_files call is limited to 50 files." }], isError: true };
  }

  const targetCwd = args.cwd || args.workspace || getMcpWorkspacePath();
  const prepared = entries.map((entry) => {
    const filePath = String(entry?.filePath || entry?.path || "");
    if (!filePath || typeof entry?.content !== "string") {
      return {
        entry,
        filePath,
        resolved: "",
        identity: "",
        error: `Error: Each files entry requires 'filePath' and string 'content'. Path: ${filePath || "(missing)"}`,
      };
    }
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(targetCwd, filePath);
    const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    return { entry, filePath, resolved, identity, error: "" };
  });
  const targetCounts = new Map<string, number>();
  for (const item of prepared) {
    if (!item.error) targetCounts.set(item.identity, (targetCounts.get(item.identity) || 0) + 1);
  }

  const perFileResults = await mapConcurrentOrdered(prepared, 6, async (item) => {
    if (item.error) return { isError: true, output: item.error };
    if ((targetCounts.get(item.identity) || 0) > 1) {
      return { isError: true, output: `Error: Duplicate target path in batch: ${item.resolved}. Each file may appear only once per call; no duplicate target was written.` };
    }

    const result = await handleWriteFile({
      filePath: item.filePath,
      content: item.entry.content,
      overwrite: item.entry.overwrite ?? args.overwrite,
      cwd: targetCwd,
    });
    const output = (result.content || []).map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
    return { isError: !!result.isError, output: output || `No text returned for: ${item.filePath}` };
  });
  const successes = perFileResults.filter((result) => !result.isError).length;
  const failures = perFileResults.length - successes;
  const results = perFileResults.map((result) => result.output);

  return {
    content: [{ type: "text", text: `Wrote files: ${successes} succeeded, ${failures} failed.\n\n${results.join("\n\n---\n\n")}` }],
    isError: successes === 0,
  };
}

export async function handleListFiles(args: any): Promise<McpToolResult> {
  const dirPath = String(args.dirPath || args.path || args.directory || args.workspace || getMcpWorkspacePath());
  const resolved = path.resolve(dirPath);

  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
  }

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const formatted = entries.map((e) => `${e.isDirectory() ? "📁 [DIR] " : "📄 [FILE]"} ${e.name}`).join("\n");
    return {
      content: [
        {
          type: "text",
          text: `Contents of ${resolved} (${entries.length} items):\n\n${formatted || "(empty directory)"}`,
        },
      ],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error listing directory: ${err.message}` }], isError: true };
  }
}

export async function handleGrepSearch(args: any): Promise<McpToolResult> {
  const query = String(args.query || args.pattern || args.search || "");
  const searchPath = args.path ? path.resolve(getMcpWorkspacePath(), String(args.path)) : getMcpWorkspacePath();
  if (!query) {
    return { content: [{ type: "text", text: "Error: 'query' is required for grep search." }], isError: true };
  }

  const { grepTool } = await import("../../tools/fileReadTools.js");
  const result = await grepTool.execute(
    {
      query,
      path: searchPath,
      include: args.include || args.includes,
      exclude: args.exclude || args.excludes,
      isRegex: args.isRegex,
      caseSensitive: args.caseSensitive,
    },
    searchPath
  );
  return { content: [{ type: "text", text: String(result) }] };
}

export async function handleFindFiles(args: any): Promise<McpToolResult> {
  const pattern = String(args.pattern || args.query || args.name || "*");
  const searchPath = args.path ? path.resolve(getMcpWorkspacePath(), String(args.path)) : getMcpWorkspacePath();

  const { globTool } = await import("../../tools/fileReadTools.js");
  const result = await globTool.execute(
    {
      pattern,
      path: searchPath,
    },
    searchPath
  );
  return { content: [{ type: "text", text: String(result) }] };
}

export async function handleManageWorktrees(args: any): Promise<McpToolResult> {
  const action = String(args.action || "list");
  const registry = loadRegistry();

  if (action === "list") {
    if (registry.length === 0) {
      return { content: [{ type: "text", text: "No feature worktrees currently registered." }] };
    }
    const lines = ["=== Registered Git Feature Worktrees ==="];
    for (const r of registry) {
      const exists = fs.existsSync(r.worktreePath);
      lines.push(`- ID: ${r.id} | Role: ${r.role} | Branch: ${r.branch} | Status: ${r.status}`);
      lines.push(`  Path: ${r.worktreePath} [${exists ? "Active on Disk" : "Removed"}]`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  if (action === "remove" || action === "delete") {
    const id = String(args.id || args.superagentId || "");
    if (!id) {
      return { content: [{ type: "text", text: "Error: 'id' is required to remove a worktree." }], isError: true };
    }
    const entry = registry.find((r) => r.id === id);
    if (entry) {
      try {
        if (fs.existsSync(entry.worktreePath)) {
          fs.rmSync(entry.worktreePath, { recursive: true, force: true });
        }
        removeEntries([id]);
        return { content: [{ type: "text", text: `Successfully removed worktree for Superagent '${id}' (${entry.branch}).` }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: `Error removing worktree: ${err.message}` }], isError: true };
      }
    }
    return { content: [{ type: "text", text: `No worktree entry found with ID: ${id}` }], isError: true };
  }

  return { content: [{ type: "text", text: `Unknown worktree action: ${action}` }], isError: true };
}

export async function handleGetCurrentTask(args: any): Promise<McpToolResult> {
  const { resolveInstanceCurrentTask } = await import("./taskResolver.js");
  const targetWs = args.workspace || getMcpWorkspacePath();
  const resolution = await resolveInstanceCurrentTask(args.workspace ? args : { ...args, workspace: targetWs });

  if (!resolution.found && resolution.errorMessage) {
    return {
      content: [{ type: "text", text: `Error: ${resolution.errorMessage}` }],
      isError: true,
    };
  }

  const currentOnly = args.currentOnly ?? args.current_only ?? args.currentTaskOnly ?? false;
  if (currentOnly) {
    return {
      content: [{ type: "text", text: resolution.currentTask || "(no active task)" }],
    };
  }

  const lines: string[] = [
    `=== Current Instance Task [${resolution.type.toUpperCase()}${resolution.id ? `: ${resolution.id}` : ""}] ===`,
  ];
  if (resolution.role) lines.push(`Role: ${resolution.role}`);
  if (resolution.typeName && resolution.typeName !== resolution.role) lines.push(`Type: ${resolution.typeName}`);
  if (resolution.branch) lines.push(`Branch: ${resolution.branch}`);
  if (resolution.status) lines.push(`Status: ${resolution.status}`);
  if (resolution.goal && resolution.goal !== resolution.currentTask) lines.push(`Objective: ${resolution.goal}`);
  lines.push(`Active Task: ${resolution.currentTask}`);
  lines.push(`Task State: ${resolution.currentTaskStatus.toUpperCase()}`);
  if (resolution.totalTasks > 0) {
    lines.push(`Checklist Step: ${resolution.currentTaskIndex} of ${resolution.totalTasks}`);
    lines.push(`Progress: ${resolution.progress}`);
  }
  if (resolution.activeTool) lines.push(`Active Tool: ${resolution.activeTool}`);
  if (resolution.worktreePath) lines.push(`Worktree / Workspace: ${resolution.worktreePath}`);
  if (resolution.taskFilePath) lines.push(`Task File: ${resolution.taskFilePath}`);

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleGetPlanAndTasks(args: any): Promise<McpToolResult> {
  const currentOnly = args.currentOnly ?? args.current_only ?? args.currentTaskOnly ?? false;
  if (currentOnly) {
    return await handleGetCurrentTask(args);
  }

  const { readChecklistTasks, getCurrentTaskFromChecklist } = await import("../../taskChecklist.js");
  const { resolveInstanceCurrentTask } = await import("./taskResolver.js");

  let ws = args.workspace ? path.resolve(String(args.workspace)) : "";
  let matchedInst: any = null;

  if (!ws && (args.superagentId || args.id || args.instanceId)) {
    const targetId = String(args.superagentId || args.id || args.instanceId);
    const registry = loadRegistry();
    const entry = registry.find((r) => r.id === targetId || r.name === targetId);
    if (entry && entry.worktreePath && fs.existsSync(entry.worktreePath)) {
      ws = entry.worktreePath;
      matchedInst = entry;
    } else {
      const { superagentInstances, subagentInstances } = await import("../../tools/state.js");
      const inst = superagentInstances.get(targetId);
      if (inst && inst.worktreePath && fs.existsSync(inst.worktreePath)) {
        ws = inst.worktreePath;
        matchedInst = inst;
      } else {
        const sub = subagentInstances.get(targetId);
        if (sub) {
          return await handleGetCurrentTask({ id: targetId });
        }
      }
    }
    if (!ws) {
      const { loadActiveProcesses } = await import("../processJournal.js");
      const processes = loadActiveProcesses();
      for (const p of processes) {
        if (p.activeSuperagents) {
          const matchedSa = p.activeSuperagents.find((sa) => sa.id === targetId);
          if (matchedSa && matchedSa.worktreePath && fs.existsSync(matchedSa.worktreePath)) {
            ws = matchedSa.worktreePath;
            matchedInst = matchedSa;
            break;
          }
        }
      }
    }
    if (!ws) {
      const { resolveInstanceCurrentTask } = await import("./taskResolver.js");
      const resolution = await resolveInstanceCurrentTask(args);
      if (resolution.found && resolution.worktreePath && fs.existsSync(resolution.worktreePath)) {
        ws = resolution.worktreePath;
        matchedInst = resolution;
      } else if (resolution.found && resolution.tasks.length > 0) {
        // Return resolved tasks even without a worktree directory
        const taskInfo = getCurrentTaskFromChecklist(resolution.tasks);
        const header = `=== Implementation Plan [Instance: ${targetId}] ===`;
        const lines = [header];
        if (taskInfo.task) {
          lines.push(`\n=== Current Active Task ===`);
          lines.push(`  Task: ${taskInfo.task}`);
          lines.push(`  Status: ${taskInfo.status === "in_progress" ? "[/] (In Progress)" : "[ ] (Pending)"}`);
          lines.push(`  Progress: ${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)`);
        }
        lines.push(`\n${resolution.planContent || "(No plan document found)"}`);
        lines.push("\n=== Task Checklist ===");
        for (const t of resolution.tasks) {
          lines.push(`  - [${t.status}] ${t.text}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } else {
        return {
          content: [{ type: "text", text: `Error: No active or registered worktree found for Superagent instance "${targetId}".` }],
          isError: true,
        };
      }
    }
  }

  if (!ws) {
    ws = getMcpWorkspacePath();
  }

  let foundTasks: any[] = [];
  let planContent = "(No plan document found)";

  const resolution = await resolveInstanceCurrentTask(args.workspace ? args : { ...args, workspace: ws });
  if (resolution.found) {
    if (resolution.tasks && resolution.tasks.length > 0) {
      foundTasks = resolution.tasks;
    }
    if (resolution.planContent) {
      planContent = resolution.planContent;
    }
    if (resolution.worktreePath && !args.workspace) {
      ws = resolution.worktreePath;
    }
  }

  if (foundTasks.length === 0) {
    const taskFiles = [
      path.join(ws, "_task.md"),
      path.join(ws, "task.md"),
      path.join(ws, "tasks.md"),
    ];
    if (matchedInst?.historyFilePath) {
      taskFiles.push(matchedInst.historyFilePath.replace(/\.json$/, "_task.md"));
    }

    for (const tf of taskFiles) {
      if (fs.existsSync(tf)) {
        const res = await readChecklistTasks(tf);
        if (res.tasks && res.tasks.length > 0) {
          foundTasks = res.tasks;
          break;
        }
      }
    }
  }

  if (planContent === "(No plan document found)") {
    const planFiles = [
      path.join(ws, "_plan.md"),
      path.join(ws, "plan.md"),
      path.join(ws, "implementation_plan.md"),
    ];
    if (matchedInst?.historyFilePath) {
      planFiles.push(matchedInst.historyFilePath.replace(/\.json$/, "_implementation_plan.md"));
    }

    for (const pf of planFiles) {
      if (fs.existsSync(pf)) {
        planContent = fs.readFileSync(pf, "utf-8");
        break;
      }
    }
  }

  const taskInfo = getCurrentTaskFromChecklist(foundTasks);
  const header = args.superagentId || args.id || args.instanceId
    ? `=== Implementation Plan [Instance: ${args.superagentId || args.id || args.instanceId}] ===`
    : "=== Implementation Plan ===";
  const lines = [header];

  if (taskInfo.task) {
    const statusLabel =
      taskInfo.status === "in_progress"
        ? "[/] (In Progress)"
        : taskInfo.status === "pending"
        ? "[ ] (Pending)"
        : taskInfo.status === "completed"
        ? "[x] (Completed)"
        : "";
    lines.push(`\n=== Current Active Task ===`);
    lines.push(`  Task: ${taskInfo.task}`);
    if (statusLabel) lines.push(`  Status: ${statusLabel}`);
    if (taskInfo.total > 0) {
      lines.push(`  Progress: ${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)`);
    }
  }

  lines.push(`\n${planContent.slice(0, 1500)}`);
  lines.push("\n=== Task Checklist ===");
  if (foundTasks.length === 0) {
    lines.push("  No checklist tasks found.");
  } else {
    for (const t of foundTasks) {
      const check = t.status === "x" ? "[x]" : t.status === "/" ? "[/]" : "[ ]";
      lines.push(`  - ${check} ${t.text}`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}

export async function handleUpdateTasks(args: any): Promise<McpToolResult> {
  let ws = args.workspace ? path.resolve(String(args.workspace)) : "";

  if (!ws && (args.superagentId || args.id || args.instanceId)) {
    const targetId = String(args.superagentId || args.id || args.instanceId);
    const registry = loadRegistry();
    const entry = registry.find((r) => r.id === targetId || r.name === targetId);
    if (entry && entry.worktreePath && fs.existsSync(entry.worktreePath)) {
      ws = entry.worktreePath;
    } else {
      const { superagentInstances } = await import("../../tools/state.js");
      const inst = superagentInstances.get(targetId);
      if (inst && inst.worktreePath && fs.existsSync(inst.worktreePath)) {
        ws = inst.worktreePath;
      } else {
        return {
          content: [
            {
              type: "text",
              text: `Error: Superagent instance '${targetId}' was not found in active instances or worktree registry.`,
            },
          ],
          isError: true,
        };
      }
    }
  }

  if (!ws) {
    ws = getMcpWorkspacePath();
  }

  const action = String(args.action || "get_status");
  if (action === "get_current_task" || action === "current_task") {
    return await handleGetCurrentTask({ ...args, workspace: ws });
  }

  const taskText = String(args.taskText || args.task || args.text || "");
  const { managePlanTool } = await import("../../tools/otherTools.js");
  const result = await managePlanTool.execute({ action, task: taskText }, ws);

  try {
    const { notifyTasksChanged } = await import("../../tools/state.js");
    notifyTasksChanged();
  } catch {}

  return { content: [{ type: "text", text: String(result) }] };
}

export const UNLOCK_FILE_MCP_TOOL_DEF = {
  name: "superagent_unlock_file",
  description: "Inspect, release, or force-unlock cross-session file locks in the Superagent workspace. Diagnoses zombie/deadlocks and forcibly clears contention.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string", description: "Path to the file to inspect or unlock." },
      action: {
        type: "string",
        enum: ["status", "unlock", "force_unlock"],
        description: "Operation to perform: 'status' (inspect active lock/owner), 'unlock' (gracefully release lock), 'force_unlock' (forcibly evict lock from any session). Defaults to 'unlock'.",
      },
      force: { type: "boolean", description: "Set to true to force-unlock even if the lock is held by another active session." },
      reason: { type: "string", description: "Audit reason for force unlocking (recommended when force is true or action is 'force_unlock')." },
      cwd: { type: "string", description: "Optional working directory / project path." },
      lineRange: {
        type: "object",
        description: "Optional line range for partial lock { startLine, endLine }.",
        properties: {
          startLine: { type: "number" },
          endLine: { type: "number" },
        },
      },
    },
    required: ["filePath"],
  },
};

export async function handleUnlockFile(args: any): Promise<McpToolResult> {
  const filePath = String(args.filePath || args.path || args.file || "");
  const targetCwd = String(args.cwd || args.workspace || getMcpWorkspacePath());
  if (!filePath) return { content: [{ type: "text", text: "Error: 'filePath' is required." }], isError: true };
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath);
  const action = String(args.action || (args.force ? "force_unlock" : "unlock")).toLowerCase();
  if (!["status", "unlock", "force_unlock"].includes(action)) {
    return { content: [{ type: "text", text: 'Unknown action. Use "status", "unlock", or "force_unlock".' }], isError: true };
  }
  const lineRange =
    args.lineRange && typeof args.lineRange.startLine === "number" && typeof args.lineRange.endLine === "number"
      ? { startLine: args.lineRange.startLine, endLine: args.lineRange.endLine }
      : undefined;

  try {
    const { checkFileLock, releaseFile } = await import("../../storage/sharedMemory.js");
    const lock = checkFileLock(resolved, undefined, targetCwd, lineRange);
    if (action === "status") {
      if (!lock.locked) {
        return {
          content: [
            {
              type: "text",
              text: `File Lock Status for ${resolved}:\nStatus: UNLOCKED\nNo active lock or contention detected on this path.`,
            },
          ],
        };
      }
      const owner = lock.owner;
      const rangeStr = owner?.lineRange
        ? `lines ${owner.lineRange.startLine}-${owner.lineRange.endLine}`
        : "entire file";
      const statusLines = [
        `File Lock Status for ${resolved}:`,
        `Status: LOCKED`,
        `Owner Session ID: ${owner?.sessionId || "unknown"}`,
        `Terminal Type: ${owner?.terminalType || "unknown"}`,
        `PID: ${owner?.pid ?? "unknown"}`,
        `Locked Range: ${rangeStr}`,
        `Locked At: ${owner?.lockedAt ? new Date(owner.lockedAt).toISOString() : "unknown"}`,
        `TTL: ${owner?.ttlMs ?? 30000}ms`,
        `Intent Soft Lock: ${owner?.isIntentSoftLock ? "true" : "false"}`,
        `Heartbeat Ping: ${owner?.heartbeatPingAt ? new Date(owner.heartbeatPingAt).toISOString() : "unknown"}`,
      ];
      return { content: [{ type: "text", text: statusLines.join("\n") }] };
    }

    if (!lock.locked) {
      return { content: [{ type: "text", text: `File "${resolved}" is not currently locked. No action needed.` }] };
    }

    const force = action === "force_unlock" || Boolean(args.force);
    const callerSessionId = String(args.sessionId || process.env.SUPERAGENT_SESSION_ID || "");
    if (!force && lock.owner?.sessionId && lock.owner.sessionId !== callerSessionId) {
      return {
        content: [{ type: "text", text: `Failed to unlock "${resolved}": lock is held by another session (${lock.owner.sessionId}). Use action: "force_unlock" or set force: true with a reason to forcibly override.` }],
        isError: true,
      };
    }
    const auditReason =
      String(args.reason || args.details || "") ||
      (force
        ? "Manual force-unlock via superagent_unlock_file MCP"
        : "Unlocked via superagent_unlock_file MCP");

    const result = releaseFile(resolved, callerSessionId || undefined, targetCwd, force, lineRange);
    if (!result.success) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to unlock "${resolved}": ${result.message || "Lock is held by another session"}. Use action: "force_unlock" or set force: true with a reason to forcibly override.`,
          },
        ],
        isError: true,
      };
    }

    const modeLabel = force ? "Forcibly unlocked" : "Successfully unlocked";
    return {
      content: [
        {
          type: "text",
          text: `${modeLabel} "${resolved}".\nPrevious Owner: ${lock.owner?.sessionId || "unknown"} (${lock.owner?.terminalType || "cli"})\nReason: ${auditReason}`,
        },
      ],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error handling lock for ${resolved}: ${err?.message || String(err)}` }], isError: true };
  }
}
