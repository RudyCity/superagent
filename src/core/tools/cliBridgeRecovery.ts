/**
 * Read-only recovery assessment for CLI Bridge background jobs.
 *
 * A PID probe tells us whether the OS currently has that numeric PID, not
 * that it is the original process. PID reuse and surviving grandchildren
 * make auto-recovery or stale lock cleanup unsafe.
 */
import type { DelegateJob } from "./cliBridgeDelegateJobs.js";
import { compareProcessStartIdentity, type ProcessIdentityComparison } from "./cliBridgeProcessIdentity.js";

export type PidObservation = "pid_present_unverified" | "pid_absent" | "unknown";
export type RecoveryAssessment =
  | "terminal"
  | "owned_by_this_runtime"
  | "legacy_owner_unknown"
  | "owner_pid_present_unverified"
  | "owner_identity_matched_unverified"
  | "owner_identity_mismatch_manual_review"
  | "owner_pid_absent_manual_review"
  | "owner_pid_unknown_manual_review";

export interface DelegateRecoveryDiagnostic {
  readonly jobId: string;
  readonly persistedStatus: DelegateJob["status"];
  readonly assessment: RecoveryAssessment;
  readonly ownerPid: number | null;
  readonly ownerPidObservation: PidObservation;
  readonly childPid: number | null;
  readonly childPidObservation: PidObservation;
  /** Comparing birth metadata does not establish descendant-process safety. */
  readonly ownerIdentityComparison: ProcessIdentityComparison;
  readonly childIdentityComparison: ProcessIdentityComparison;
  readonly requiresManualReview: boolean;
  readonly reason: string;
}

export function observeProcessId(pid: number | null | undefined): PidObservation {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(pid, 0);
    return "pid_present_unverified";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "pid_absent";
    // Permission denied and platform-dependent errors are inconclusive.
    return "unknown";
  }
}

function active(status: DelegateJob["status"]): boolean {
  return status === "starting" || status === "running" || status === "cancelling";
}

/** Pure classification can be tested independently from OS process state. */
export function classifyDelegateRecovery(
  job: DelegateJob,
  options: {
    readonly ownedByCurrentRuntime?: boolean;
    readonly ownerPidObservation?: PidObservation;
    readonly childPidObservation?: PidObservation;
    readonly ownerIdentityObservation?: string | null;
    readonly childIdentityObservation?: string | null;
  } = {},
): DelegateRecoveryDiagnostic {
  const ownerPid = typeof job.ownerPid === "number" ? job.ownerPid : null;
  const childPid = typeof job.pid === "number" ? job.pid : null;
  const ownerPidObservation = options.ownerPidObservation ?? observeProcessId(ownerPid);
  const childPidObservation = options.childPidObservation ?? observeProcessId(childPid);
  const ownerIdentityComparison = compareProcessStartIdentity(job.ownerProcessIdentity, options.ownerIdentityObservation);
  const childIdentityComparison = compareProcessStartIdentity(job.childProcessIdentity, options.childIdentityObservation);
  let assessment: RecoveryAssessment;
  let reason: string;
  if (!active(job.status)) {
    assessment = "terminal";
    reason = "Stored job state is terminal. Inspect recorded exit/proof and output lock state separately.";
  } else if (options.ownedByCurrentRuntime) {
    assessment = "owned_by_this_runtime";
    reason = "This runtime owns the process handle; use delegate.get or delegate.cancel normally.";
  } else if (ownerPid === null) {
    assessment = "legacy_owner_unknown";
    reason = "No original owner PID was recorded. A running-looking legacy snapshot is not evidence of a live process.";
  } else if (ownerPidObservation === "pid_present_unverified" && ownerIdentityComparison === "mismatch") {
    assessment = "owner_identity_mismatch_manual_review";
    reason = "The PID is present but process start identity differs from the saved owner. PID reuse is suspected; do not signal or unlock.";
  } else if (ownerPidObservation === "pid_present_unverified" && ownerIdentityComparison === "matched_unverified") {
    assessment = "owner_identity_matched_unverified";
    reason = "Owner PID and start identity match the saved observation, but descendants and continued ownership remain unverified.";
  } else if (ownerPidObservation === "pid_present_unverified") {
    assessment = "owner_pid_present_unverified";
    reason = "The owner PID exists but may be reused; it does not verify the original owner process or its descendants.";
  } else if (ownerPidObservation === "pid_absent") {
    assessment = "owner_pid_absent_manual_review";
    reason = "The recorded owner PID is absent. CLI child/grandchild processes may still be writing; no automatic cancellation or lock removal.";
  } else {
    assessment = "owner_pid_unknown_manual_review";
    reason = "Owner PID presence could not be determined. No automatic cancellation or lock removal.";
  }
  return {
    jobId: job.jobId,
    persistedStatus: job.status,
    assessment, ownerPid, ownerPidObservation,
    childPid, childPidObservation,
    ownerIdentityComparison, childIdentityComparison,
    requiresManualReview: active(job.status) && !options.ownedByCurrentRuntime,
    reason,
  };
}
