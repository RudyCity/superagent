/**
 * Read-only policy for Core after reboot or total worker loss. An audit never
 * purges a checkpoint, recycles a PID or replays a previously accepted turn.
 */
export type CoreColdCheckpoint = "absent" | "valid" | "corrupt" | "unreadable";
export type CoreColdWorkerEvidence = "none" | "verified_alive" | "all_dead" | "unknown";
export type CoreColdDecision =
  "already_running" | "recover_verified_survivors" | "fresh_guard_allowed" |
  "operator_review" | "blocked";
export interface CoreColdSnapshot {
  ownerOnline: boolean;
  foreignListenerDetected: boolean;
  discoveryPresent: boolean;
  guardianLeasePresent: boolean;
  checkpoint: CoreColdCheckpoint;
  workers: CoreColdWorkerEvidence;
  /** null = unavailable, never interpret unknown as 0. */
  ambiguousTurns: number | null;
  /** Durable session metadata files, not external tool-effect receipts. */
  persistedReceipts: number | null;
  /** Number of session receipts that reference an accepted turn, when audited. */
  receiptsWithAcceptedTurn?: number | null;
  /** True only when every receipt is structurally valid and passive/safely classified. */
  sessionReceiptsReconciled?: boolean;
  externalEffectsReconciled: boolean;
}
export interface CoreColdAssessment {
  decision: CoreColdDecision;
  reasons: string[];
  automaticToolReplay: false;
  mayDeleteCheckpoint: false;
}
export function assessCoreColdStart(s: CoreColdSnapshot): CoreColdAssessment {
  const result = (decision: CoreColdDecision, ...reasons: string[]): CoreColdAssessment => ({
    decision, reasons, automaticToolReplay: false, mayDeleteCheckpoint: false,
  });
  if (s.ownerOnline) return result("already_running", "AUTHENTICATED_SUPERVISOR_ONLINE");
  if (s.foreignListenerDetected) return result("blocked", "UNKNOWN_PUBLIC_PORT_OWNER");
  if (s.checkpoint === "corrupt" || s.checkpoint === "unreadable")
    return result("blocked", "CHECKPOINT_INTEGRITY_FAILED");
  if (s.guardianLeasePresent)
    return result("operator_review", "GUARDIAN_LEASE_NEEDS_OWNER_VERIFICATION");
  if (s.checkpoint === "valid")
    return s.workers === "verified_alive"
      ? result("recover_verified_survivors", "ORIGINAL_WORKER_IDENTITY_MUST_BE_VERIFIED")
      : result("operator_review", s.workers === "all_dead"
        ? "ORIGINAL_WORKERS_DEAD_NO_REPLAY" : "WORKER_OWNERSHIP_UNKNOWN");
  if (s.discoveryPresent) return result("operator_review", "DISCOVERY_WITHOUT_CHECKPOINT");
  if (s.workers !== "none") return result("operator_review", "UNKNOWN_WORKER_STATE");
  if (s.ambiguousTurns === null || s.persistedReceipts === null ||
      !Number.isSafeInteger(s.ambiguousTurns) || s.ambiguousTurns < 0 ||
      !Number.isSafeInteger(s.persistedReceipts) || s.persistedReceipts < 0)
    return result("blocked", "DURABLE_EVIDENCE_UNAVAILABLE");
  if (s.ambiguousTurns > 0) return result("operator_review", "UNRESOLVED_CHAT_TURNS");
  // Session receipts are durable routing/resume metadata. Their existence alone
  // is not evidence of an outstanding external side effect. Older snapshots
  // without reconciliation metadata remain fail-closed.
  if (s.persistedReceipts > 0 && s.sessionReceiptsReconciled !== true)
    return result("operator_review", "SESSION_RECEIPTS_REQUIRE_RECONCILIATION");
  if (!s.externalEffectsReconciled) return result("operator_review", "SIDE_EFFECT_REVIEW_REQUIRED");
  return result("fresh_guard_allowed", "CLEAN_AND_VERIFIED_NAMESPACE");
}
