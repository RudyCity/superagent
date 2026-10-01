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
  onToolStart?: (toolCall: any, description: string) => void;
  onToolEnd?: (toolCall: any, toolResult: any, description: string) => void;
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

    const description = getToolDescription(toolCallObj);

    if (options.onToolStart) {
      options.onToolStart(toolCallObj, description);
    } else if (options.agent?.onEvent) {
      options.agent.onEvent({
        type: "tool_start",
        toolCall: toolCallObj,
        description,
      });
    }

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
      const unknownMsg = `Unknown tool: ${toolName}`;
      results.push({
        id: call.id,
        ok: false,
        error: unknownMsg,
      });

      const unknownResult = {
        toolCallId: call.id,
        name: toolName,
        result: unknownMsg,
        isError: true,
      };

      if (options.onToolEnd) {
        options.onToolEnd(toolCallObj, unknownResult, description);
      } else if (options.agent?.onEvent) {
        options.agent.onEvent({
          type: "tool_end",
          toolCall: toolCallObj,
          toolResult: unknownResult,
          description,
        });
      }
      continue;
    }

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
        const deniedMsg = `User denied permission to execute tool '${toolName}'.`;
        results.push({
          id: call.id,
          ok: false,
          error: deniedMsg,
        });

        const deniedResult = {
          toolCallId: call.id,
          name: toolName,
          result: deniedMsg,
          isError: true,
        };

        if (options.onToolEnd) {
          options.onToolEnd(toolCallObj, deniedResult, description);
        } else if (options.agent?.onEvent) {
          options.agent.onEvent({
            type: "tool_end",
            toolCall: toolCallObj,
            toolResult: deniedResult,
            description,
          });
        }
        continue;
      }
    }

    try {
      const rawOutput = await tool.execute(toolArgs, cwd, options.signal);
      const isErr = isErrorResult(String(rawOutput));
      const truncated = truncateOutput(String(rawOutput));

      const toolResult = {
        toolCallId: call.id,
        name: toolName,
        result: truncated,
        isError: isErr,
      };

      if (options.onToolEnd) {
        options.onToolEnd(toolCallObj, toolResult, description);
      } else if (options.agent?.onEvent) {
        options.agent.onEvent({
          type: "tool_end",
          toolCall: toolCallObj,
          toolResult,
          description,
        });
      }

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
      const isAborted = options.signal?.aborted || err.name === "AbortError";
      const errMsg = isAborted ? "Tool execution aborted" : truncateOutput(err.message || String(err));
      
      const toolResult = {
        toolCallId: call.id,
        name: toolName,
        result: errMsg,
        isError: true,
      };

      if (options.onToolEnd) {
        options.onToolEnd(toolCallObj, toolResult, description);
      } else if (options.agent?.onEvent) {
        options.agent.onEvent({
          type: "tool_end",
          toolCall: toolCallObj,
          toolResult,
          description,
        });
      }

      results.push({
        id: call.id,
        ok: false,
        error: errMsg,
      });

      if (isAborted) {
        break;
      }
    }
  }

  return results;
}
