import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getRootConfigDir } from "../config/paths.js";
import { loadRemoteAgentConfig, maskToken } from "./config.js";
import {
  RemoteAgentEnvelope,
  TaskRequestEnvelope,
  TaskResultEnvelope,
  TaskContextMessage,
  DEFAULT_MUSE_SYSTEM_PROMPT,
} from "./protocol.js";
import { MuseClient } from "./museClient.js";
import { executeBatch } from "./batchExecutor.js";
import type { Agent } from "../agent.js";
import { contentToString } from "../conversation.js";
import { logE2E } from "../utils/unifiedLogger.js";

export interface TaskRunnerOptions {
  task: string;
  workspace?: string;
  sessionId?: string;
  context?: TaskContextMessage[];
  agent?: Agent | null;
  signal?: AbortSignal;
  customConfigPath?: string;
  onProgress?: (message: string) => void;
  onChat?: (message: string) => void;
  onToolStart?: (toolCall: any, description: string) => void;
  onToolEnd?: (toolCall: any, toolResult: any, description: string) => void;
}

export interface TaskRunnerResult {
  success: boolean;
  summary: string;
  taskId: string;
  batchCount: number;
  durationMs: number;
  error?: string;
}

export const MAX_BATCHES_PER_TASK = 1000; // safety net only; the stall guard below kills stuck loops
export const MAX_TASK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours (safety net)
export const STALL_ELAPSED_MS = 60 * 60 * 1000; // close only after the task ran this long...
export const STALL_NO_PROGRESS_MS = 60 * 60 * 1000; // ...AND made no progress for this long

/**
 * Human-readable duration for limit messages ("24 hours" instead of "1440 minutes").
 */
function formatDurationLimit(ms: number): string {
  const mins = Math.round(ms / 60000);
  return mins >= 120 ? `${Math.round(mins / 60)} hours` : `${mins} minutes`;
}

interface ActiveRemoteTaskHandle {
  taskId: string;
  abortController: AbortController;
  client: MuseClient;
  startTime: number;
}

let activeRemoteTask: ActiveRemoteTaskHandle | null = null;

export function getActiveRemoteTaskId(): string | null {
  return activeRemoteTask?.taskId || null;
}

/**
 * Aborts any currently active remote task running on this machine.
 * Sends a task_cancel envelope over Telegram to inform Muse to cease work on this task,
 * and aborts the local polling loop and tool executions.
 */
export async function abortActiveRemoteTask(reason = "Cancelled by user"): Promise<boolean> {
  if (!activeRemoteTask) {
    return false;
  }
  const current = activeRemoteTask;
  activeRemoteTask = null;

  logE2E("REMOTE-AGENT", `Aborting active remote task ${current.taskId}: reason=${reason}`);

  try {
    const cancelEnvelope: RemoteAgentEnvelope = {
      v: 1,
      kind: "task_cancel",
      id: `cancel_${crypto.randomUUID()}`,
      task_id: current.taskId,
      reason,
    };
    await current.client.sendEnvelope(cancelEnvelope).catch(() => {});
  } catch (err: any) {
    logE2E("REMOTE-AGENT", `Failed to send task_cancel for ${current.taskId}: ${err?.message || err}`);
  }

  try {
    current.abortController.abort();
  } catch {}

  return true;
}

/**
 * Runs a remote task with Muse as the brain and superagent as local hands.
 * Enforces deduplication of batches, loop guards, and permission gates.
 */
