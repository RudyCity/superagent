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
  "schemaVersion" | "channel" | "taskId" | "sessionId" | "status" | "evidence" | "authorization" | "notification" | "updatedAt">;
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
  const candidates: UnifiedChannelTask[] = [];
  for (const job of delegateJobs) {
    if (delegateJobVisibleToWorkspace(job, workspace)) candidates.push(projectCliDelegate(job));
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
    .map(({ schemaVersion, channel, taskId, sessionId, status, evidence, authorization, notification, updatedAt }) =>
      ({ schemaVersion, channel, taskId: taskId.slice(0, 160), sessionId,
        status, evidence, authorization, notification, updatedAt }));
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
