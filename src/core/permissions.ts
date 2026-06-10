import { getToolByName } from "./tools.js";
import type { ToolCall, ToolResult } from "./conversation.js";

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
    case "run_background":
      return `Starting background task: ${args.command}`;
    case "kill_task":
      return `Killing background task: ${args.taskId}`;
    case "view_background_tasks":
      return `Viewing background tasks`;
    case "write_to_file":
      return `Writing file: ${args.filePath}`;
    case "replace_file_content":
      return `Replacing content in file: ${args.filePath}`;
    case "multi_replace_file_content":
      return `Replacing multiple blocks in file: ${args.filePath}`;
    case "run_command":
      return `Running command: ${args.command}`;
    case "manage_task":
      return `Managing task (${args.action}): ${args.taskId || ""}`;
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

export async function executeToolCall(
  toolCall: ToolCall,
  cwd: string,
  signal?: AbortSignal
): Promise<ToolResult> {
  const tool = getToolByName(toolCall.name);
  if (!tool) {
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: `Error: Unknown tool "${toolCall.name}"`,
      isError: true,
    };
  }

  try {
    const result = await tool.execute(toolCall.args, cwd, signal);
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      toolCallId: toolCall.id,
      name: toolCall.name,
      result: `Error: ${message}`,
      isError: true,
    };
  }
}
