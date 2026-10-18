import { randomUUID } from "node:crypto";
import type { SelfDevEventInput } from "./types.js";

export const MAX_TASK_EVIDENCE_REFERENCES = 50;

export interface AgentTaskEvidenceContext {
  taskId: string;
  sessionId: string;
  workspace: string;
}

export interface CommandVerificationEvidence {
  kind: "test_result" | "build_result";
  toolName: "bash" | "run_command";
  commandFamily: string;
  exitCode: number;
}

export function classifyVerificationCommand(command: string): Pick<CommandVerificationEvidence, "kind" | "commandFamily"> | undefined {
  const value = command.trim();
  // Never attribute success to just one part of a compound shell command.
  if (!value || /[\r\n;&|<>]/.test(value) || /(?:^|\s)--(?:help|version|list|dry-run)(?:\s|$)/i.test(value)) return undefined;

  const testCommands: Array<{ pattern: RegExp; family: string }> = [
    { pattern: /^(?:bun\s+x\s+vitest\s+run|bun\s+run\s+test|bun\s+test|npm\s+(?:test|run\s+test)|pnpm\s+(?:test|run\s+test|exec\s+vitest\s+run)|yarn\s+test|npx\s+vitest\s+run|vitest\s+run)(?:\s|$)/i, family: "vitest" },
    { pattern: /^(?:pytest|python(?:3)?\s+-m\s+pytest)(?:\s|$)/i, family: "pytest" },
    { pattern: /^cargo\s+test(?:\s|$)/i, family: "cargo" },
    { pattern: /^go\s+test(?:\s|$)/i, family: "go" },
  ];
  for (const candidate of testCommands) {
    if (candidate.pattern.test(value)) return { kind: "test_result", commandFamily: candidate.family };
  }

  const buildCommands: Array<{ pattern: RegExp; family: string }> = [
    { pattern: /^(?:bun\s+run\s+build|npm\s+run\s+build|pnpm\s+(?:run\s+build|build)|yarn\s+build)(?:\s|$)/i, family: "build-script" },
    { pattern: /^tsc(?:\s|$)/i, family: "typescript" },
    { pattern: /^cargo\s+build(?:\s|$)/i, family: "cargo" },
    { pattern: /^go\s+build(?:\s|$)/i, family: "go" },
  ];
  for (const candidate of buildCommands) {
    if (candidate.pattern.test(value)) return { kind: "build_result", commandFamily: candidate.family };
  }
  return undefined;
}
type EvidenceRecorder = (event: SelfDevEventInput) => Promise<boolean>;

interface ActiveTaskEvidence {
  context: AgentTaskEvidenceContext;
  evidenceIds: string[];
  pending: Set<Promise<void>>;
}

const activeEvidence = new WeakMap<object, ActiveTaskEvidence>();

async function recordWithSelfDev(event: SelfDevEventInput): Promise<boolean> {
  try {
    const { recordSelfDevEvent } = await import("./selfdevAgent.js");
    return await recordSelfDevEvent(event);
  } catch {
    return false;
  }
}

/** Start an evidence scope tied to one Agent task, not merely the whole session. */
export function beginAgentTaskEvidence(agent: object, context: AgentTaskEvidenceContext): void {
  if (!context.taskId.trim() || !context.sessionId.trim() || !context.workspace.trim()) {
    activeEvidence.delete(agent);
    return;
  }
  activeEvidence.set(agent, { context: { ...context }, evidenceIds: [], pending: new Set() });
}

/**
 * Queue only typed, bounded verification facts. The caller never supplies command
 * output or arbitrary metadata, and the evidence write never blocks tool execution.
 */
export function queueTaskVerificationEvidence(
  agent: object,
  fact: CommandVerificationEvidence,
  recorder: EvidenceRecorder = recordWithSelfDev,
): void {
  const state = activeEvidence.get(agent);
  if (!state || state.evidenceIds.length + state.pending.size >= MAX_TASK_EVIDENCE_REFERENCES) return;
  if (!Number.isSafeInteger(fact.exitCode) || !/^[a-z0-9._-]{1,40}$/i.test(fact.commandFamily)) return;

  const id = randomUUID();
  const passed = fact.exitCode === 0;
  const event: SelfDevEventInput = {
    id,
    ts: Date.now(),
    sessionId: state.context.sessionId,
    workspace: state.context.workspace,
    kind: fact.kind,
    summary: fact.kind === "test_result"
      ? `Test command ${passed ? "passed" : "failed"} (${fact.commandFamily})`
      : `Build command ${passed ? "succeeded" : "failed"} (${fact.commandFamily})`,
    evidence: [],
    tags: ["task-evidence", fact.kind, fact.toolName],
    payload: {
      taskId: state.context.taskId,
      commandFamily: fact.commandFamily,
      toolName: fact.toolName,
      exitCode: fact.exitCode,
      ...(fact.kind === "test_result" ? { passed } : { success: passed }),
    },
  };

  let pending!: Promise<void>;
  pending = Promise.resolve()
    .then(() => recorder(event))
    .then((recorded) => {
      if (recorded && activeEvidence.get(agent) === state) state.evidenceIds.push(id);
    })
    .catch(() => {
      // Evidence is optional and must not fail a user task.
    })
    .finally(() => {
      state.pending.delete(pending);
    });
  state.pending.add(pending);
}

/** Resolve after queued writes settle and return only the IDs actually persisted. */
export async function finishAgentTaskEvidence(agent: object): Promise<string[]> {
  const state = activeEvidence.get(agent);
  if (!state) return [];
  while (state.pending.size > 0) {
    await Promise.all([...state.pending]);
  }
  activeEvidence.delete(agent);
  return [...state.evidenceIds];
}
