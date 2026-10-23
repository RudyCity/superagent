/**
 * workspaceTools.ts — Workspace switching, worktree operations, command execution, file tools, search, and checklist tools for MCP.
 */

import fs from "fs";
import path from "path";
import { execa } from "execa";
import { StringDecoder } from "node:string_decoder";
import { createCommandLog } from "../../tools/commandLogger.js";
import { rollingCommandOutput, readCommandOutputPage } from "../../tools/commandOutputPaging.js";
import { McpToolResult } from "../types.js";

import { getMcpWorkspacePath } from "./workspaceContext.js";
import { resolveProjectTarget, assertPathWithinProject } from "../../project/projectRouter.js";
import { loadRegistry } from "../../tools/superagentRegistry.js";
import { handleGetCurrentTask } from "./workspaceStatusTools.js";
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
  onWorkspaceChange?: (workspacePath: string, projectId?: string | null, requiresProjectGrant?: boolean) => void,
  canSelectRegisteredProject?: (projectId: string) => boolean,
  isWorkspaceWithinScopedRoot?: (workspacePath: string) => boolean,
): Promise<McpToolResult> {
  const ws = String(args.workspacePath || args.workspace || args.path || args.dir || "");
  if (!ws && !(typeof args.projectId === "string" && args.projectId.trim())) {
    return { content: [{ type: "text", text: "Error: 'workspacePath' or 'projectId' is required." }], isError: true };
  }
  const currentWorkspace = getMcpWorkspacePath();
  let resolved: string;
  let resolvedProjectId: string | null = null;
  let projectAccessGranted = false;
  try {
    const target = args.projectId
      ? resolveProjectTarget({ projectId: args.projectId, sessionWorkspace: currentWorkspace })
      : resolveProjectTarget({ workspace: path.isAbsolute(ws) || /^(?:ssh:|chain:)/i.test(ws) ? ws : path.resolve(currentWorkspace, ws), sessionWorkspace: currentWorkspace });
    resolved = target.workspace;
    resolvedProjectId = target.projectId;
    projectAccessGranted = Boolean(resolvedProjectId && canSelectRegisteredProject?.(resolvedProjectId));
    if (/^ssh:/i.test(resolved) && !isFullYoloMode() && !projectAccessGranted) {
      throw new Error(`Standalone SSH project access is not granted for project ${resolvedProjectId || resolved}.`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const target = path.isAbsolute(ws) ? path.resolve(ws) : path.resolve(currentWorkspace, ws);
    if (!args.projectId && message.includes("Workspace target is not registered or authorized")
      && (isFullYoloMode() || isPathWithinYoloScope(target, currentWorkspace))) {
      resolved = target;
    } else {
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
  const withinScopedRoot = isWorkspaceWithinScopedRoot
    ? isWorkspaceWithinScopedRoot(resolved)
    : isPathWithinYoloScope(resolved, currentWorkspace);
  if (/^(?:ssh:|chain:)/i.test(resolved)) {
    const requiresProjectGrant = Boolean(!isFullYoloMode() && /^ssh:/i.test(resolved) && projectAccessGranted && !withinScopedRoot);
    onWorkspaceChange?.(resolved, resolvedProjectId, requiresProjectGrant);
    return { content: [{ type: "text", text: `Switched active Superagent workspace to registered remote target: ${resolved}. Use Workspace Chain tools for remote-node operations.` }] };
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    return { content: [{ type: "text", text: `Directory not found: ${resolved}` }], isError: true };
  }

  // Scoped checks use the current MCP connection's workspace, not process-global cwd.
  if (!isFullYoloMode() && !projectAccessGranted && !withinScopedRoot) {
    const allowedRoot = getYoloAllowedRoot(currentWorkspace);
    return {
      content: [{
        type: "text",
        text: `Error: Switching workspace to "${resolved}" is blocked by Scoped YOLO boundary (allowed scope: ${allowedRoot}). Use /yolo full in SuperAgent CLI for unrestricted directory switching.`,
      }],
      isError: true,
    };
  }

  // A project-level access grant is not a blanket trusted-directory grant.
  // Only use legacy trust registration when the active scoped policy already allows this path.
  if (!projectAccessGranted) {
    addTrustedDirectory(resolved);
    await ensureDirectoryTrusted(resolved);
  }
  // Keep selection per MCP server instance. process.chdir() and the shared HTTP
  // server's last-active workspace are process-global and unsafe for concurrency.
  onWorkspaceChange?.(resolved, resolvedProjectId, Boolean(!isFullYoloMode() && projectAccessGranted && !withinScopedRoot));
  return { content: [{ type: "text", text: `Switched active Superagent workspace to: ${resolved}` }] };
}


export async function handleExecCommand(args: any): Promise<McpToolResult> {
  const command = String(args.command || args.cmd || args.commandLine || "");
  const targetCwd = args.cwd || args.workspace || (args.worktreePath ? path.resolve(String(args.worktreePath)) : getMcpWorkspacePath());
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 30000;

  if (args.commandId) {
    try {
      const page = await readCommandOutputPage(
        String(args.commandId), getMcpWorkspacePath(),
        args.offsetBytes === undefined ? 0 : Number(args.offsetBytes),
        args.maxBytes === undefined ? 12_000 : Number(args.maxBytes),
      );
      return { content: [{ type: "text", text:
        "CommandId: " + args.commandId + "\nBytes: " + page.offsetBytes + "-" + page.nextOffsetBytes +
        " / " + page.totalBytes + "\nHas more: " + page.hasMore + "\nNext offsetBytes: " + page.nextOffsetBytes +
        "\n\n" + page.text }] };
    } catch (error) {
      return { content: [{ type: "text", text: "Error reading command log: " + (error instanceof Error ? error.message : String(error)) }], isError: true };
    }
  }
  if (!command) {
    return { content: [{ type: "text", text: "Error: 'command' or 'commandId' is required." }], isError: true };
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
  let cmdLogger: ReturnType<typeof createCommandLog> | undefined;
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

    cmdLogger = createCommandLog(formattedCommand, String(targetCwd));
    const capture = rollingCommandOutput();
    const decoder = new StringDecoder("utf8");
    const proc = execa(formattedCommand, {
      shell: shellPath,
      cwd: targetCwd,
      timeout: timeoutMs,
      reject: false,
      buffer: false,
      all: true,
      stdin: "ignore",
      env: unbufferedEnv,
    });
    childPid = proc.pid;
    const record = (data: Buffer | string) => {
      const chunk = decoder.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
      cmdLogger?.write(chunk);
      capture.append(chunk);
    };
    if (proc.all) proc.all.on("data", record);
    else {
      proc.stdout?.on("data", record);
      proc.stderr?.on("data", record);
    }
    const result = await proc;
    const remaining = decoder.end();
    if (remaining) { cmdLogger.write(remaining); capture.append(remaining); }
    cmdLogger.end(result.exitCode, result.timedOut ? "Timed out" : undefined);

    const output = [
      `Command: ${command}`,
      `Directory: ${targetCwd}`,
      `Exit Code: ${result.exitCode}`,
      "CommandId: " + cmdLogger.id,
      "Log: " + cmdLogger.logPath,
      "Captured characters: " + capture.totalChars,
      capture.clipped ? "Output preview is bounded. Fetch the full log with superagent_exec_command(commandId=\"" + cmdLogger.id + "\", offsetBytes=0, maxBytes=12000), then continue using nextOffsetBytes." : "",
      capture.totalChars ? "\n--- COMBINED OUTPUT ---\n" + capture.preview(cmdLogger.id) : "",
    ].filter(Boolean).join("\n");

    return {
      content: [{ type: "text", text: output }],
      isError: result.exitCode !== 0,
    };
  } catch (err: any) {
    cmdLogger?.end(null, err instanceof Error ? err.message : String(err));
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

  let resolved: string;
  try {
    if (/^(?:ssh:|chain:)/i.test(String(targetCwd))) throw new Error("This file tool only supports local workspaces; use Workspace Chain tools for remote targets.");
    resolved = assertPathWithinProject(path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath), String(targetCwd));
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
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

  let resolved: string;
  try {
    if (/^(?:ssh:|chain:)/i.test(String(targetCwd))) throw new Error("This file tool only supports local workspaces; use Workspace Chain tools for remote targets.");
    resolved = assertPathWithinProject(path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath), String(targetCwd));
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }

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
  const targetCwd = String(args.workspace || args.cwd || getMcpWorkspacePath());
  const dirPath = String(args.dirPath || args.path || args.directory || targetCwd);
  let resolved: string;
  try {
    if (/^(?:ssh:|chain:)/i.test(targetCwd)) throw new Error("This file tool only supports local workspaces; use Workspace Chain tools for remote targets.");
    resolved = assertPathWithinProject(path.isAbsolute(dirPath) ? dirPath : path.resolve(targetCwd, dirPath), targetCwd);
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }

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
  const targetCwd = String(args.workspace || args.cwd || getMcpWorkspacePath());
  let searchPath: string;
  try {
    if (/^(?:ssh:|chain:)/i.test(targetCwd)) throw new Error("This search tool only supports local workspaces; use Workspace Chain tools for remote targets.");
    searchPath = assertPathWithinProject(args.path ? path.resolve(targetCwd, String(args.path)) : targetCwd, targetCwd);
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
  if (!query) {
    return { content: [{ type: "text", text: "Error: 'query' is required for grep search." }], isError: true };
  }

  const { grepTool } = await import("../../tools/fileReadTools.js");
  const result = await grepTool.execute(
    {
      pattern: query,
      path: searchPath,
      include: args.include || args.includes,
      exclude: args.exclude || args.excludes,
      isRegex: args.isRegex,
      caseSensitive: args.caseSensitive,
      offset: args.offset,
      limit: args.limit,
    },
    searchPath
  );
  return { content: [{ type: "text", text: String(result) }] };
}

export async function handleFindFiles(args: any): Promise<McpToolResult> {
  const pattern = String(args.pattern || args.query || args.name || "*");
  const targetCwd = String(args.workspace || args.cwd || getMcpWorkspacePath());
  let searchPath: string;
  try {
    if (/^(?:ssh:|chain:)/i.test(targetCwd)) throw new Error("This search tool only supports local workspaces; use Workspace Chain tools for remote targets.");
    searchPath = assertPathWithinProject(args.path ? path.resolve(targetCwd, String(args.path)) : targetCwd, targetCwd);
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }

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
      filePath: { type: "string", description: "Path to the file to inspect or unlock, restricted to the selected workspace root." },
      workspace: { type: "string", description: "Optional workspace path for this operation." },
      projectId: { type: "string", description: "Optional registered project ID for this operation." },
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
  let resolved: string;
  try {
    if (/^(?:ssh:|chain:)/i.test(targetCwd)) throw new Error("File lock operations require a local workspace. Use Workspace Chain tools for remote nodes.");
    resolved = assertPathWithinProject(path.isAbsolute(filePath) ? filePath : path.resolve(targetCwd, filePath), targetCwd);
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
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
