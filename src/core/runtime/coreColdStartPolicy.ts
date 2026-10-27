/**
 * Read-only policy for Core after reboot or total worker loss. The auditor
 * never replays a previously accepted turn. A verified total runtime loss may
 * archive stale routing/owner files, but may never delete them in place.
 */
export type CoreColdCheckpoint = "absent" | "valid" | "corrupt" | "unreadable";
export type CoreColdWorkerEvidence = "none" | "verified_alive" | "all_dead" | "unknown";
export type CoreColdDecision =
  "already_running" | "recover_verified_survivors" | "fresh_guard_allowed" |
  "cold_reset_allowed" | "operator_review" | "blocked";

export interface CoreColdSnapshot {
  ownerOnline: boolean;
  foreignListenerDetected: boolean;
  discoveryPresent: boolean;
  guardianLeasePresent: boolean;
  /** True only when persisted discovery points to a dead supervisor/control port. */
  discoveryStale?: boolean;
  /** True only when the guardian lease PID is gone and no owner is online. */
  guardianLeaseStale?: boolean;
  checkpoint: CoreColdCheckpoint;
  workers: CoreColdWorkerEvidence;
  /** null = unavailable, never interpret unknown as 0. */
  ambiguousTurns: number | null;
  /** Durable session routing metadata files, not external-effect receipts. */
  persistedReceipts: number | null;
  /** Receipts that reference an accepted turn and therefore need deeper review. */
  receiptsWithAcceptedTurn?: number | null;
  sessionReceiptsReconciled?: boolean;
  externalEffectsReconciled: boolean;
}

export interface CoreColdAssessment {
  decision: CoreColdDecision;
  reasons: string[];
  automaticToolReplay: false;
  mayDeleteCheckpoint: false;
  /** Only stale runtime-control files may be moved into a protected archive. */
  mayArchiveStaleRuntime: boolean;
}

export function assessCoreColdStart(s: CoreColdSnapshot): CoreColdAssessment {
  const result = (
    decision: CoreColdDecision,
    mayArchiveStaleRuntime: boolean,
    ...reasons: string[]
  ): CoreColdAssessment => ({
    decision, reasons, automaticToolReplay: false, mayDeleteCheckpoint: false,
    mayArchiveStaleRuntime,
  });

  if (s.ownerOnline) return result("already_running", false, "AUTHENTICATED_SUPERVISOR_ONLINE");
  if (s.foreignListenerDetected) return result("blocked", false, "UNKNOWN_PUBLIC_PORT_OWNER");
  if (s.checkpoint === "corrupt" || s.checkpoint === "unreadable")
    return result("blocked", false, "CHECKPOINT_INTEGRITY_FAILED");

  if (s.ambiguousTurns === null || s.persistedReceipts === null ||
      !Number.isSafeInteger(s.ambiguousTurns) || s.ambiguousTurns < 0 ||
      !Number.isSafeInteger(s.persistedReceipts) || s.persistedReceipts < 0) {
    return result("blocked", false, "DURABLE_EVIDENCE_UNAVAILABLE");
  }
  if (s.ambiguousTurns > 0)
    return result("operator_review", false, "UNRESOLVED_CHAT_TURNS");
  if (s.persistedReceipts > 0 && s.sessionReceiptsReconciled !== true)
    return result("operator_review", false, "SESSION_RECEIPTS_REQUIRE_RECONCILIATION");
  if (!s.externalEffectsReconciled)
    return result("operator_review", false, "SIDE_EFFECT_REVIEW_REQUIRED");

  if (s.guardianLeasePresent && s.guardianLeaseStale !== true)
    return result("operator_review", false, "GUARDIAN_LEASE_NEEDS_OWNER_VERIFICATION");

  if (s.checkpoint === "valid") {
    if (s.workers === "verified_alive")
      return result("recover_verified_survivors", false, "ORIGINAL_WORKER_IDENTITY_VERIFIED");
    if (s.workers === "all_dead" &&
        (!s.discoveryPresent || s.discoveryStale === true) &&
        (!s.guardianLeasePresent || s.guardianLeaseStale === true)) {
      return result("cold_reset_allowed", true,
        "ALL_ORIGINAL_WORKERS_DEAD",
        "DURABLE_EFFECT_EVIDENCE_CLEAN",
        "STALE_RUNTIME_STATE_MUST_BE_ARCHIVED_NO_REPLAY");
    }
    return result("operator_review", false, "WORKER_OWNERSHIP_UNKNOWN");
  }

  if (s.discoveryPresent && s.discoveryStale !== true)
    return result("operator_review", false, "DISCOVERY_WITHOUT_CHECKPOINT");
  if (s.workers !== "none")
    return result("operator_review", false, "UNKNOWN_WORKER_STATE");

  if (s.discoveryPresent || s.guardianLeasePresent) {
    return result("cold_reset_allowed", true,
      "STALE_CONTROL_STATE_WITHOUT_CHECKPOINT",
      "DURABLE_EFFECT_EVIDENCE_CLEAN");
  }
  return result("fresh_guard_allowed", false, "CLEAN_AND_VERIFIED_NAMESPACE");
}
