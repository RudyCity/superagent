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


// ─── Slot recovery classification ──────────────────────────────────────────

export type CapacitySlotState =
  | "available"
  | "active_verified"
  | "owner_alive_child_alive"
  | "owner_dead_child_alive_review_required"
  | "owner_dead_child_dead_recoverable"
  | "identity_mismatch_blocked"
  | "corrupt_blocked";

export interface SlotOwnerMetadata {
  token: string;
  jobId: string;
  pid: number;
  ownerProcessIdentity?: string;
  childPid?: number;
  childProcessIdentity?: string;
  cliAlias?: string;
  workspaceDigest?: string;
  acquiredAt: number;
  heartbeatAt?: number;
}

export interface SlotClassificationInput {
  readonly exists: boolean;
  readonly isDir?: boolean;
  readonly isSymlink?: boolean;
  readonly ownerData?: Partial<SlotOwnerMetadata> | null;
  readonly corruptReason?: string;
  readonly ownerPidObservation?: PidObservation;
  readonly ownerIdentityObservation?: string | null;
  readonly childPidObservation?: PidObservation;
  readonly childIdentityObservation?: string | null;
  readonly jobStatus?: string | null;
  readonly ownedByCurrentRuntime?: boolean;
}

export interface CapacitySlotClassification {
  readonly state: CapacitySlotState;
  readonly occupied: boolean;
  readonly recoverable: boolean;
  readonly reason: string;
  readonly ownerPidObservation: PidObservation;
  readonly ownerIdentityComparison: ProcessIdentityComparison;
  readonly childPidObservation: PidObservation;
  readonly childIdentityComparison: ProcessIdentityComparison;
}

/**
 * Evaluates whether an occupied or unoccupied capacity slot can safely be
 * acquired or recovered. Fails closed on PID reuse, active descendants,
 * missing process identity, or corrupt metadata.
 */
