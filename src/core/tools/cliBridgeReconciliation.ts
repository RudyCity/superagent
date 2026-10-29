import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { observeProcessId } from "./cliBridgeRecovery.js";
import { readProcessStartIdentity } from "./cliBridgeProcessIdentity.js";

export interface JobCheckpoint {
  checkpointId: string;
  jobId: string;
  timestamp: number;
  lastEvent: string;
  worktreePath?: string;
  branchName?: string;
  resourceClaims: string[];
  ownerProcessIdentity?: string;
  childProcessIdentity?: string;
  verificationState: string;
  hasMutatingWrite: boolean;
  isMutating?: boolean;
}

/**
 * Validate every durable field before relying on checkpoint data.  Files from
 * older or partially written versions are NOT proof of a safe restart.
 */
export function isValidJobCheckpoint(value: unknown, expectedJobId?: string): value is JobCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cp = value as Record<string, unknown>;
  if (!isValidJobId(cp.jobId) || (expectedJobId && cp.jobId !== expectedJobId)) return false;
  if (typeof cp.checkpointId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(cp.checkpointId)) return false;
  if (typeof cp.timestamp !== "number" || !Number.isSafeInteger(cp.timestamp) ||
      cp.timestamp <= 0 || cp.timestamp > Date.now() + 300_000) return false;
  if (typeof cp.lastEvent !== "string" || cp.lastEvent.length < 1 || cp.lastEvent.length > 256) return false;
  if (typeof cp.verificationState !== "string" || cp.verificationState.length < 1 ||
      cp.verificationState.length > 128) return false;
  if (typeof cp.hasMutatingWrite !== "boolean") return false;
  if (cp.isMutating !== undefined && typeof cp.isMutating !== "boolean") return false;
  if (!Array.isArray(cp.resourceClaims) ||
      cp.resourceClaims.some((item: unknown) => typeof item !== "string")) return false;
  for (const key of ["ownerProcessIdentity", "childProcessIdentity", "worktreePath", "branchName"]) {
    if (cp[key] !== undefined && typeof cp[key] !== "string") return false;
  }
  return true;
}

export interface ReconciledJobAssessment {
  jobId: string;
  previousStatus: string;
  reconciledStatus: string;
  eligibleForRetry: boolean;
  requiresReview: boolean;
  reason: string;
}

function checkpointRoot(): string {
  return process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR || path.join(os.tmpdir(), "superagent-cli-bridge-checkpoints-v1");
}

const CANONICAL_JOB_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export function isValidJobId(jobId: unknown): jobId is string {
  return typeof jobId === "string" && CANONICAL_JOB_ID_REGEX.test(jobId);
}

