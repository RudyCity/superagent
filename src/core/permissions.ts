import path from "path";
import { getToolByName } from "./tools.js";
import type { ToolCall, ToolResult } from "./conversation.js";
import { getRootConfigDir } from "./config.js";
import { agentLocalStorage } from "./agent.js";

export const MODIFYING_TOOLS = [
  "write",
  "write_to_file",
  "edit",
  "replace_file_content",
  "multi_replace_file_content",
  "apply_patch",
];

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+[\/~]/i,
  /rmdir\s+[\/~]/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:{ *:.+}/,
  /chmod\s+-R\s+777/i,
  /(curl|wget).*\|\s*(ba)?sh/i,
  /eval\(/i,
  /base64\s+-(d|-decode).*\|\s*(ba)?sh/i,
  /Invoke-Expression|iex/i,
  /rmdir\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/i,
  /del\s+\/[fF]\s+\/[sS]\s+\/[qQ]\s+[cC]:\\/i,
  /(shutdown|reboot|halt|poweroff)(\s|$)/i,
  /Remove-Item\s+.*-(Recurse|Force)/i,
  /Format-Volume/i,
  /Initialize-Disk/i,
  /Stop-Process\s+.*-Force/i,
  /Stop-Computer/i,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

function resolveNormalizedPath(fp: string, baseDir?: string): string {
  let normalized = fp;
  if (process.platform === "win32") {
    if (/^\/[a-zA-Z]\//.test(normalized)) {
      normalized = normalized[1] + ":" + normalized.slice(2);
    } else if (/^\/[a-zA-Z]$/.test(normalized)) {
      normalized = normalized[1] + ":/";
    }
  }
  return baseDir ? path.resolve(baseDir, normalized) : path.resolve(normalized);
}

function normalizeAndCheckSubpath(childPath: string, parentPath: string): boolean {
  let resolvedChild = resolveNormalizedPath(childPath);
  let resolvedParent = resolveNormalizedPath(parentPath);
  if (process.platform === "win32") {
    resolvedChild = resolvedChild.toLowerCase();
    resolvedParent = resolvedParent.toLowerCase();
  }
  return resolvedChild.startsWith(resolvedParent + path.sep) || resolvedChild === resolvedParent;
}

/**
 * Checks whether a file path is inside the given worktree directory.
 */
export function isPathInWorktree(filePath: string, worktreePath: string): boolean {
  const isAbs = path.isAbsolute(filePath) || (process.platform === "win32" && /^\/[a-zA-Z]\//.test(filePath));
  const resolved = isAbs
    ? resolveNormalizedPath(filePath)
    : resolveNormalizedPath(filePath, worktreePath);
  return normalizeAndCheckSubpath(resolved, worktreePath);
}

/**
 * Returns true if a Superagent's tool call targets a file OUTSIDE its worktree.
 * Checked for both modifying and reading/search tools.
 */
export function isSuperagentOutOfBounds(
  toolCall: { name: string; args?: Record<string, unknown> },
  worktreePath: string
): boolean {
  const fileModifyingTools = [
    "write", "write_to_file", "edit", "replace_file_content",
    "multi_replace_file_content", "apply_patch",
  ];
  const fileReadingTools = [
    "read", "grep", "glob", "ripgrep_search",
  ];
  const checkedTools = [...fileModifyingTools, ...fileReadingTools];
  if (!checkedTools.includes(toolCall.name)) return false;

  const args = toolCall.args || {};
  const candidatePaths = [
    args.filePath,
    args.file_path,
    args.TargetFile,
    args.path,
  ].filter((v): v is string => typeof v === "string");

  // If no path is specified for search tools, they default to cwd (which is the worktree)
  if (candidatePaths.length === 0 && ["glob", "grep", "ripgrep_search"].includes(toolCall.name)) {
    return false;
  }

  const rootConfig = resolveNormalizedPath(getRootConfigDir());

  for (const fp of candidatePaths) {
    const isAbs = path.isAbsolute(fp) || (process.platform === "win32" && /^\/[a-zA-Z]\//.test(fp));
    const resolved = isAbs
      ? resolveNormalizedPath(fp)
      : resolveNormalizedPath(fp, worktreePath);

    // Allow read-only access to files inside global configuration directory
    // BUT model-config.json is strictly protected and requires permission confirmation
    if (fileReadingTools.includes(toolCall.name)) {
      const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
      if (normalizeAndCheckSubpath(resolved, rootConfig) && !isModelConfig) {
        continue;
      }
    }

    if (!isPathInWorktree(fp, worktreePath)) return true;
  }
  return false;
}

/**
 * Returns true if a tool call targets any path outside the active workspace directory,
 * excluding the global ~/.superagent-r config directory.
 */
export function isToolCallOutOfBounds(
  toolCall: { name: string; args?: Record<string, unknown> },
  workspacePath: string
): boolean {
  const args = toolCall.args || {};
  const candidatePaths = [
    args.filePath,
    args.file_path,
    args.TargetFile,
    args.path,
    args.cwd,
    args.DirectoryPath,
    args.SearchPath,
    args.AbsolutePath,
  ].filter((v): v is string => typeof v === "string");

  const rootConfig = resolveNormalizedPath(getRootConfigDir());

  for (const fp of candidatePaths) {
    const isAbs = path.isAbsolute(fp) || (process.platform === "win32" && /^\/[a-zA-Z]\//.test(fp));
    const resolved = isAbs
      ? resolveNormalizedPath(fp)
      : resolveNormalizedPath(fp, workspacePath);

    // If it's inside ~/.superagent-r/ or workspacePath, it's allowed without permission
    // BUT model-config.json is strictly protected and requires permission confirmation
    const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
    if ((normalizeAndCheckSubpath(resolved, rootConfig) && !isModelConfig) || normalizeAndCheckSubpath(resolved, workspacePath)) {
      continue;
    }
    return true;
  }

  // Check shell commands for relative traversals or absolute paths targeting outside workspace/config
  const shellTools = ["bash", "run_command", "run_background_process"];
  if (shellTools.includes(toolCall.name)) {
    const command = (args.command ?? args.cmd) as string | undefined;
    if (command && typeof command === "string") {
      // Check parent directory traversal patterns
      if (command.includes("..") && (
        command.includes("../") || 
        command.includes("..\\") || 
        command.includes(".. ") || 
        command.endsWith("..")
      )) {
        return true;
      }

      // Check absolute paths in command
      const winAbsPathRegex = /(?:[a-zA-Z]:[\\/][^:\s]+)/g;
      let match;
      while ((match = winAbsPathRegex.exec(command)) !== null) {
        const p = match[0];
        const resolved = resolveNormalizedPath(p);
        const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
        if ((!normalizeAndCheckSubpath(resolved, rootConfig) || isModelConfig) && !normalizeAndCheckSubpath(resolved, workspacePath)) {
          return true;
        }
      }

      const unixAbsPathRegex = /(?:\s|^)(\/[a-zA-Z0-9_\-\.\/]+)/g;
      while ((match = unixAbsPathRegex.exec(command)) !== null) {
        const p = match[1];
        if (p.startsWith("/dev/") || p === "/dev/null" || p.startsWith("/bin/") || p.startsWith("/usr/bin/")) {
          continue;
        }
        const resolved = resolveNormalizedPath(p);
        const isModelConfig = normalizeAndCheckSubpath(resolved, path.join(rootConfig, "model-config.json"));
        if ((!normalizeAndCheckSubpath(resolved, rootConfig) || isModelConfig) && !normalizeAndCheckSubpath(resolved, workspacePath)) {
          return true;
        }
      }
    }
  }

  return false;
}



export function getToolDescription(
  toolCall: ToolCall
): string {
  const args = toolCall.args;
  /** Safely resolve file path from common LLM aliases (filePath, file_path, TargetFile) */
  const fp = (args.filePath ?? args.file_path ?? args.TargetFile ?? "(missing)") as string;
  /** Safe string fallback helper for description interpolation */
  const s = (v: unknown) => (v !== undefined && v !== null ? String(v) : "(missing)");
  switch (toolCall.name) {
    case "read":
      return `Reading file: ${fp}`;
    case "write":
      return `Writing file: ${fp}`;
    case "edit":
      return `Editing file: ${fp}`;
    case "bash":
      return `Running command: ${s(args.command ?? args.cmd)}`;
    case "glob":
      return `Finding files matching pattern: ${s(args.pattern)}`;
    case "grep":
      return `Searching for pattern: ${s(args.pattern)}`;
    case "web_search":
      return `Searching web for: ${s(args.query)}`;
    case "fetch_url":
      return `Fetching URL: ${s(args.url)}`;
    case "ripgrep_search":
      return `Searching codebase with ripgrep for: ${s(args.pattern)}`;
    case "run_background_process":
      return `Starting background process: ${s(args.command ?? args.cmd)}${args.cwd ? ` (in ${args.cwd})` : ""}`;
    case "write_to_file":
      return `Writing file: ${fp}`;
    case "replace_file_content":
      return `Replacing content in file: ${fp}`;
    case "multi_replace_file_content":
      return `Replacing multiple blocks in file: ${fp}`;
    case "run_command":
      return `Running command: ${s(args.command ?? args.cmd)}${args.cwd ? ` (in ${args.cwd})` : ""}`;
    case "manage_background_process":
      return `Managing background process (${s(args.action)}): ${args.processId || ""}`;
    case "schedule":
      return `Scheduling job: ${s(args.prompt)}`;
    case "define_subagent":
      return `Defining subagent: ${s(args.name)}`;
    case "invoke_subagent":
      return `Invoking subagent (${s(args.role)}): ${s(args.typeName)}`;
    case "send_message":
      return `Sending message to subagent: ${s(args.recipientId)}`;
    case "manage_subagents":
      return `Managing subagents (${s(args.action)})`;
    case "invoke_superagent":
      return `Spawning Superagent "${s(args.role)}" on branch ${s(args.branch)}`;
    case "await_superagents":
      return `Waiting for all Superagents to finish`;
    case "merge_superagents":
      return `Merging all completed Superagent branches`;
    case "apply_patch":
      return `Applying patch to file: ${fp}`;
    case "git_action":
      return `Running Git action: ${s(args.action)}`;
    case "screenshot":
      return `Capturing desktop screenshot`;
    case "android_cli":
      return `Running Android CLI command: android ${s(args.command)}`;
    case "ask_question":
      return `Asking user: ${s(args.question)}`;
    default:
      return `Running tool ${toolCall.name} with parameters ${JSON.stringify(args)}`;
  }
}

function isErrorLikeToolResult(result: string): boolean {
  const trimmed = result.trim();
  return (
    /^Error(?:\b|:)/i.test(trimmed) ||
    /^Error reading file:/i.test(trimmed) ||
    /^Git worktree error:/i.test(trimmed) ||
    /^Exit code:\s*[1-9]\d*/i.test(trimmed)
  );
}

export async function executeToolCall(
  toolCall: ToolCall,
  cwd: string,
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = getToolByName(toolCall.name);
  const currentAgent = agentLocalStorage.getStore();
  const tier = currentAgent ? currentAgent.tier : "unknown";
  const depth = currentAgent ? currentAgent.delegationDepth : 0;
  if (!tool) {
    try {
      const { appendMasterLog, appendToolsErrorLog } = await import("./tools/state.js");
      appendMasterLog(`[ERROR] Unknown tool called: ${toolCall.name}`);
      appendToolsErrorLog(tier, depth, toolCall.name, `Unknown tool called: ${toolCall.name}`);
    } catch {}
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: `Error: Unknown tool "${toolCall.name}"`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(toolCall.args, cwd, signal);
    const isError = isErrorLikeToolResult(result);
    if (isError) {
      try {
        const { appendMasterLog, appendToolsErrorLog } = await import("./tools/state.js");
        appendMasterLog(`[ERROR] Tool returned error: ${toolCall.name} | ${String(result).slice(0, 200)}`);
        appendToolsErrorLog(tier, depth, toolCall.name, String(result).slice(0, 500), { cwd });
      } catch {}
    }
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result,
      ...(isError ? { isError: true } : {}),
    };
  } catch (err: unknown) {
    // Re-throw AbortError so it propagates up to the agent loop's finally block,
    // which resets isRunning=false and emits the "done" event.
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    try {
      const { appendMasterLog, appendToolsErrorLog } = await import("./tools/state.js");
      appendMasterLog(`[ERROR] Tool execution failed: ${toolCall.name} | ${message}`);
      appendToolsErrorLog(tier, depth, toolCall.name, message, { cwd });
    } catch {}
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: `Error: ${message}`,
      isError: true,
    };
  }
}