export function classifyCapacitySlot(input: SlotClassificationInput): CapacitySlotClassification {
  if (!input.exists) {
    return {
      state: "available",
      occupied: false,
      recoverable: false,
      reason: "Capacity slot is unoccupied and available.",
      ownerPidObservation: "pid_absent",
      ownerIdentityComparison: "unknown",
      childPidObservation: "pid_absent",
      childIdentityComparison: "unknown",
    };
  }

  if (input.isDir === false || input.isSymlink === true) {
    return {
      state: "corrupt_blocked",
      occupied: true,
      recoverable: false,
      reason: "Capacity slot entry is not a regular directory or is a symbolic link.",
      ownerPidObservation: "unknown",
      ownerIdentityComparison: "unknown",
      childPidObservation: "unknown",
      childIdentityComparison: "unknown",
    };
  }

  if (!input.ownerData || input.corruptReason) {
    return {
      state: "corrupt_blocked",
      occupied: true,
      recoverable: false,
      reason: input.corruptReason || "Slot owner metadata is unparseable or missing.",
      ownerPidObservation: "unknown",
      ownerIdentityComparison: "unknown",
      childPidObservation: "unknown",
      childIdentityComparison: "unknown",
    };
  }

  const { ownerData } = input;
  const ownerPid = typeof ownerData.pid === "number" && Number.isSafeInteger(ownerData.pid) && ownerData.pid > 0
    ? ownerData.pid
    : null;
  const childPid = typeof ownerData.childPid === "number" && Number.isSafeInteger(ownerData.childPid) && ownerData.childPid > 0
    ? ownerData.childPid
    : null;

  if (!ownerData.token || typeof ownerData.token !== "string" || !ownerData.jobId || ownerPid === null) {
    return {
      state: "corrupt_blocked",
      occupied: true,
      recoverable: false,
      reason: "Slot owner metadata is missing required token, valid owner PID, or jobId.",
      ownerPidObservation: "unknown",
      ownerIdentityComparison: "unknown",
      childPidObservation: "unknown",
      childIdentityComparison: "unknown",
    };
  }

  if (input.ownedByCurrentRuntime) {
    return {
      state: "active_verified",
      occupied: true,
      recoverable: false,
      reason: "Slot is actively held and owned by the current runtime process handle.",
      ownerPidObservation: "pid_present_unverified",
      ownerIdentityComparison: "matched_unverified",
      childPidObservation: childPid ? (input.childPidObservation ?? observeProcessId(childPid)) : "unknown",
      childIdentityComparison: "unknown",
    };
  }

  const ownerPidObs = input.ownerPidObservation ?? observeProcessId(ownerPid);
  const childPidObs = input.childPidObservation ?? (childPid !== null ? observeProcessId(childPid) : "pid_absent");
  const ownerIdComp = compareProcessStartIdentity(ownerData.ownerProcessIdentity, input.ownerIdentityObservation);
  const childIdComp = compareProcessStartIdentity(ownerData.childProcessIdentity, input.childIdentityObservation);

  if (ownerPidObs === "pid_present_unverified" && ownerIdComp === "mismatch") {
    return {
      state: "identity_mismatch_blocked",
      occupied: true,
      recoverable: false,
      reason: "Owner PID is present but process start identity differs from saved owner (suspected PID reuse); do not signal or unlock.",
      ownerPidObservation: ownerPidObs,
      ownerIdentityComparison: ownerIdComp,
      childPidObservation: childPidObs,
      childIdentityComparison: childIdComp,
    };
  }

  if (childPidObs === "pid_present_unverified" && childIdComp === "mismatch") {
    return {
      state: "identity_mismatch_blocked",
      occupied: true,
      recoverable: false,
      reason: "Child PID is present but process start identity differs from saved child (suspected PID reuse); do not signal or unlock.",
      ownerPidObservation: ownerPidObs,
      ownerIdentityComparison: ownerIdComp,
      childPidObservation: childPidObs,
      childIdentityComparison: childIdComp,
    };
  }

  if (ownerPidObs === "pid_present_unverified") {
    if (childPidObs === "pid_present_unverified") {
      const state = (ownerIdComp === "matched_unverified" && childIdComp === "matched_unverified")
        ? "active_verified"
        : "owner_alive_child_alive";
      return {
        state,
        occupied: true,
        recoverable: false,
        reason: "Both owner process and child process are alive in the OS; slot is actively occupied.",
        ownerPidObservation: ownerPidObs,
        ownerIdentityComparison: ownerIdComp,
        childPidObservation: childPidObs,
        childIdentityComparison: childIdComp,
      };
    }

    return {
      state: ownerIdComp === "matched_unverified" ? "active_verified" : "owner_alive_child_alive",
      occupied: true,
      recoverable: false,
      reason: "Owner process is alive; slot is reserved and cannot be cleaned up.",
      ownerPidObservation: ownerPidObs,
      ownerIdentityComparison: ownerIdComp,
      childPidObservation: childPidObs,
      childIdentityComparison: childIdComp,
    };
  }

  if (ownerPidObs === "pid_absent") {
    // A missing child PID is not evidence that no CLI child (or detached
    // descendant) ever existed. Legacy/incomplete leases therefore fail closed
    // unless a persisted terminal job state independently proves the bridge
    // observed completion.
    if (childPid === null) {
      const terminalJob = typeof input.jobStatus === "string" &&
        !["starting", "running", "cancelling"].includes(input.jobStatus);
      if (terminalJob) {
        return {
          state: "owner_dead_child_dead_recoverable",
          occupied: true,
          recoverable: true,
          reason: "Owner is gone and the persisted job state is terminal; stale capacity metadata is safe to recover.",
          ownerPidObservation: ownerPidObs,
          ownerIdentityComparison: ownerIdComp,
          childPidObservation: "unknown",
          childIdentityComparison: "unknown",
        };
      }
      return {
        state: "corrupt_blocked",
        occupied: true,
        recoverable: false,
        reason: "Owner is absent but no child PID or terminal job evidence was recorded; child state is unknown and recovery is blocked.",
        ownerPidObservation: ownerPidObs,
        ownerIdentityComparison: ownerIdComp,
        childPidObservation: "unknown",
        childIdentityComparison: "unknown",
      };
    }

    if (childPidObs === "pid_present_unverified") {
      return {
        state: "owner_dead_child_alive_review_required",
        occupied: true,
        recoverable: false,
        reason: "Owner process has exited but CLI child process is still running; manual review required to avoid killing active work.",
        ownerPidObservation: ownerPidObs,
        ownerIdentityComparison: ownerIdComp,
        childPidObservation: childPidObs,
        childIdentityComparison: childIdComp,
      };
    }

    if (childPidObs === "pid_absent") {
      return {
        state: "owner_dead_child_dead_recoverable",
        occupied: true,
        recoverable: true,
        reason: "Both recorded owner process and CLI child process have exited; slot is a proven orphan and safe to recover.",
        ownerPidObservation: ownerPidObs,
        ownerIdentityComparison: ownerIdComp,
        childPidObservation: childPidObs,
        childIdentityComparison: childIdComp,
      };
    }

    return {
      state: "corrupt_blocked",
      occupied: true,
      recoverable: false,
      reason: "Owner is absent but child process state could not be determined; failing closed.",
      ownerPidObservation: ownerPidObs,
      ownerIdentityComparison: ownerIdComp,
      childPidObservation: childPidObs,
      childIdentityComparison: childIdComp,
    };
  }

  return {
    state: "corrupt_blocked",
    occupied: true,
    recoverable: false,
    reason: "Owner process liveness could not be determined; failing closed.",
    ownerPidObservation: ownerPidObs,
    ownerIdentityComparison: ownerIdComp,
    childPidObservation: childPidObs,
    childIdentityComparison: childIdComp,
  };
}
