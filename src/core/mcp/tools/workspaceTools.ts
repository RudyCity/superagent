/**
 * workspaceTools.ts — Workspace switching, worktree operations, command execution, file tools, search, and checklist tools for MCP.
 */

import fs from "fs";
import path from "path";
import { execa } from "execa";
import { McpToolResult } from "../types.js";
import { callServerApi } from "./processTools.js";
import { loadRegistry, removeEntries } from "../../tools/superagentRegistry.js";
import { addTrustedDirectory, ensureDirectoryTrusted } from "../../config.js";

export async function handleSwitchWorkspace(args: any): Promise<McpToolResult> {
  const ws = String(args.workspacePath || args.workspace || args.path || args.dir || "");
  if (!ws) {
    return { content: [{ type: "text", text: "Error: 'workspacePath' is required." }], isError: true };
  }
  const resolved = path.resolve(ws);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
  }
  addTrustedDirectory(resolved);
  await ensureDirectoryTrusted(resolved);
  process.chdir(resolved);

  await callServerApi("/api/switch-workspace", "POST", { workspace: resolved });
  return { content: [{ type: "text", text: `Switched active Superagent workspace to: ${resolved}` }] };
}

export async function handleGetWorkspace(): Promise<McpToolResult> {
  const cwd = process.cwd();
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
  const targetCwd = args.cwd || args.workspace || (args.worktreePath ? path.resolve(String(args.worktreePath)) : process.cwd());
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 30000;

  if (!command) {
    return { content: [{ type: "text", text: "Error: 'command' is required." }], isError: true };
  }

  try {
    const isWin = process.platform === "win32";
    const shell = isWin ? (process.env.SHELL || "powershell.exe") : "/bin/bash";
    const result = await execa(command, {
      shell: true,
      cwd: targetCwd,
      timeout: timeoutMs,
      reject: false,
      stripFinalNewline: true,
    });

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
  const targetCwd = args.cwd || args.workspace || process.cwd();

  if (!filePath) {
    return { content: [{ type: "text", text: "Error: 'filePath' is required." }], isError: true };
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath);
  if (!fs.existsSync(resolved)) {
    return { content: [{ type: "text", text: `File not found: ${resolved}` }], isError: true };
  }

  try {
    const content = fs.readFileSync(resolved, "utf-8");
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

export async function handleWriteFile(args: any): Promise<McpToolResult> {
  const filePath = String(args.filePath || args.path || args.file || "");
  const content = String(args.content ?? args.code ?? args.text ?? "");
  const overwrite = args.overwrite !== false;
  const targetCwd = args.cwd || args.workspace || process.cwd();

  if (!filePath) {
    return { content: [{ type: "text", text: "Error: 'filePath' is required." }], isError: true };
  }

  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath);
  if (fs.existsSync(resolved) && !overwrite) {
    return { content: [{ type: "text", text: `File already exists: ${resolved}. Set overwrite: true to overwrite.` }], isError: true };
  }

  try {
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf-8");
    return { content: [{ type: "text", text: `Successfully wrote ${content.length} characters to: ${resolved}` }] };
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error writing file: ${err.message}` }], isError: true };
  }
}

export async function handleListFiles(args: any): Promise<McpToolResult> {
  const dirPath = String(args.dirPath || args.path || args.directory || args.workspace || process.cwd());
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
  const searchPath = args.path ? path.resolve(String(args.path)) : process.cwd();
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
  const searchPath = args.path ? path.resolve(String(args.path)) : process.cwd();

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

export async function handleGetPlanAndTasks(args: any): Promise<McpToolResult> {
  const ws = args.workspace ? path.resolve(String(args.workspace)) : process.cwd();
  const { readChecklistTasks } = await import("../../taskChecklist.js");
  const taskFiles = [
    path.join(ws, "_task.md"),
    path.join(ws, "task.md"),
    path.join(ws, "tasks.md"),
  ];
  let foundTasks: any[] = [];
  for (const tf of taskFiles) {
    if (fs.existsSync(tf)) {
      const res = await readChecklistTasks(tf);
      if (res.tasks && res.tasks.length > 0) {
        foundTasks = res.tasks;
        break;
      }
    }
  }

  const planFiles = [
    path.join(ws, "_plan.md"),
    path.join(ws, "plan.md"),
    path.join(ws, "implementation_plan.md"),
  ];
  let planContent = "(No plan document found)";
  for (const pf of planFiles) {
    if (fs.existsSync(pf)) {
      planContent = fs.readFileSync(pf, "utf-8");
      break;
    }
  }

  const lines = ["=== Implementation Plan ===", planContent.slice(0, 1500), "\n=== Task Checklist ==="];
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
  const action = String(args.action || "get_status");
  const taskText = String(args.taskText || args.task || args.text || "");
  const { managePlanTool } = await import("../../tools/otherTools.js");
  const result = await managePlanTool.execute({ action, task: taskText }, process.cwd());
  return { content: [{ type: "text", text: String(result) }] };
}
