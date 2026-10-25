/**
 * Phase 4i — offline ACK-based retention of encrypted recovery payloads.
 *
 * A matching application-level result ACK is REQUIRED. A durable journal
 * cleanup tombstone is written first, so a crash at any later point can be
 * safely retried without losing deduplication or authorizing tool execution.
 *
 * This service NEVER removes journal batch IDs, task evidence, or the key
 * material; it only releases encrypted result/intent entries by exact batch ID.
 */
import { MuseBatchJournal } from "./museBatchJournal.js";
import { MuseExecutionCheckpoint } from "./museExecutionCheckpoint.js";
import { MuseResultOutbox } from "./museResultOutbox.js";
import { MuseRecoveryOrchestrator } from "./museRecoveryOrchestrator.js";

export type RetentionStatus =
  | "eligible"
  | "not_acknowledged"
  | "retention_period"
  | "integrity_blocked"
  | "cleanup_incomplete"
  | "already_released";

export interface RetentionAssessment {
  batchId: string;
  status: RetentionStatus;
  reason: string;
  canPrune: boolean;
  resultPresent: boolean;
  intentPresent: boolean;
  cleanupTombstone: boolean;
}

export interface RetentionOutcome {
  batchId: string;
  releasedResult: boolean;
  releasedIntent: boolean;
  cleanupTombstone: boolean;
}

export class MuseRecoveryStorageLifecycle {
  private readonly recovery: MuseRecoveryOrchestrator;
  constructor(
    readonly journal: MuseBatchJournal,
    readonly execution: MuseExecutionCheckpoint,
    readonly outbox: MuseResultOutbox,
  ) {
    this.recovery = new MuseRecoveryOrchestrator(journal, execution, outbox);
  }
  static load(port: number, rootDir?: string): MuseRecoveryStorageLifecycle {
    return new MuseRecoveryStorageLifecycle(
      new MuseBatchJournal(port, rootDir),
      new MuseExecutionCheckpoint(port, rootDir),
      new MuseResultOutbox(port, rootDir),
    );
  }
  assess(batchId: string, minAgeDays = 7, now = Date.now()): RetentionAssessment {
    if (!Number.isSafeInteger(minAgeDays) || minAgeDays < 0 || minAgeDays > 3650) {
      throw new Error("Retention minAgeDays must be an integer between 0 and 3650");
    }
    const journal = this.journal.get(batchId);
    if (!journal) throw new Error("Unknown retention batch ID");
    const result = this.outbox.summaries().find(entry => entry.batchId === batchId);
    const intent = this.execution.info(batchId);
    const base = {
      batchId, resultPresent: Boolean(result), intentPresent: Boolean(intent),
      cleanupTombstone: journal.payloadReleasedAt !== undefined,
    };
    const decision = (status: RetentionStatus, reason: string): RetentionAssessment => ({
      ...base, status, reason,
      canPrune: status === "eligible" || status === "cleanup_incomplete",
    });
    const recovered = this.recovery.assess(batchId);
    if (recovered.decision === "integrity_blocked") {
      return decision("integrity_blocked", recovered.reason);
    }
    if (!journal.resultAck || recovered.decision !== "acknowledged") {
      return decision("not_acknowledged", "authenticated_result_receipt_required");
    }
    if (journal.payloadReleasedAt !== undefined) {
      return result || intent
        ? decision("cleanup_incomplete", "cleanup_tombstone_exists_finish_pending_deletions")
        : decision("already_released", "payload_released_journal_tombstone_retained");
    }
    if (!result) return decision("integrity_blocked", "result_payload_missing_without_cleanup_marker");
    if (!Number.isSafeInteger(now) || now < journal.resultAck.receivedAt) {
      return decision("integrity_blocked", "invalid_retention_clock");
    }
    const elapsed = now - journal.resultAck.receivedAt;
    if (elapsed < minAgeDays * 86_400_000) {
      return decision("retention_period", "minimum_receipt_age_not_reached");
    }
    return decision("eligible", "acknowledged_payload_retention_elapsed");
  }
  plan(minAgeDays = 7): RetentionAssessment[] {
    return this.journal.list().map(j => this.assess(j.batchId, minAgeDays));
  }
  /** Caller MUST exclusively own the offline per-port journal review lock. */
  pruneOne(batchId: string, minAgeDays = 7): RetentionOutcome {
    const assessment = this.assess(batchId, minAgeDays);
    if (!assessment.canPrune) throw new Error("Retention prune refused: " + assessment.reason);
    const journal = this.journal.get(batchId);
    if (!journal?.resultAck) throw new Error("Retention prune requires authenticated ACK");
    const digest = journal.resultAck.sha256;
    // Write durable deletion permission BEFORE modifying encrypted stores.
    this.journal.markPayloadReleased(batchId, digest);
    // Both mutations are idempotent. Crashing between these operations leaves
    // cleanup_incomplete; a future explicit invocation can finish safely.
    const releasedResult = this.outbox.releaseAcknowledgedPayload(batchId, digest);
    const releasedIntent = this.execution.releaseAcknowledgedIntent(batchId);
    return { batchId, releasedResult, releasedIntent, cleanupTombstone: true };
  }
}
