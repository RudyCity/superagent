/**
 * Generation-bound, monotonic, explicitly driven replay workflows.
 * A workflow never runs browser actions in the background.
 *
 * The caller invokes one step at a time under the existing CDP write lease.
 * The step is consumed BEFORE side effects; an uncertain result cannot be retried.
 * Sensitive fields/navigation/drag remain manual-only because the action recorder
 * intentionally does not retain their plaintext input.
 */
import { randomUUID } from "node:crypto";
import type { SafeActionRecord } from "./chromeCdpActionRecorder.js";

export type WorkflowStep = {
  sequence: number;
  action: SafeActionRecord["action"];
  mode: "cursor" | "approval" | "manual";
  status: "pending" | "consumed" | "skipped";
  hasBoundClick: boolean;
};
type Workflow = {
  id: string;
  key: string;
  actorId: string;
  generation: string;
  recordingId: string;
  startedAt: number;
  expiresAt: number;
  steps: WorkflowStep[];
  index: number;
};
const TTL_MS = 5 * 60_000;
const CAPACITY = 16;
const workflows = new Map<string, Workflow>();
const scopeKey = (key: string, actor: string) => key + "\0" + actor;

function sweep() {
  for (const [key, workflow] of workflows) {
    if (workflow.expiresAt <= Date.now()) workflows.delete(key);
  }
}
function snapshot(workflow: Workflow) {
  const current = workflow.steps[workflow.index] ?? null;
  return {
    workflowId: workflow.id,
    recordingId: workflow.recordingId,
    expiresAt: workflow.expiresAt,
    completedCount: workflow.index,
    totalCount: workflow.steps.length,
    done: current === null,
    next: current ? { ...current } : null,
    // Only control category and step order; never page content or credentials.
    steps: workflow.steps.map(step => ({ ...step })),
  };
}
function get(key: string, actorId: string, generation: string, workflowId: string) {
  sweep();
  const workflow = workflows.get(scopeKey(key, actorId));
  if (!workflow || workflow.id !== workflowId ||
      workflow.generation !== generation) {
    throw new Error("Replay workflow is unavailable for this actor or target generation.");
  }
  return workflow;
}

export function startRecordedWorkflow(
  key: string, actorId: string, generation: string, recordingId: string,
  events: readonly SafeActionRecord[],
) {
  sweep();
  if (!key || !actorId || !generation || !recordingId ||
      !Array.isArray(events) || events.length < 1 || events.length > 128) {
    throw new Error("A stopped, bounded recording is required to start a workflow.");
  }
  const scope = scopeKey(key, actorId);
  if (!workflows.has(scope) && workflows.size >= CAPACITY)
    throw new Error("Replay workflow capacity reached.");
  const steps = events.map((event, index): WorkflowStep => {
    if (event.sequence !== index + 1 ||
        !["move_cursor", "click", "type", "navigate", "drag_and_drop", "scroll_cursor"]
          .includes(event.action)) {
      throw new Error("Recorded actions are not a valid monotonic workflow.");
    }
    const bound = event.action === "click" &&
      /^[a-f0-9]{64}$/.test(event.locatorDigest ?? "") &&
      /^[a-f0-9]{64}$/.test(event.pageDigest ?? "");
    return {
      sequence: event.sequence,
      action: event.action,
      mode: event.action === "move_cursor" && event.position ? "cursor" :
        bound ? "approval" : "manual",
      hasBoundClick: bound,
      status: "pending",
    };
  });
  const now = Date.now();
  const workflow: Workflow = {
    id: randomUUID(), key, actorId, generation, recordingId,
    startedAt: now, expiresAt: now + TTL_MS, steps, index: 0,
  };
  workflows.set(scope, workflow);
  return snapshot(workflow);
}
/** An active sequence cannot bypass its next-step order by omitting workflowId. */
export function activeRecordedWorkflowId(key: string, actorId: string, generation: string): string | null {
  sweep();
  const workflow = workflows.get(scopeKey(key, actorId));
  return workflow && workflow.generation === generation && workflow.index < workflow.steps.length
    ? workflow.id : null;
}
export function getRecordedWorkflow(
  key: string, actorId: string, generation: string, workflowId: string,
) {
  return snapshot(get(key, actorId, generation, workflowId));
}
export function assertNextWorkflowStep(
  key: string, actorId: string, generation: string, workflowId: string,
  sequence: number, mode: WorkflowStep["mode"],
) {
  const workflow = get(key, actorId, generation, workflowId);
  const next = workflow.steps[workflow.index];
  if (!next || next.sequence !== sequence || next.mode !== mode ||
      next.status !== "pending") {
    throw new Error("Replay step out of order or not executable; refresh workflow status.");
  }
  return { ...next };
}
/** The step is irrevocably consumed before the CDP input command is dispatched. */
export function consumeNextWorkflowStep(
  key: string, actorId: string, generation: string, workflowId: string,
  sequence: number, mode: WorkflowStep["mode"],
) {
  const next = assertNextWorkflowStep(key, actorId, generation, workflowId, sequence, mode);
  const workflow = get(key, actorId, generation, workflowId);
  workflow.steps[workflow.index] = { ...next, status: "consumed" };
  workflow.index++;
  return snapshot(workflow);
}
export function skipManualWorkflowStep(
  key: string, actorId: string, generation: string, workflowId: string,
  sequence: number, confirmed: boolean,
) {
  if (confirmed !== true) throw new Error("Skipping a manual replay step requires confirmation.");
  const next = assertNextWorkflowStep(key, actorId, generation, workflowId, sequence, "manual");
  const workflow = get(key, actorId, generation, workflowId);
  workflow.steps[workflow.index] = { ...next, status: "skipped" };
  workflow.index++;
  return snapshot(workflow);
}
/** Called from tests only; production stores are expiry-bounded and scope-bound. */
export function clearRecordedWorkflowTestState() { workflows.clear(); }
