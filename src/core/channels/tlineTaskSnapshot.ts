/**
 * Read-only, workspace-authorized task projection for T-Line's polling monitor.
 * This does not create a task runner or claim durable SSE replay.
 */
import { createHash, randomBytes } from "node:crypto";
import { canonicalCliWorkspace, delegateJobVisibleToWorkspace } from "../tools/cliBridgeWorkspaceScope.js";
import { projectCliDelegate, projectDaemonRun, projectMuseRemoteTask, type UnifiedChannelTask } from "./unifiedChannelTask.js";
import type { DelegateJob } from "../tools/cliBridgeDelegateJobs.js";
import type { DaemonRunRecord } from "../daemon/daemonTypes.js";
import type { MuseRemoteTaskSnapshot } from "./unifiedChannelTask.js";

const runtimeGeneration = randomBytes(8).toString("hex");
const MAX_TASKS = 60;
const MAX_CURSOR = 64;

export type TlineTaskSummary = Pick<UnifiedChannelTask,
  "schemaVersion" | "channel" | "taskId" | "sessionId" | "status" | "evidence" | "authorization" | "notification" | "updatedAt"> &
  { cancelEligible?: boolean; retryEligible?: boolean };
export interface TlineTaskSnapshot {
  success: true;
  schemaVersion: 1;
  scope: "workspace";
  source: "bounded-polling";
  changed: boolean;
  cursor: string;
  tasks?: TlineTaskSummary[];
  total: number;
  incompleteSources: string[];
  /** No native SSE replay or exit validation is implied. */
  replaySupported: false;
}

function sameLocalWorkspace(candidate: string, caller: string): boolean {
  // Only existing, canonical directories; no prefix matching or symlink alias escape.
  try { return canonicalCliWorkspace(candidate) === canonicalCliWorkspace(caller); }
  catch { return false; }
}

export function selectTlineWorkspaceTasks(
  workspace: string,
  delegateJobs: DelegateJob[],
  daemonRuns: DaemonRunRecord[],
  muse: MuseRemoteTaskSnapshot | null,
  callerSessionId?: string,
): TlineTaskSummary[] {
  const candidates: (UnifiedChannelTask & { cancelEligible?: boolean; retryEligible?: boolean })[] = [];
  for (const job of delegateJobs) {
    if (delegateJobVisibleToWorkspace(job, workspace)) candidates.push({
      ...projectCliDelegate(job),
      // Display-only eligibility hint; the mutation endpoint independently
      // verifies ownership, process handle, exact session and one-use challenge.
      retryEligible: process.env.SUPERAGENT_TLINE_TASK_RETRY === "1" &&
        Boolean(callerSessionId) && job.creator?.clientMode === "tline" &&
        job.creator.sessionId === callerSessionId &&
        sameLocalWorkspace(job.creator.workspace, workspace) &&
        job.status === "verification_failed" && job.completionState === "artifact_verification_failed" &&
        ["codex", "claude"].includes(job.cliAlias) &&
        Array.isArray(job.expectedArtifacts) && job.expectedArtifacts.length > 0 &&
        Array.isArray(job.artifactEvidence) &&
        job.artifactEvidence.length === job.expectedArtifacts.length &&
        job.artifactEvidence.every(e => e.state === "missing" || e.state === "unchanged"),
      cancelEligible: process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL === "1" &&
        Boolean(callerSessionId) && job.creator?.clientMode === "tline" &&
        job.creator.sessionId === callerSessionId &&
        sameLocalWorkspace(job.creator.workspace, workspace) &&
        job.ownerPid === process.pid && job.status === "running",
    });
  }
  for (const run of daemonRuns) {
    if (sameLocalWorkspace(run.workspacePath, workspace)) candidates.push(projectDaemonRun(run));
  }
  if (muse && sameLocalWorkspace(muse.workspace, workspace)) {
    const projected = projectMuseRemoteTask(muse, "tline");
    candidates.push({
      ...projected,
      // A workspace match doesn't confer ownership over a different chat session.
      sessionId: callerSessionId && muse.sessionId === callerSessionId ? muse.sessionId : null,
    });
  }
  return candidates
    .sort((a, b) => b.updatedAt - a.updatedAt || a.taskId.localeCompare(b.taskId))
    .slice(0, MAX_TASKS)
    .map(({ schemaVersion, channel, taskId, sessionId, status, evidence, authorization, notification, updatedAt, cancelEligible, retryEligible }) =>
      ({ schemaVersion, channel, taskId: taskId.slice(0, 160), sessionId,
        status, evidence, authorization, notification, updatedAt,
        ...(channel === "cli" ? { cancelEligible: cancelEligible === true, retryEligible: retryEligible === true } : {}) }));
}

export function buildTlineTaskSnapshot(
  workspace: string,
  tasks: TlineTaskSummary[],
  incompleteSources: string[],
  knownCursor?: string,
): TlineTaskSnapshot {
  const failures = [...new Set(incompleteSources)].sort();
  const payload = JSON.stringify({ runtimeGeneration, workspace, tasks, failures });
  const cursor = createHash("sha256").update(payload).digest("hex").slice(0, MAX_CURSOR);
  const changed = knownCursor !== cursor;
  return {
    success: true, schemaVersion: 1, scope: "workspace",
    source: "bounded-polling", changed, cursor,
    ...(changed ? { tasks } : {}),
    total: tasks.length, incompleteSources: failures,
    replaySupported: false,
  };
}
