/** Bounded, authenticated desktop-only detached analysis executor.
 * Workers are independent of the parent chat Agent and deliberately use
 * read-only tools. Nothing starts merely because a journal draft exists.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AssistantTaskRecord, AssistantTaskStore } from "./assistantTaskStore.js";
import { AssistantTaskDispatcher } from "./assistantTaskDispatcher.js";
import { getRootConfigDir } from "../config/paths.js";
import { getAssistantTaskDomain, taskDomainPrompt } from "./assistantTaskDomains.js";
import { recordExecutionStep } from "./assistantExecutionSteps.js";
import { setDetachedToolPreflight } from "./assistantToolPreflight.js";

export type DetachedTaskWorker = (task: AssistantTaskRecord, workspace: string,
  signal: AbortSignal) => Promise<string[]>;

const workers = new Map<string, { dispatcher: AssistantTaskDispatcher; pending: Set<string> }>();
const scopeKey = (ownerId: string, workspaceId: string) =>
  createHash("sha256").update(ownerId + "\0" + workspaceId).digest("hex");

export function getDetachedTaskRuntime(
  store: AssistantTaskStore, scope: { ownerId: string; workspaceId: string },
) {
  const key = getRootConfigDir() + ":" + scopeKey(scope.ownerId, scope.workspaceId);
  let state = workers.get(key);
  if (!state) {
    state = { dispatcher: new AssistantTaskDispatcher(store, 2), pending: new Set<string>() };
    workers.set(key, state);
  }
  const current = state;
  return {
    get liveIds(): string[] { return [...current.pending]; },
    start(task: AssistantTaskRecord, workspace: string, execute: DetachedTaskWorker): void {
      if (task.status !== "queued" || current.pending.has(task.taskId)) {
        throw new Error("Task is not eligible for dispatch");
      }
      // Two concurrent workers are permitted only because their available
      // tools are strictly read-only; mutation-capable workers need file leases.
      current.pending.add(task.taskId);
      try {
        void current.dispatcher.submit(task,
          [{ key: "workspace:" + scope.workspaceId, mode: "read" }],
          async ({ task: claimed, signal }) => execute(claimed, workspace, signal),
        ).catch(() => {
          // Status is persisted by dispatcher (failed or CAS conflict).
          // Never log raw prompt/exception from a worker.
        }).finally(() => { current.pending.delete(task.taskId); });
      } catch (error) {
        current.pending.delete(task.taskId);
        throw error;
      }
    },
    cancel(taskId: string): boolean { return current.dispatcher.cancel(taskId); },
  };
}

/** Model turn with a strict read-only toolset and deny-by-default approvals.
 * Returns text only; the caller validates and persists any proposed artifact. */
export async function generateDetachedReadOnlyText(
  task: AssistantTaskRecord, workspace: string, signal: AbortSignal, prompt = task.title,
): Promise<string> {
  // Keep unattended workers within a real local directory, refusing remote
  // workspace targets or symlinks that could redirect read tools unexpectedly.
  if (!path.isAbsolute(workspace) || !fs.existsSync(workspace)) {
    throw new Error("Detached analysis requires an existing local workspace");
  }
  let segment = path.parse(workspace).root;
  for (const part of path.relative(segment, workspace).split(path.sep).filter(Boolean)) {
    segment = path.join(segment, part);
    const stat = fs.lstatSync(segment);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Detached analysis requires a local directory without symlink traversal");
    }
  }
  const [{ Agent }, { superagentToolset }] = await Promise.all([
    import("../agent.js"), import("../tools/toolsets.js"),
  ]);
  // Explicit user-selected capability profile. No automatic tool escalation.
  const domain = getAssistantTaskDomain(task.domain);
  const allowed = new Set(domain.toolNames);
  const toolset = superagentToolset.filter(tool => allowed.has(tool.name));
  // The executor also enforces the allowlist to prevent a dynamic tool from
  // evading the model-facing catalog restriction.
  let output = "";
  let recordingFailure: Error | null = null;
  let recordQueue: Promise<void> = Promise.resolve();
  let stopOnRecordingFailure: () => void = () => {};
  const agent = new Agent(
    event => {
      if ((event.type === "tool_start" || event.type === "tool_end") && !recordingFailure) {
        const callId = event.type === "tool_start"
          ? event.toolCall.id : event.toolResult.toolCallId || event.toolCall?.id;
        const tool = event.type === "tool_start"
          ? event.toolCall.name : event.toolResult.name || event.toolCall?.name;
        if (typeof callId !== "string" || typeof tool !== "string") {
          recordingFailure = Error("Tool observation missing safe correlation");
          stopOnRecordingFailure();
        } else {
          recordQueue = recordQueue.then(async () => {
            await recordExecutionStep(task, {
              callId, tool, phase: event.type === "tool_start" ? "started" : "finished",
              isError: event.type === "tool_end" && event.toolResult.isError === true,
            });
          }).catch(() => {
            recordingFailure = Error("Execution checkpoint journal failed; manual review required");
            stopOnRecordingFailure();
          });
        }
      }
      if (event.type === "text" && typeof event.content === "string" && output.length < 32_768) {
        output += event.content.slice(0, 32_768 - output.length);
      }
    },
    async () => false,
    async () => "",
    undefined,
    toolset,
    workspace,
  );
  agent.tier = "single";
  agent.isMultiAgent = false;
  agent.disableAmbientYoloMode = true;
  agent.restrictHeadlessTools = true;
  agent.headlessAllowedTools = allowed;
  agent.sessionId = "sess_detached_" + task.taskId.replace(/-/g, "");
  // Executed by the *tool execution boundary* before pre_tool hooks and
  // tool.execute. A failed durable prepare blocks the action entirely.
  const clearPreflight = setDetachedToolPreflight(agent, async call => {
    await recordQueue;
    if (recordingFailure) throw Error("Tool observation failed before preflight");
    if (signal.aborted) throw Error("Task cancelled before tool execution");
    await recordExecutionStep(task, {
      callId: call.id, tool: call.name, phase: "prepared",
    });
  });
  const abort = () => agent.abort();
  stopOnRecordingFailure = abort;
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 5 * 60_000);
  try {
    try { await agent.sendMessage(prompt, signal); }
    finally { await recordQueue; }
    if (recordingFailure) throw Error("Execution checkpoint incomplete; manual review required");
    if (signal.aborted) throw new Error("Task cancelled");
    if (agent.lastTaskOutcome !== "task_completed") {
      throw new Error("Detached task did not report verified completion");
    }
    return output.trim().slice(0, 32_768);
  } finally {
    clearPreflight();
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    agent.dispose();
  }
}

export async function executeDetachedReadOnlyAgent(
  task: AssistantTaskRecord, workspace: string, signal: AbortSignal,
): Promise<string[]> {
  const result = await generateDetachedReadOnlyText(task, workspace, signal,
    taskDomainPrompt(task.domain, task.title));
  const { saveDetachedTaskResult } = await import("./assistantTaskResults.js");
  await saveDetachedTaskResult(task, result);
  return ["summary_saved"];
}
