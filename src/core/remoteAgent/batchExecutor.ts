import path from "path";
import type { BatchToolCall, BatchToolResult } from "./protocol.js";
import type { Agent } from "../agent.js";
import { getToolByName } from "../tools/index.js";
import {
  MODIFYING_TOOLS,
  getToolDescription,
  isDangerousCommand,
} from "../permissions.js";

export interface BatchExecutorOptions {
  workspace: string;
  agent?: Agent | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onPermissionPrompt?: (toolCall: any, description: string) => Promise<boolean | "session">;
}

export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export function truncateOutput(text: string, maxChars = MAX_TOOL_OUTPUT_CHARS): string {
  if (!text || text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + "\n[truncated]";
}

function isErrorResult(resultStr: string): boolean {
  const trimmed = resultStr.trim();
  return (
    /^Error(?:\b|:)/i.test(trimmed) ||
    /^Error reading file:/i.test(trimmed) ||
    /^Git worktree error:/i.test(trimmed) ||
    /^Exit code:\s*[1-9]\d*/i.test(trimmed)
  );
}

/**
 * Normalizes tool arguments (e.g. mapping path -> filePath for file tools).
 */
function normalizeArgs(tool: string, rawArgs?: Record<string, any>): Record<string, any> {
  const args = { ...(rawArgs || {}) };
  if (
    ["read", "write", "edit", "write_to_file", "replace_file_content", "apply_patch"].includes(
      tool
    )
  ) {
    if (args.path && !args.filePath && !args.TargetFile) {
      args.filePath = args.path;
    }
  }
  return args;
}

/**
 * Executes a batch of tool calls sequentially, enforcing permission gates and truncating outputs.
 */
export async function executeBatch(
  calls: BatchToolCall[],
  options: BatchExecutorOptions
): Promise<BatchToolResult[]> {
  const results: BatchToolResult[] = [];
  const cwd = path.resolve(options.workspace);

  for (const call of calls) {
    if (options.signal?.aborted) {
      results.push({
        id: call.id,
        ok: false,
        error: "Execution aborted",
      });
      break;
    }

    const toolName = call.tool;
    const toolArgs = normalizeArgs(toolName, call.args);
    const toolCallObj = {
      id: call.id,
      name: toolName,
      args: toolArgs,
    };

    let tool = getToolByName(toolName);
    if (!tool) {
      if (toolName === "write") {
        try {
          const { writeTool } = await import("../tools/fileEditTools.js");
          tool = writeTool;
        } catch {}
      }
    }
    if (!tool) {
      results.push({
        id: call.id,
        ok: false,
        error: `Unknown tool: ${toolName}`,
      });
      continue;
    }

    const description = getToolDescription(toolCallObj);
    options.onProgress?.(`Executing ${toolName}: ${description}`);

    // Permission enforcement: destructive tools must be explicitly approved
    const isModifying = MODIFYING_TOOLS.includes(toolName);
    const isDangerous =
      ["bash", "run_command", "run_background_process"].includes(toolName) &&
      isDangerousCommand(toolArgs.command || "");

    if (isModifying || isDangerous) {
      let approved = false;

      // 1. Check if agent permission handler is provided
      if (options.agent && typeof (options.agent as any).onPermission === "function") {
        try {
          const res = await (options.agent as any).onPermission(toolCallObj, description);
          approved = res === true || res === "session";
        } catch {
          approved = false;
        }
      } else if (options.onPermissionPrompt) {
        // 2. Custom permission prompt callback
        try {
          const res = await options.onPermissionPrompt(toolCallObj, description);
          approved = res === true || res === "session";
        } catch {
          approved = false;
        }
      } else {
        // Without an interactive permission handler, destructive operations are rejected
        approved = false;
      }

      if (!approved) {
        options.onProgress?.(`Permission denied for ${toolName}`);
        results.push({
          id: call.id,
          ok: false,
          error: `User denied permission to execute tool '${toolName}'.`,
        });
        continue;
      }
    }

    try {
      const rawOutput = await tool.execute(toolArgs, cwd, options.signal);
      const isErr = isErrorResult(String(rawOutput));
      const truncated = truncateOutput(String(rawOutput));

      if (isErr) {
        results.push({
          id: call.id,
          ok: false,
          error: truncated,
        });
      } else {
        results.push({
          id: call.id,
          ok: true,
          output: truncated,
        });
      }
    } catch (err: any) {
      if (options.signal?.aborted || err.name === "AbortError") {
        results.push({
          id: call.id,
          ok: false,
          error: "Tool execution aborted",
        });
        break;
      }
      const errMsg = truncateOutput(err.message || String(err));
      results.push({
        id: call.id,
        ok: false,
        error: errMsg,
      });
    }
  }

  return results;
}
