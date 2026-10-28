/**
 * Hermes Phase 5: shared, read-only result envelope for existing execution
 * channels. This is a projection; it is NOT an authority, capability grant or
 * replacement for original per-channel durable ledgers.
 */
import type { DelegateJob } from "../tools/cliBridgeDelegateJobs.js";
import type { DaemonRunRecord } from "../daemon/daemonTypes.js";
import { redactMemorySecrets } from "../memoryLifecycle.js";

export type ExecutionChannel = "cli" | "tline" | "gateway" | "daemon" | "mcp" | "tunnel";
export type UnifiedTaskStatus =
  | "queued" | "running" | "succeeded" | "failed" | "partial" | "cancelled" | "interrupted";
export type UnifiedEvidence = "verified" | "unverified" | "failed" | "not_applicable";
export type UnifiedNotificationStatus = "not_configured" | "pending" | "delivered" | "failed";
export type UnifiedAuthorization = "workspace_scoped" | "daemon_policy_snapshot" | "transport_not_authorization";

export interface UnifiedChannelTask {
  readonly schemaVersion: 1;
  readonly channel: ExecutionChannel;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly workspace: string;
  readonly status: UnifiedTaskStatus;
  readonly evidence: UnifiedEvidence;
  readonly authorization: UnifiedAuthorization;
  readonly notification: UnifiedNotificationStatus;
  /** Only a bounded, redacted summary; never a conversation history. */
  readonly summary: string | null;
  readonly updatedAt: number;
}

const MAX_SUMMARY_CHARS = 600;
function summary(text: unknown): string | null {
  if (typeof text !== "string" || !text.trim()) return null;
  return redactMemorySecrets(text).slice(0, MAX_SUMMARY_CHARS);
}

function daemonStatus(status: DaemonRunRecord["status"]): UnifiedTaskStatus {
  switch (status) {
    case "success": return "succeeded";
    case "error": case "timed_out": return "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
    case "queued": return "queued";
    case "running": return "running";
  }
}
function cliStatus(status: DelegateJob["status"]): UnifiedTaskStatus {
  switch (status) {
    case "succeeded": return "succeeded";
    case "failed": case "timed_out": case "verification_failed": case "permission_blocked": return "failed";
    case "cancelled": return "cancelled";
    case "interrupted": return "interrupted";
    case "starting": case "queued": return "queued";
    case "running": case "cancelling": return "running";
    default: return "failed";
  }
}

export function projectDaemonRun(run: DaemonRunRecord): UnifiedChannelTask {
  return {
    schemaVersion: 1, channel: "daemon", taskId: run.runId,
    // A daemon attempt is not an interactive session. Never adopt a caller-
    // supplied session ID from a notification or a transport message.
    sessionId: null, projectId: run.projectId, workspace: run.workspacePath,
    status: daemonStatus(run.status),
    evidence: run.status === "success" ? "unverified" :
      run.status === "error" || run.status === "timed_out" ? "failed" : "not_applicable",
    authorization: "daemon_policy_snapshot",
    notification: run.notificationStatus ?? "not_configured",
    summary: summary(run.outputSummary ?? run.errorMessage),
    updatedAt: run.completedAt ?? run.startedAt,
  };
}

export function projectCliDelegate(job: DelegateJob): UnifiedChannelTask {
  return {
    schemaVersion: 1, channel: "cli", taskId: job.jobId,
    sessionId: null, projectId: null, workspace: job.workspaceRoot ?? job.cwd,
    status: cliStatus(job.status),
    evidence: job.completionState === "artifacts_verified" ? "verified" :
      job.completionState === "artifact_verification_failed" || job.completionState === "failed" || job.completionState === "permission_blocked" ?
        "failed" : "unverified",
    authorization: "workspace_scoped", notification: "not_configured",
    summary: summary(job.error ?? job.outputTail),
    updatedAt: job.updatedAt,
  };
}

export interface MuseRemoteTaskSnapshot {
  readonly taskId: string;
  readonly sessionId: string;
  readonly workspace: string;
  readonly startedAt: number;
}

/** Project only an already workspace-authorized, in-memory Muse task.
 * The source state is volatile and does not attest output correctness.
 */
export function projectMuseRemoteTask(
  task: MuseRemoteTaskSnapshot,
  channel: "cli" | "tline",
): UnifiedChannelTask {
  return {
    schemaVersion: 1, channel, taskId: task.taskId, sessionId: task.sessionId,
    projectId: null, workspace: task.workspace, status: "running",
    evidence: "unverified", authorization: "transport_not_authorization",
    notification: "not_configured", summary: null, updatedAt: task.startedAt,
  };
}

export interface MuseWatcherTaskSnapshot {
  readonly taskId: string;
  readonly workspace: string;
  readonly startedAt: number;
}

/** Watcher envelopes need not carry a session identity. Never invent one. */
export function projectMuseWatcherTask(task: MuseWatcherTaskSnapshot): UnifiedChannelTask {
  return {
    schemaVersion: 1, channel: "tline", taskId: task.taskId,
    sessionId: null, projectId: null, workspace: task.workspace,
    status: "running", evidence: "unverified",
    authorization: "transport_not_authorization",
    notification: "not_configured", summary: null, updatedAt: task.startedAt,
  };
}

/** An inbound message never grants privileges. Trusted server policy must be
 * evaluated separately at the actual mutation entry-point. */
export type ChannelOperation = "read" | "write" | "privileged";
export interface ChannelAuthority {
  /** Must be established by server session / OS owner, not request payload. */
  readonly trustedIdentity: boolean;
  readonly workspaceAuthorized: boolean;
  readonly allowWrite: boolean;
  readonly allowPrivileged: boolean;
  readonly unattended: boolean;
  readonly approvedByOwner: boolean;
}
export function authorizeChannelOperation(
  operation: ChannelOperation,
  authority: ChannelAuthority,
): { allowed: boolean; reason: string } {
  if (!authority.trustedIdentity) return { allowed: false, reason: "trusted channel identity required" };
  if (!authority.workspaceAuthorized) return { allowed: false, reason: "workspace authorization required" };
  if (operation === "read") return { allowed: true, reason: "workspace scoped read" };
  if (operation === "privileged" && !authority.allowPrivileged) return { allowed: false, reason: "privileged capability not granted" };
  if (!authority.allowWrite) return { allowed: false, reason: "write capability not granted" };
  if (!authority.approvedByOwner || authority.unattended) {
    return { allowed: false, reason: "trusted out-of-band owner approval required for channel mutation" };
  }
  return { allowed: true, reason: "explicit owner-approved capability" };
}
