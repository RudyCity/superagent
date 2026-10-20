/**
 * Opt-in local workspace-operator cancellation for owned CLI Bridge jobs.
 * A workspace is NOT creator provenance; therefore this feature defaults OFF
 * and must be explicitly enabled by the local SuperAgent operator.
 * No daemon, Muse, shell, arbitrary PID, or retry execution is supported.
 */
import { randomBytes } from "node:crypto";
import { delegateJobVisibleToWorkspace } from "../tools/cliBridgeWorkspaceScope.js";
import { getDelegateJob, getDelegateJobRecovery, cancelDelegateJob,
  type DelegateJob } from "../tools/cliBridgeDelegateJobs.js";

const CHALLENGE_TTL = 30_000;
const MAX_PENDING = 48;
const JOB_ID = /^clj_\d{8,17}_[a-f0-9]{8}$/;
const SESSION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
type Pending = {
  workspace: string; sessionId: string; jobId: string;
  pid: number | null; startedAt: number; updatedAt: number; expiresAt: number;
};
const pending = new Map<string, Pending>();

export type CancelJobDeps = {
  getJob: (id: string) => Promise<DelegateJob | null>;
  getRecovery: (id: string) => Promise<{ assessment: string } | null>;
  cancel: (id: string) => Promise<{ ok: boolean; message: string }>;
  enabled: () => boolean;
  now: () => number;
};
const defaults: CancelJobDeps = {
  getJob: getDelegateJob,
  getRecovery: getDelegateJobRecovery,
  cancel: cancelDelegateJob,
  enabled: () => process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL === "1",
  now: () => Date.now(),
};
type Result = { status: number; body: { success: boolean; error?: string; challenge?: string;
  expiresInMs?: number; jobId?: string; requested?: boolean; note?: string } };

function error(status: number, reason: string): Result {
  return { status, body: { success: false, error: reason } };
}
function validScope(workspace: string, sessionId: string, jobId: string): boolean {
  return Boolean(workspace) && SESSION_ID.test(sessionId) && JOB_ID.test(jobId);
}
async function eligibleJob(workspace: string, sessionId: string, jobId: string, deps: CancelJobDeps) {
  const job = await deps.getJob(jobId);
  if (!job || !delegateJobVisibleToWorkspace(job, workspace)) return null;
  // Creator provenance must originate from the server dispatch context at
  // delegate.start time. Legacy/CLI/MCP jobs without provenance fail closed.
  if (job.creator?.clientMode !== "tline" || job.creator.sessionId !== sessionId ||
    !delegateJobVisibleToWorkspace({ cwd: job.creator.workspace, workspaceRoot: job.creator.workspace }, workspace))
    return null;
  if (job.status !== "running" || !Number.isSafeInteger(job.pid) || (job.pid ?? 0) <= 0 ||
    job.ownerPid !== process.pid) return null;
  const recovery = await deps.getRecovery(jobId);
  if (recovery?.assessment !== "owned_by_this_runtime") return null;
  return job;
}
export async function prepareTlineCancel(
  args: { workspace: string; sessionId: string; jobId: string },
  deps: CancelJobDeps = defaults,
): Promise<Result> {
  if (!deps.enabled()) return error(403, "TLine workspace cancellation is disabled by the local operator.");
  if (!validScope(args.workspace, args.sessionId, args.jobId)) return error(400, "Invalid task cancellation scope.");
  const job = await eligibleJob(args.workspace, args.sessionId, args.jobId, deps);
  if (!job) return error(403, "Job is not an active CLI process owned by this runtime and workspace.");
  const now = deps.now();
  for (const [key, value] of pending) if (value.expiresAt <= now) pending.delete(key);
  if (pending.size >= MAX_PENDING) return error(429, "Too many pending confirmations.");
  const challenge = randomBytes(24).toString("hex");
  pending.set(challenge, {
    workspace: args.workspace, sessionId: args.sessionId, jobId: args.jobId,
    pid: job.pid, startedAt: job.startedAt, updatedAt: job.updatedAt, expiresAt: now + CHALLENGE_TTL,
  });
  return { status: 200, body: { success: true, challenge, jobId: args.jobId,
    expiresInMs: CHALLENGE_TTL,
    note: "Only a cancellation request; task termination is not yet confirmed." } };
}
export async function confirmTlineCancel(
  args: { workspace: string; sessionId: string; jobId: string; challenge: string },
  deps: CancelJobDeps = defaults,
): Promise<Result> {
  if (!deps.enabled()) return error(403, "TLine workspace cancellation is disabled by the local operator.");
  if (!validScope(args.workspace, args.sessionId, args.jobId) ||
    !/^[a-f0-9]{48}$/.test(args.challenge)) return error(400, "Invalid confirmation.");
  const permit = pending.get(args.challenge);
  // Challenge is single-use, consumed before any process or filesystem I/O.
  pending.delete(args.challenge);
  if (!permit || permit.expiresAt <= deps.now() ||
    permit.workspace !== args.workspace || permit.sessionId !== args.sessionId ||
    permit.jobId !== args.jobId) return error(403, "Cancellation confirmation expired or belongs to another session.");
  const job = await eligibleJob(args.workspace, args.sessionId, args.jobId, deps);
  if (!job || job.pid !== permit.pid || job.startedAt !== permit.startedAt ||
    job.updatedAt !== permit.updatedAt) return error(409, "Task ownership/state changed; cancellation aborted.");
  const outcome = await deps.cancel(job.jobId);
  return outcome.ok
    ? { status: 202, body: { success: true, jobId: job.jobId, requested: true,
        note: "Cancellation requested; poll task status to verify exit." } }
    : error(409, "Task could not be cancelled; inspect its current status.");
}
export function __resetTlineCancelChallengesForTests(): void { pending.clear(); }
