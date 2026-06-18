import path from "path";
import { getToolByName } from "./tools.js";
import type { ToolCall, ToolResult } from "./conversation.js";
import { getRootConfigDir } from "./config.js";

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

/**
 * Checks whether a file path is inside the given worktree directory.
 */
export function isPathInWorktree(filePath: string, worktreePath: string): boolean {
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(worktreePath, filePath);
  const worktree = path.resolve(worktreePath);
  return resolved.startsWith(worktree + path.sep) || resolved === worktree;
}

/**
 * Returns true if a Superagent's tool call targets a file OUTSIDE its worktree.
 * Checked for both modifying and reading/search tools.
 */
export function isSuperagentOutOfBounds(
  toolCall: { name: string; args: Record<string, unknown> },
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

  const candidatePaths = [
    toolCall.args.filePath,
    toolCall.args.TargetFile,
    toolCall.args.path,
  ].filter((v): v is string => typeof v === "string");

  // If no path is specified for search tools, they default to cwd (which is the worktree)
  if (candidatePaths.length === 0 && ["glob", "grep", "ripgrep_search"].includes(toolCall.name)) {
    return false;
  }

  const rootConfig = path.resolve(getRootConfigDir());

  for (const fp of candidatePaths) {
    const resolved = path.isAbsolute(fp)
      ? path.resolve(fp)
      : path.resolve(worktreePath, fp);

    // Allow read-only access to files inside global configuration directory
    if (fileReadingTools.includes(toolCall.name)) {
      if (resolved.startsWith(rootConfig + path.sep) || resolved === rootConfig) {
        continue;
      }
    }

    if (!isPathInWorktree(fp, worktreePath)) return true;
  }
  return false;
}


export function getToolDescription(
  toolCall: ToolCall
): string {
  const args = toolCall.args;
  switch (toolCall.name) {
    case "read":
      return `Reading file: ${args.filePath}`;
    case "write":
      return `Writing file: ${args.filePath}`;
    case "edit":
      return `Editing file: ${args.filePath}`;
    case "bash":
      return `Running command: ${args.command}`;
    case "glob":
      return `Finding files matching pattern: ${args.pattern}`;
    case "grep":
      return `Searching for pattern: ${args.pattern}`;
    case "web_search":
      return `Searching web for: ${args.query}`;
    case "fetch_url":
      return `Fetching URL: ${args.url}`;
    case "ripgrep_search":
      return `Searching codebase with ripgrep for: ${args.pattern}`;
    case "run_background_process":
      return `Starting background process: ${args.command}${args.cwd ? ` (in ${args.cwd})` : ""}`;
    case "write_to_file":
      return `Writing file: ${args.filePath}`;
    case "replace_file_content":
      return `Replacing content in file: ${args.filePath}`;
    case "multi_replace_file_content":
      return `Replacing multiple blocks in file: ${args.filePath}`;
    case "run_command":
      return `Running command: ${args.command}${args.cwd ? ` (in ${args.cwd})` : ""}`;
    case "manage_background_process":
      return `Managing background process (${args.action}): ${args.processId || ""}`;
    case "schedule":
      return `Scheduling job: ${args.prompt}`;
    case "define_subagent":
      return `Defining subagent: ${args.name}`;
    case "invoke_subagent":
      return `Invoking subagent (${args.role}): ${args.typeName}`;
    case "send_message":
      return `Sending message to subagent: ${args.recipientId}`;
    case "manage_subagents":
      return `Managing subagents (${args.action})`;
    case "invoke_superagent":
      return `Spawning Superagent "${args.role}" on branch ${args.branch}`;
    case "await_superagents":
      return `Waiting for all Superagents to finish`;
    case "merge_superagents":
      return `Merging all completed Superagent branches`;
    case "apply_patch":
      return `Applying patch to file: ${args.filePath}`;
    case "git_action":
      return `Running Git action: ${args.action}`;
    case "screenshot":
      return `Capturing desktop screenshot`;
    case "android_cli":
      return `Running Android CLI command: android ${args.command}`;
    case "ask_question":
      return `Asking user: ${args.question}`;
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
  if (!tool) {
    try {
      const { appendMasterLog } = await import("./tools/state.js");
      appendMasterLog(`[ERROR] Unknown tool called: ${toolCall.name}`);
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
        const { appendMasterLog } = await import("./tools/state.js");
        appendMasterLog(`[ERROR] Tool returned error: ${toolCall.name} | ${String(result).slice(0, 200)}`);
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
      const { appendMasterLog } = await import("./tools/state.js");
      appendMasterLog(`[ERROR] Tool execution failed: ${toolCall.name} | ${message}`);
    } catch {}
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: `Error: ${message}`,
      isError: true,
    };
  }
}
