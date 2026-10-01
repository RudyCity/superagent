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
  autoApproveWorkspace?: boolean;
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
 * Maps common tool aliases (e.g. shell, exec, terminal -> run_command).
 */
export function normalizeToolName(tool: string): string {
  const lower = (tool || "").toLowerCase().trim();
  if (["shell", "exec", "terminal", "cmd", "sh"].includes(lower)) {
    return "run_command";
  }
  return tool;
}

/**
 * Normalizes tool arguments (e.g. mapping path -> filePath for file tools, cmd -> command for shell tools).
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
  if (["run_command", "bash", "shell", "exec", "terminal", "cmd", "sh"].includes(tool)) {
    if (!args.command && (args.cmd || args.script || args.input)) {
      args.command = args.cmd || args.script || args.input;
    }
  }
  return args;
}

/**
 * Executes a batch of tool calls sequentially, enforcing permission gates and truncating outputs.
 */
/**
 * Computes execution waves for a batch of tool calls based on `depends_on`.
 * Each wave lists call ids whose dependencies are all satisfied by earlier waves.
 * Calls with unknown dependencies or participating in dependency cycles are
 * reported in `errors` (call id -> message) and excluded from waves.
 */
export function computeExecutionWaves(calls: BatchToolCall[]): {
  waves: string[][];
  errors: Map<string, string>;
} {
  const errors = new Map<string, string>();
  const callById = new Map<string, BatchToolCall>();
  for (const c of calls) {
    if (!callById.has(c.id)) callById.set(c.id, c);
  }
  const deps = new Map<string, Set<string>>();
  for (const c of calls) {
    if (!callById.has(c.id) || errors.has(c.id)) continue;
    const d = new Set<string>();
    for (const depId of c.depends_on || []) {
      if (depId === c.id) continue;
      if (!callById.has(depId)) {
        errors.set(c.id, `Unknown dependency: ${depId}`);
        break;
      }
      d.add(depId);
    }
    if (!errors.has(c.id)) deps.set(c.id, d);
  }
  // Preserve original call order inside each wave for determinism
  const order = new Map<string, number>();
  calls.forEach((c, i) => {
    if (!order.has(c.id)) order.set(c.id, i);
  });
  const waves: string[][] = [];
  const remaining = new Set<string>(deps.keys());
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((id) => {
        for (const dep of deps.get(id)!) {
          if (remaining.has(dep)) return false;
        }
        return true;
      })
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    if (wave.length === 0) {
      for (const id of remaining) {
        errors.set(id, "Circular dependency detected");
      }
      break;
    }
    waves.push(wave);
    for (const id of wave) remaining.delete(id);
  }
  return { waves, errors };
}

function effectiveSignal(
  call: BatchToolCall,
  batchSignal?: AbortSignal
): {
  signal?: AbortSignal;
  timeoutMs?: number;
  isTimedOut: () => boolean;
  clearCallTimeout: () => void;
} {
  const timeoutMs =
    call.timeout_ms && call.timeout_ms > 0 ? call.timeout_ms : undefined;
  if (!timeoutMs)
    return {
      signal: batchSignal,
      timeoutMs,
      isTimedOut: () => false,
      clearCallTimeout: () => {},
    };
  // Own controller instead of AbortSignal.timeout() so we can record that the
  // deadline fired: some tools turn an abort into a normal "Exit code: 1"
  // result instead of throwing AbortError.
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  return {
    signal: batchSignal
      ? AbortSignal.any([batchSignal, timeoutController.signal])
      : timeoutController.signal,
    timeoutMs,
    isTimedOut: () => timedOut,
    clearCallTimeout: () => clearTimeout(timer),
  };
}

/**
 * Executes a single tool call: name/arg normalization, permission gate,
 * per-call timeout, output truncation, and tool_start/tool_end events.
 */
