/**
 * Phase 4h — read-only recovery decision engine for managed Muse channel hosts.
 * Source of truth: durable batch journal + authenticated encrypted checkpoints.
 *
 * Important: this engine NEVER executes or resumes tools, sends results,
 * reconciles effects, clears locks, or mutates any persistence.
 */
import { MuseBatchJournal } from "./museBatchJournal.js";
import { MuseExecutionCheckpoint } from "./museExecutionCheckpoint.js";
import { MuseResultOutbox } from "./museResultOutbox.js";

export type RecoveryDecision =
  | "acknowledged"
  | "externally_reviewed"
  | "manual_result_replay"
  | "manual_untouched_resume"
  | "workspace_unverified"
  | "reservation_spent"
  | "manual_reconciliation"
  | "integrity_blocked";

export interface RecoveryAssessment {
  batchId: string;
  taskId: string | null;
  decision: RecoveryDecision;
  reason: string;
  /** These mean permission to ask for a guarded operation, never permission to run it automatically. */
  canRequestResultReplay: boolean;
  canRequestUntouchedResume: boolean;
  startedCalls: number;
  unfinishedCalls: number;
  acknowledged: boolean;
}

export interface RecoveryReport {
  port: number;
  total: number;
  counts: Record<RecoveryDecision, number>;
  batches: RecoveryAssessment[];
}

const emptyCounts = (): Record<RecoveryDecision, number> => ({
  acknowledged: 0,
  externally_reviewed: 0,
  manual_result_replay: 0,
  manual_untouched_resume: 0,
  workspace_unverified: 0,
  reservation_spent: 0,
  manual_reconciliation: 0,
  integrity_blocked: 0,
});

export class MuseRecoveryOrchestrator {
  constructor(
    private readonly journal: MuseBatchJournal,
    private readonly execution: MuseExecutionCheckpoint,
    private readonly outbox: MuseResultOutbox,
  ) {
    if (journal.ownerPort !== execution.port || journal.ownerPort !== outbox.port) {
      throw new Error("Recovery checkpoint owner port mismatch");
    }
  }
  static load(port: number, rootDir?: string) {
    return new MuseRecoveryOrchestrator(
      new MuseBatchJournal(port, rootDir),
      new MuseExecutionCheckpoint(port, rootDir),
      new MuseResultOutbox(port, rootDir),
    );
  }

  assess(batchId: string, watchedWorkspaces: string[] = []): RecoveryAssessment {
    const journal = this.journal.get(batchId);
    const exec = this.execution.info(batchId);
    const result = this.outbox.summaries().find(item => item.batchId === batchId);
    const base = {
      batchId,
      taskId: journal?.taskId ?? exec?.taskId ?? result?.taskId ?? null,
      startedCalls: exec?.started ?? 0,
      unfinishedCalls: exec ? exec.started - exec.finished : 0,
      acknowledged: Boolean(journal?.resultAck),
    };
    const make = (decision: RecoveryDecision, reason: string): RecoveryAssessment => ({
      ...base, decision, reason,
      canRequestResultReplay: decision === "manual_result_replay",
      canRequestUntouchedResume: decision === "manual_untouched_resume",
    });

    if (!journal) return make("integrity_blocked", "orphan_checkpoint_without_journal");
    if (exec && (exec.taskId !== journal.taskId || exec.total !== journal.callsCount)) {
      return make("integrity_blocked", "execution_checkpoint_identity_mismatch");
    }
    if (result && result.taskId !== journal.taskId) {
      return make("integrity_blocked", "result_outbox_identity_mismatch");
    }
    if (journal.payloadReleasedAt !== undefined && !journal.resultAck) {
      return make("integrity_blocked", "cleanup_marker_without_receipt");
    }
    if (journal.resultAck && ((!result && journal.payloadReleasedAt === undefined) ||
        (result && journal.resultAck.sha256 !== result.sha256))) {
      return make("integrity_blocked", "receipt_outbox_mismatch");
    }
    if (result && journal.stage !== "result_pending" && journal.stage !== "delivered") {
      return make("integrity_blocked", "result_outbox_without_result_stage");
    }
    if (journal.review && journal.resultAck) {
      return make("integrity_blocked", "review_conflicts_with_receipt");
    }
    if (journal.review) return make("externally_reviewed", "immutable_external_effect_review");
    if (journal.resultAck) return make("acknowledged", journal.payloadReleasedAt === undefined
      ? "authenticated_peer_receipt" : "acknowledged_payload_release_recorded");
    if (result) return make("manual_result_replay", "encrypted_result_available_unacknowledged");
    if (journal.stage !== "started") {
      return make("manual_reconciliation", "result_absent_or_effects_uncertain");
    }
    if (!exec) return make("manual_reconciliation", "missing_execution_intent");
    if (exec.started > 0) return make("manual_reconciliation", "tool_invocation_already_started");
    if (exec.reserved) return make("reservation_spent", "one_shot_resume_already_reserved");
    if (!this.execution.isWorkspaceAuthorized(batchId, watchedWorkspaces)) {
      return make("workspace_unverified", "original_workspace_not_verified");
    }
    return make("manual_untouched_resume", "no_tool_attempted_and_workspace_verified");
  }

  report(watchedWorkspaces: string[] = []): RecoveryReport {
    const ids = new Set([
      ...this.journal.list().map(item => item.batchId),
      ...this.execution.summaries().map(item => item.batchId),
      ...this.outbox.summaries().map(item => item.batchId),
    ]);
    const batches = [...ids].map(id => this.assess(id, watchedWorkspaces));
    const counts = emptyCounts();
    for (const batch of batches) counts[batch.decision]++;
    return { port: this.journal.ownerPort, total: batches.length, counts, batches };
  }
}