function resolveSecureCheckpointPath(jobId: string): string {
  if (!isValidJobId(jobId)) {
    throw new Error(`Invalid canonical jobId format: "${String(jobId)}". Must match ${CANONICAL_JOB_ID_REGEX}`);
  }
  const root = path.resolve(checkpointRoot());
  const resolved = path.resolve(root, `${jobId}.json`);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Path containment violation: checkpoint path for "${jobId}" escapes checkpoint root`);
  }
  return resolved;
}

export async function writeJobCheckpoint(checkpoint: JobCheckpoint): Promise<string> {
  const file = resolveSecureCheckpointPath(checkpoint.jobId);
  const root = path.dirname(file);
  await fs.mkdir(root, { recursive: true });
  const tmp = path.join(
    root,
    `.tmp.${checkpoint.jobId}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`
  );
  await fs.writeFile(tmp, JSON.stringify(checkpoint, null, 2), "utf8");
  await fs.rename(tmp, file);
  return file;
}

export async function readJobCheckpoint(jobId: string): Promise<JobCheckpoint | null> {
  try {
    const file = resolveSecureCheckpointPath(jobId);
    const raw = await fs.readFile(file, "utf8");
    const decoded: unknown = JSON.parse(raw);
    return isValidJobCheckpoint(decoded, jobId) ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Reconciles a job state after Bridge/Core restart or crash.
 * Invariant: Never blind retry of unknown mutating effects!
 */
export async function reconcileJobOnRestart(
  job: {
    jobId: string;
    status: string;
    pid: number | null;
    ownerPid?: number;
    childProcessIdentity?: string;
    hasMutatingWrite?: boolean;
    verificationState?: string;
  },
  checkpoint?: JobCheckpoint | null
): Promise<ReconciledJobAssessment> {
  const rawCheckpoint = checkpoint;
  checkpoint = isValidJobCheckpoint(rawCheckpoint, job.jobId) ? rawCheckpoint : null;
  // Terminal statuses that require operator review must strictly preserve requiresReview: true (P1-2 / P0-1)
  if (job.status === "unknown_outcome_review_required") {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "unknown_outcome_review_required",
      eligibleForRetry: false,
      requiresReview: true,
      reason: "Job previously reached terminal status 'unknown_outcome_review_required'; operator review required.",
    };
  }

  if (job.status === "verification_failed") {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "verification_failed",
      eligibleForRetry: false,
      requiresReview: true,
      reason: "Job previously reached terminal status 'verification_failed'; operator review required.",
    };
  }

  if (job.status === "permission_blocked") {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "permission_blocked",
      eligibleForRetry: false,
      requiresReview: true,
      reason: "Job was blocked by permission policy before restart. Automatic retry blocked; review permissions.",
    };
  }

  const safeTerminalStatuses = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];
  if (safeTerminalStatuses.includes(job.status)) {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: job.status,
      eligibleForRetry: false,
      requiresReview: false,
      reason: `Job already reached terminal status '${job.status}'.`,
    };
  }

  // Active job interrupted by host restart
  const childPid = job.pid;
  let childAlive = false;

  if (childPid !== null && childPid > 0) {
    const obs = observeProcessId(childPid);
    if (obs === "pid_present_unverified") {
      const birth = await readProcessStartIdentity(childPid);
      const expectedBirth = job.childProcessIdentity || checkpoint?.childProcessIdentity;
      if (expectedBirth && birth && birth === expectedBirth) {
        childAlive = true;
      }
    }
  }

  if (childAlive) {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "running",
      eligibleForRetry: false,
      requiresReview: false,
      reason: "Verified surviving child process detected; resuming observation.",
    };
  }

  // Crash during verifier execution
  if (checkpoint?.lastEvent?.startsWith("verifier_") || checkpoint?.verificationState === "verifying") {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "unknown_outcome_review_required",
      eligibleForRetry: false,
      requiresReview: true,
      reason: "Bridge crashed during verifier execution. Verification outcome is uncertain; operator review required.",
    };
  }

  // Prior permission block in checkpoint persists across restart
  if (checkpoint?.verificationState === "permission_blocked") {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "permission_blocked",
      eligibleForRetry: false,
      requiresReview: true,
      reason: "Job was blocked by permission policy before restart. Automatic retry blocked; review permissions.",
    };
  }

  // Child is dead: require durable, validated checkpoint whose jobId strictly matches job.jobId (P0-1)
  const isCheckpointValid = checkpoint !== null && checkpoint !== undefined;

  if (!isCheckpointValid) {
    // Missing, invalid, or mismatched checkpoint: FAIL CLOSED!
    // Never infer read-only without verifiable positive evidence; never trust in-memory job flags alone.
    const reason = "Job checkpoint missing, malformed, stale or jobId mismatch; cannot prove job was read-only. Automatic retry blocked; operator review required.";
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "unknown_outcome_review_required",
      eligibleForRetry: false,
      requiresReview: true,
      reason,
    };
  }

  // Check for contradictory verifier receipts
  const validCheckpoint = checkpoint as JobCheckpoint;
  const verificationState = validCheckpoint.verificationState;
  const lastEvent = validCheckpoint.lastEvent;

  const hasVerifiedState =
    verificationState === "verified" || verificationState === "artifacts_verified";
  const hasVerifiedEvent = lastEvent === "verified_succeeded";

  const hasFailedState =
    verificationState === "verification_failed" || verificationState === "failed";
  const hasFailedEvent =
    lastEvent === "verified_failed" || lastEvent === "verification_failed";

  const isVerifyingInProgress =
    verificationState === "verifying" ||
    (typeof lastEvent === "string" && lastEvent.startsWith("verifier_"));

  const hasVerifiedRollback =
    (checkpoint as any)?.rollbackState === "verified_clean" ||
    (checkpoint as any)?.verifiedRollback === true;

  const hasContradictoryVerifierReceipt =
    (hasVerifiedState && (hasFailedEvent || isVerifyingInProgress || hasVerifiedRollback)) ||
    (hasVerifiedEvent && (hasFailedState || isVerifyingInProgress || hasVerifiedRollback)) ||
    (hasVerifiedRollback && (hasVerifiedState || hasVerifiedEvent));

  if (hasContradictoryVerifierReceipt) {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "unknown_outcome_review_required",
      eligibleForRetry: false,
      requiresReview: true,
      reason: "Contradictory verifier receipts detected in checkpoint. Verification evidence cannot be reconciled; operator review required.",
    };
  }

  // Check for mutating operations
  const isMutating =
    job.hasMutatingWrite === true ||
    validCheckpoint.hasMutatingWrite === true ||
    validCheckpoint.isMutating === true ||
    (checkpoint as any).hadMutatingWrite === true;

  if (isMutating) {
    return {
      jobId: job.jobId,
      previousStatus: job.status,
      reconciledStatus: "unknown_outcome_review_required",
      eligibleForRetry: false,
      requiresReview: true,
      reason: "Bridge crashed during unverified mutating operation. Automatic retry blocked to prevent duplicate writes; operator review required.",
    };
  }

  // A flag in local JSON is not authenticated read-only proof. Until a
  // trusted, job-bound attestation producer exists, never auto-retry.
  // Fallback: cannot prove read-only
  return {
    jobId: job.jobId,
    previousStatus: job.status,
    reconciledStatus: "unknown_outcome_review_required",
    eligibleForRetry: false,
    requiresReview: true,
    reason: "Cannot prove job was read-only from checkpoint; automatic retry blocked; operator review required.",
  };
}