export async function runRemoteTask(options: TaskRunnerOptions): Promise<TaskRunnerResult> {
  const config = loadRemoteAgentConfig(options.customConfigPath);
  if (!config.botToken || !config.groupId || !config.museBotId) {
    throw new Error(
      "Remote agent (Muse) is not configured. Please configure botToken, groupId, and museBotId using `/muse config <key> <value>`."
    );
  }

  // Singleton guard: if watch mode is active, reject to avoid Telegram 409 Conflict
  try {
    const { isMuseWatcherActive } = await import("./museWatcher.js");
    if (isMuseWatcherActive()) {
      throw new Error(
        "Muse Watch Mode is currently active. Either send instructions to Muse in Telegram, or stop watch mode first using '/muse watch stop'."
      );
    }
  } catch (err: any) {
    if (err?.message?.includes("Muse Watch Mode is currently active")) {
      throw err;
    }
  }

  // Singleton guard: if another remote task is currently running, cancel it first
  if (activeRemoteTask) {
    logE2E(
      "REMOTE-AGENT",
      `Active remote task ${activeRemoteTask.taskId} detected. Aborting it before launching new task.`
    );
    await abortActiveRemoteTask("New remote task started by user");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const workspace = path.resolve(
    options.workspace || config.defaultWorkspace || process.cwd()
  );
  const taskId = `task_${crypto.randomUUID()}`;
  const sessionId =
    options.sessionId ||
    options.agent?.sessionId ||
    `sess_${crypto.randomUUID()}`;
  const startTime = Date.now();

  let taskContext: TaskContextMessage[] | undefined = options.context;
  if (!taskContext && options.agent) {
    try {
      const msgs = options.agent.getHistory().getMessages();
      const filtered = msgs
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.content)
        .map((m) => {
          const text = contentToString(m.content).trim();
          return {
            role: m.role as "user" | "assistant",
            content: text,
          };
        })
        .filter((m) => m.content.length > 0);
      if (filtered.length > 0) {
        taskContext = filtered.slice(-10);
      }
    } catch (err) {
      logE2E("REMOTE-AGENT", `Failed to extract conversation context: ${err}`);
    }
  }

  const client = new MuseClient(config);
  const pollAbortController = new AbortController();

  // Register active remote task handle
  activeRemoteTask = {
    taskId,
    abortController: pollAbortController,
    client,
    startTime,
  };

  // Combine external abort signal if provided
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      abortActiveRemoteTask("Operation aborted by signal").catch(() => {});
    });
  }

  let batchCount = 0;
  const seenBatchIds = new Set<string>();
  // Progress-based stall detection: a task only dies when it stops moving forward.
  let lastProgressAt = Date.now();
  const MUTATING_TOOLS = new Set([
    "write",
    "edit",
    "write_to_file",
    "replace_file_content",
    "apply_patch",
    "run_command",
    "bash",
  ]);

  /**
   * Returns true when a batch's results moved the task forward: a successful
   * mutating tool call, or meaningful new information from a read-only call.
   * Retries of the same failing call and pure error results do NOT count.
   */
  const batchMadeProgress = (
    calls: { id: string; tool: string }[] | undefined,
    results: { id: string; ok: boolean; output?: string }[]
  ): boolean => {
    if (!calls) return false;
    const resultById = new Map(results.map((r) => [r.id, r]));
    for (const call of calls) {
      const res = resultById.get(call.id);
      if (!res || !res.ok) continue;
      if (MUTATING_TOOLS.has(call.tool)) return true;
      if (res.output && res.output.trim().length > 0) return true;
    }
    return false;
  };

  const standardTools = [
    "read",
    "glob",
    "grep",
    "ripgrep_search",
    "write",
    "edit",
    "write_to_file",
    "replace_file_content",
    "apply_patch",
    "run_command",
    "bash",
  ];

  const systemPrompt = config.systemPrompt || DEFAULT_MUSE_SYSTEM_PROMPT;
  // Prompt caching: only resend the full system prompt when it changed since the
  // last task_request; otherwise send just the hash (the bridge worker caches it).
  const systemPromptHash = crypto.createHash("sha256").update(systemPrompt).digest("hex").slice(0, 16);
  const promptHashPath = path.join(getRootConfigDir(), "last_system_prompt.hash");
  let lastPromptHash = "";
  try {
    lastPromptHash = fs.readFileSync(promptHashPath, "utf-8").trim();
  } catch {}
  const promptChanged = lastPromptHash !== systemPromptHash;
  const isFirstTurn = !taskContext || taskContext.length === 0;

  // On initial turn of a session, or if taskContext is empty, inject a guidance header
  // so LLM-based remote bots that only read the task string are also fully aware.
  let taskContent = options.task;
  if (isFirstTurn) {
    taskContent = `[SYSTEM INSTRUCTIONS FOR MUSE REMOTE BRAIN]
Tools available: read, glob, grep, ripgrep_search, write, edit, write_to_file, replace_file_content, apply_patch, run_command, bash.
Reply with task_batch for tool execution, and task_done for completion with clear newline formatting.
[END SYSTEM INSTRUCTIONS]

${options.task}`;
  }

  const requestEnvelope: TaskRequestEnvelope = {
    v: 1,
    kind: "task_request",
    id: taskId,
    session: sessionId,
    task: taskContent,
    workspace,
    tools: standardTools,
    system_prompt_hash: systemPromptHash,
    ...((isFirstTurn || promptChanged) ? { system_prompt: systemPrompt } : {}),
    reply_hint: "Always reply directly to Bot B's message in Telegram (use reply_to_message_id). Tools available: read, glob, grep, ripgrep_search, write, edit, write_to_file, replace_file_content, apply_patch, run_command, bash. In task_done, format summary with clear newlines, bullet points (-), and numbered items (1., 2.) for readable terminal presentation.",
    ...(taskContext && taskContext.length > 0 ? { context: taskContext } : {}),
  };

  logE2E("REMOTE-AGENT", `Starting remote task: taskId=${taskId}, session=${sessionId}, workspace=${workspace}`);

  // Step 1: Send the task request to the group
  const sent = await client.sendEnvelope(
    requestEnvelope,
    undefined,
    undefined,
    options.onProgress
  );
  if (!sent) {
    if (activeRemoteTask?.taskId === taskId) {
      activeRemoteTask = null;
    }
    logE2E("REMOTE-AGENT", `Failed to send task request ${taskId} to Telegram group`);
    throw new Error("Failed to send task request to Telegram group. Check bot token and group ID.");
  }
  if (promptChanged) {
    try {
      fs.writeFileSync(promptHashPath, systemPromptHash);
    } catch {}
  }

  logE2E("REMOTE-AGENT", `Task request ${taskId} sent to Telegram group. Awaiting Muse envelopes...`);
  options.onProgress?.("Waiting for Muse reasoning and tool batches...");

  return new Promise<TaskRunnerResult>((resolve, reject) => {
    let resolved = false;

    const cleanup = () => {
      if (activeRemoteTask?.taskId === taskId) {
        activeRemoteTask = null;
      }
      if (!pollAbortController.signal.aborted) {
        pollAbortController.abort();
      }
    };

    const finishSuccess = (summary: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      logE2E("REMOTE-AGENT", `Task ${taskId} completed successfully: batches=${batchCount}, duration=${Date.now() - startTime}ms`);
      resolve({
        success: true,
        summary,
        taskId,
        batchCount,
        durationMs: Date.now() - startTime,
      });
    };

    const finishError = (errorMsg: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      logE2E("REMOTE-AGENT", `Task ${taskId} failed: ${errorMsg}`);
      resolve({
        success: false,
        summary: "",
        taskId,
        batchCount,
        durationMs: Date.now() - startTime,
        error: errorMsg,
      });
    };

    // Timer check for max duration
    const timeoutTimer = setTimeout(() => {
      finishError(
        `Task aborted: exceeded maximum duration limit of ${formatDurationLimit(MAX_TASK_DURATION_MS)}.`
      );
    }, MAX_TASK_DURATION_MS);

    // Step 2: Start long polling for Muse responses
    client
      .pollEnvelopes(async (envelope: RemoteAgentEnvelope, meta?: { messageId?: number }) => {
        if (resolved) return;

        // Check if duration exceeded (24h safety net)
        if (Date.now() - startTime >= MAX_TASK_DURATION_MS) {
          clearTimeout(timeoutTimer);
          finishError(
            `Task aborted: exceeded maximum duration limit of ${formatDurationLimit(MAX_TASK_DURATION_MS)}.`
          );
          return;
        }

        // Progress-based stall guard: close only when the task ran 60+ min
        // AND made no progress for 60+ min. Productive work is never killed.
        const elapsedMs = Date.now() - startTime;
        const idleMs = Date.now() - lastProgressAt;
        if (elapsedMs > STALL_ELAPSED_MS && idleMs > STALL_NO_PROGRESS_MS) {
          clearTimeout(timeoutTimer);
          finishError(`Task aborted: stalled - no progress for 60+ minutes.`);
          return;
        }

        // Chat envelope (progress / notes)
        if (envelope.kind === "chat") {
          const chatMsg = envelope.text;
          logE2E("REMOTE-AGENT", `Chat note received from Muse: ${chatMsg.slice(0, 100)}`);
          options.onChat?.(chatMsg);
          return;
        }

        // Task done envelope
        if (envelope.kind === "task_done") {
          if (envelope.task_id) {
            const normRecv = envelope.task_id.trim().toLowerCase();
            const normActive = taskId.trim().toLowerCase();
            const matches =
              normRecv === normActive ||
              normRecv.replace(/^task_/, "") === normActive.replace(/^task_/, "");
            if (!matches) {
              logE2E("REMOTE-AGENT", `Ignored task_done with mismatched task ID: received '${envelope.task_id}', active '${taskId}'`);
              return;
            }
          }
          clearTimeout(timeoutTimer);
          finishSuccess(envelope.summary);
          return;
        }

        // Batch tool calls envelope
        if (envelope.kind === "task_batch") {
          if (envelope.task_id) {
            const normRecv = envelope.task_id.trim().toLowerCase();
            const normActive = taskId.trim().toLowerCase();
            const matches =
              normRecv === normActive ||
              normRecv.replace(/^task_/, "") === normActive.replace(/^task_/, "");
            if (!matches) {
              logE2E("REMOTE-AGENT", `Ignored task_batch with mismatched task ID: received '${envelope.task_id}', active '${taskId}'`);
              options.onProgress?.(`Warning: Received batch for different task ID (${envelope.task_id}). Active task is ${taskId}.`);
              return;
            }
          }

          // Deduplication: never execute the same batch id twice
          if (seenBatchIds.has(envelope.id)) {
            logE2E("REMOTE-AGENT", `Duplicate batch ID ignored: ${envelope.id}`);
            options.onProgress?.(`Duplicate batch ID ignored: ${envelope.id}`);
            return;
          }
          seenBatchIds.add(envelope.id);

          // Loop guard: maximum batches
          if (batchCount >= MAX_BATCHES_PER_TASK) {
            clearTimeout(timeoutTimer);
            finishError(
              `Task aborted: exceeded maximum limit of ${MAX_BATCHES_PER_TASK} batches per task.`
            );
            return;
          }

          batchCount++;
          const callCount = envelope.calls?.length || 0;
          logE2E("REMOTE-AGENT", `Executing batch ${envelope.id} (${batchCount}/${MAX_BATCHES_PER_TASK}) with ${callCount} tool call(s)`);

          // Execute batch locally with native tool event hooks
          let results: any[] = [];
          try {
            results = await executeBatch(envelope.calls || [], {
              workspace,
              agent: options.agent,
              signal: pollAbortController.signal,
              onToolStart: options.onToolStart,
              onToolEnd: options.onToolEnd,
              onProgress: options.onProgress,
            });
          } catch (execErr: any) {
            logE2E("REMOTE-AGENT", `Batch ${envelope.id} execution threw error: ${execErr.message}`);
            results = (envelope.calls || []).map((c) => ({
              id: c.id,
              ok: false,
              error: `Batch execution failed: ${execErr.message}`,
            }));
          }

          logE2E("REMOTE-AGENT", `Batch ${envelope.id} finished executing. Results count: ${results.length}`);

          // Progress-based stalldetection: a successful mutating call or new
          // information counts as forward motion; errors and retries do not.
          if (batchMadeProgress(envelope.calls, results)) {
            lastProgressAt = Date.now();
            logE2E(
              "REMOTE-AGENT",
              `Batch ${envelope.id} made progress; stall timer reset`
            );
          }

          // Build task_result envelope and post back to Muse
          const resultEnvelope: TaskResultEnvelope = {
            v: 1,
            kind: "task_result",
            id: envelope.id,
            task_id: taskId,
            results,
          };

          const replyToId = meta?.messageId || client.getLastSentMessageId();
          const sendOk = await client.sendEnvelope(
            resultEnvelope,
            undefined,
            replyToId,
            options.onProgress
          );
          if (!sendOk) {
            logE2E("REMOTE-AGENT", `Warning: Failed to deliver results for batch ${envelope.id} to Telegram`);
            options.onProgress?.(
              `Warning: Failed to deliver results for batch ${envelope.id} to Telegram.`
            );
          } else {
            logE2E("REMOTE-AGENT", `Delivered results for batch ${envelope.id} to Telegram`);
          }
        }
      }, pollAbortController.signal)
      .then(() => {
        if (!resolved) {
          clearTimeout(timeoutTimer);
          if (pollAbortController.signal.aborted) {
            finishError("Task execution was cancelled.");
          } else {
            finishError("Polling loop ended before receiving task_done from Muse.");
          }
        }
      })
      .catch((err: any) => {
        clearTimeout(timeoutTimer);
        if (!resolved) {
          finishError(`Polling failed with error: ${err.message}`);
        }
      });
  });
}

/**
 * Sends a session_reset envelope to Muse over Telegram.
 * Informs Muse that the user has started a new conversation or reset session memory.
 */
export async function notifyMuseSessionReset(sessionId?: string, customPath?: string): Promise<boolean> {
  const config = loadRemoteAgentConfig(customPath);
  if (!config.botToken || !config.groupId) {
    return false;
  }
  try {
    const client = new MuseClient(config);
    const targetSession = sessionId || `sess_${crypto.randomUUID()}`;
    const systemPrompt = config.systemPrompt || DEFAULT_MUSE_SYSTEM_PROMPT;
    const resetEnvelope: RemoteAgentEnvelope = {
      v: 1,
      kind: "session_reset",
      id: `reset_${crypto.randomUUID()}`,
      session: targetSession,
      message: "Session context has been reset by user.",
      system_prompt: systemPrompt,
    };
    logE2E("REMOTE-AGENT", `Sending session_reset envelope to Muse: ${resetEnvelope.id}, session=${resetEnvelope.session}`);
    return await client.sendEnvelope(resetEnvelope);
  } catch (err: any) {
    logE2E("REMOTE-AGENT", `Failed to send session_reset to Muse: ${err?.message || err}`);
    return false;
  }
}

