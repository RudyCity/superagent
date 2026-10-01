import crypto from "crypto";
import path from "path";
import { loadRemoteAgentConfig, maskToken } from "./config.js";
import {
  RemoteAgentEnvelope,
  TaskRequestEnvelope,
  TaskResultEnvelope,
} from "./protocol.js";
import { MuseClient } from "./museClient.js";
import { executeBatch } from "./batchExecutor.js";
import type { Agent } from "../agent.js";

export interface TaskRunnerOptions {
  task: string;
  workspace?: string;
  agent?: Agent | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  onChat?: (message: string) => void;
}

export interface TaskRunnerResult {
  success: boolean;
  summary: string;
  taskId: string;
  batchCount: number;
  durationMs: number;
  error?: string;
}

export const MAX_BATCHES_PER_TASK = 50;
export const MAX_TASK_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Runs a remote task with Muse as the brain and superagent as local hands.
 * Enforces deduplication of batches, loop guards, and permission gates.
 */
export async function runRemoteTask(options: TaskRunnerOptions): Promise<TaskRunnerResult> {
  const config = loadRemoteAgentConfig();
  if (!config.botToken || !config.groupId || !config.museBotId) {
    throw new Error(
      "Remote agent (Muse) is not configured. Please configure botToken, groupId, and museBotId using `/muse config <key> <value>`."
    );
  }

  const workspace = path.resolve(
    options.workspace || config.defaultWorkspace || process.cwd()
  );
  const taskId = `task_${crypto.randomUUID()}`;
  const sessionId = `sess_${crypto.randomUUID()}`;
  const startTime = Date.now();

  const client = new MuseClient(config);
  const pollAbortController = new AbortController();

  // Combine external abort signal if provided
  if (options.signal) {
    options.signal.addEventListener("abort", () => {
      pollAbortController.abort();
    });
  }

  let batchCount = 0;
  const seenBatchIds = new Set<string>();

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
  ];

  const requestEnvelope: TaskRequestEnvelope = {
    v: 1,
    kind: "task_request",
    id: taskId,
    session: sessionId,
    task: options.task,
    workspace,
    tools: standardTools,
  };

  options.onProgress?.(`Starting remote task ${taskId} in ${workspace}...`);
  options.onProgress?.(`Sending task request to Muse bot (${config.museBotId})...`);

  // Step 1: Send the task request to the group
  const sent = await client.sendEnvelope(requestEnvelope);
  if (!sent) {
    throw new Error("Failed to send task request to Telegram group. Check bot token and group ID.");
  }

  options.onProgress?.(`Task request sent. Awaiting reasoning batches from Muse...`);

  return new Promise<TaskRunnerResult>((resolve, reject) => {
    let resolved = false;

    const cleanup = () => {
      if (!pollAbortController.signal.aborted) {
        pollAbortController.abort();
      }
    };

    const finishSuccess = (summary: string) => {
      if (resolved) return;
      resolved = true;
      cleanup();
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
        `Task aborted: exceeded maximum duration limit of ${
          MAX_TASK_DURATION_MS / 60000
        } minutes.`
      );
    }, MAX_TASK_DURATION_MS);

    // Step 2: Start long polling for Muse responses
    client
      .pollEnvelopes(async (envelope: RemoteAgentEnvelope) => {
        if (resolved) return;

        // Check if duration exceeded
        if (Date.now() - startTime >= MAX_TASK_DURATION_MS) {
          clearTimeout(timeoutTimer);
          finishError(
            `Task aborted: exceeded maximum duration limit of ${
              MAX_TASK_DURATION_MS / 60000
            } minutes.`
          );
          return;
        }

        // Chat envelope (progress / notes)
        if (envelope.kind === "chat") {
          const chatMsg = envelope.text;
          options.onChat?.(chatMsg);
          options.onProgress?.(`[Muse Note]: ${chatMsg}`);
          return;
        }

        // Task done envelope
        if (envelope.kind === "task_done") {
          if (envelope.task_id && envelope.task_id !== taskId) {
            // Belongs to another task; ignore
            return;
          }
          clearTimeout(timeoutTimer);
          options.onProgress?.(`Task ${taskId} completed by Muse.`);
          finishSuccess(envelope.summary);
          return;
        }

        // Batch tool calls envelope
        if (envelope.kind === "task_batch") {
          if (envelope.task_id && envelope.task_id !== taskId) {
            // Belongs to another task; ignore
            return;
          }

          // Deduplication: never execute the same batch id twice
          if (seenBatchIds.has(envelope.id)) {
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
          options.onProgress?.(
            `Received batch ${envelope.id} (${batchCount}/${MAX_BATCHES_PER_TASK}) with ${callCount} tool call(s).`
          );

          // Execute batch locally
          let results: any[] = [];
          try {
            results = await executeBatch(envelope.calls || [], {
              workspace,
              agent: options.agent,
              signal: pollAbortController.signal,
              onProgress: options.onProgress,
            });
          } catch (execErr: any) {
            results = (envelope.calls || []).map((c) => ({
              id: c.id,
              ok: false,
              error: `Batch execution failed: ${execErr.message}`,
            }));
          }

          // Build task_result envelope and post back to Muse
          const resultEnvelope: TaskResultEnvelope = {
            v: 1,
            kind: "task_result",
            id: envelope.id,
            task_id: taskId,
            results,
          };

          options.onProgress?.(`Sending results for batch ${envelope.id} back to Muse...`);
          const sendOk = await client.sendEnvelope(resultEnvelope);
          if (!sendOk) {
            options.onProgress?.(
              `Warning: Failed to deliver results for batch ${envelope.id} to Telegram.`
            );
          } else {
            options.onProgress?.(`Batch ${envelope.id} results delivered.`);
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