async function executeOneCall(
  call: BatchToolCall,
  options: BatchExecutorOptions,
  cwd: string
): Promise<BatchToolResult> {
  const toolName = normalizeToolName(call.tool);
  const toolArgs = normalizeArgs(toolName, call.args);
  const toolCallObj = {
    id: call.id,
    name: toolName,
    args: toolArgs,
  };

  const description = getToolDescription(toolCallObj);

  const emitStart = () => {
    if (options.onToolStart) {
      options.onToolStart(toolCallObj, description);
    } else if (options.agent?.onEvent) {
      options.agent.onEvent({
        type: "tool_start",
        toolCall: toolCallObj,
        description,
      });
    }
  };
  const emitEnd = (toolResult: any) => {
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
  };

  emitStart();

  let tool = getToolByName(toolName);
  if (!tool) {
    if (toolName === "write") {
      try {
        const { writeTool } = await import("../tools/fileEditTools.js");
        tool = writeTool;
      } catch {}
    } else if (toolName === "run_command") {
      try {
        const { runCommandTool } = await import("../tools/shellTools.js");
        tool = runCommandTool;
      } catch {}
    } else if (toolName === "bash") {
      try {
        const { bashTool } = await import("../tools/shellTools.js");
        tool = bashTool;
      } catch {}
    }
  }
  if (!tool) {
    const unknownMsg = `Unknown tool: ${toolName}`;
    emitEnd({
      toolCallId: call.id,
      name: toolName,
      result: unknownMsg,
      isError: true,
    });
    return { id: call.id, ok: false, error: unknownMsg };
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
    } else if (options.autoApproveWorkspace && !isDangerous) {
      // 3. Auto-approve workspace modifying operations in watch mode
      // Security gate: block sensitive system files (.env, model-config.json)
      const targetPath = toolArgs.filePath || toolArgs.path || toolArgs.TargetFile;
      const isSensitive =
        typeof targetPath === "string" &&
        (/\.env($|\.)/i.test(targetPath) || /model-config\.json/i.test(targetPath));
      if (!isSensitive) {
        approved = true;
      }
    } else {
      // Without an interactive permission handler, destructive operations are rejected
      approved = false;
    }

    if (!approved) {
      const deniedMsg = `User denied permission to execute tool '${toolName}'.`;
      emitEnd({
        toolCallId: call.id,
        name: toolName,
        result: deniedMsg,
        isError: true,
      });
      return { id: call.id, ok: false, error: deniedMsg };
    }
  }

  const { signal, timeoutMs, isTimedOut, clearCallTimeout } = effectiveSignal(
    call,
    options.signal
  );
  const timeoutError = () =>
    `Tool '${toolName}' timed out after ${timeoutMs}ms`;
  try {
    const rawOutput = await tool.execute(toolArgs, cwd, signal);
    clearCallTimeout();
    if (isTimedOut()) {
      const errMsg = timeoutError();
      emitEnd({
        toolCallId: call.id,
        name: toolName,
        result: errMsg,
        isError: true,
      });
      return { id: call.id, ok: false, error: errMsg };
    }
    const isErr = isErrorResult(String(rawOutput));
    const truncated = truncateOutput(String(rawOutput));

    emitEnd({
      toolCallId: call.id,
      name: toolName,
      result: truncated,
      isError: isErr,
    });

    return isErr
      ? { id: call.id, ok: false, error: truncated }
      : { id: call.id, ok: true, output: truncated };
  } catch (err: any) {
    clearCallTimeout();
    const batchAborted = !!options.signal?.aborted;
    const timedOut = isTimedOut() && !batchAborted;
    const errMsg = batchAborted
      ? "Tool execution aborted"
      : timedOut
        ? timeoutError()
        : truncateOutput(err.message || String(err));

    emitEnd({
      toolCallId: call.id,
      name: toolName,
      result: errMsg,
      isError: true,
    });

    return { id: call.id, ok: false, error: errMsg };
  }
}

function isGatedCall(call: BatchToolCall): boolean {
  const toolName = normalizeToolName(call.tool);
  const toolArgs = normalizeArgs(toolName, call.args);
  return (
    MODIFYING_TOOLS.includes(toolName) ||
    (["bash", "run_command", "run_background_process"].includes(toolName) &&
      isDangerousCommand(toolArgs.command || ""))
  );
}

/**
 * Executes a batch of tool calls in dependency waves.
 *
 * - Calls carrying `depends_on` wait for the listed call ids (topological waves).
 * - Within a wave, read-only calls run concurrently; modifying/dangerous calls run
 *   sequentially to keep permission prompts orderly and avoid write conflicts.
 * - Per-call `timeout_ms` bounds individual tool execution (tool.execute only).
 * - Results are returned in the original call order.
 */
export async function executeBatch(
  calls: BatchToolCall[],
  options: BatchExecutorOptions
): Promise<BatchToolResult[]> {
  const cwd = path.resolve(options.workspace);
  const resultsById = new Map<string, BatchToolResult>();
  const callById = new Map<string, BatchToolCall>();
  for (const c of calls) {
    if (!callById.has(c.id)) callById.set(c.id, c);
  }

  const { waves, errors } = computeExecutionWaves(calls);
  for (const [id, msg] of errors) {
    resultsById.set(id, { id, ok: false, error: msg });
  }

  const markAborted = (ids: Iterable<string>) => {
    for (const id of ids) {
      if (!resultsById.has(id)) {
        resultsById.set(id, { id, ok: false, error: "Execution aborted" });
      }
    }
  };

  for (const wave of waves) {
    if (options.signal?.aborted) {
      markAborted(wave);
      continue;
    }
    const parallelIds: string[] = [];
    const sequentialIds: string[] = [];
    for (const id of wave) {
      (isGatedCall(callById.get(id)!) ? sequentialIds : parallelIds).push(id);
    }
    // Read-only calls run concurrently
    await Promise.all(
      parallelIds.map(async (id) => {
        resultsById.set(id, await executeOneCall(callById.get(id)!, options, cwd));
      })
    );
    // Modifying calls run sequentially (orderly permission prompts, no write conflicts)
    for (const id of sequentialIds) {
      if (options.signal?.aborted) {
        markAborted([id]);
        continue;
      }
      resultsById.set(id, await executeOneCall(callById.get(id)!, options, cwd));
    }
  }

  return calls.map(
    (c) =>
      resultsById.get(c.id) ?? { id: c.id, ok: false, error: "Execution aborted" }
  );
}
