/**
 * SuperAgent Process Reconciliation (M3 Foundation)
 *
 * Implements crash-safe, read-only process and job reconciliation on startup.
 *
 * Key safety invariants:
 * 1. Startup comparison connects persisted registry with live OS process table and creation identities.
 * 2. Classifications:
 *    - "terminal": process exited, terminated, failed, or PID absent from OS.
 *    - "currently_owned_live": proven owned by current runtime generation, PID alive, creation identity matched, owner live.
 *    - "orphan_candidate": proven owned by SuperAgent, owner dead/terminal, creation identity matched, stale lease past grace.
 *    - "historical": prior-generation process; diagnostic only, NEVER adopted.
 *    - "identity_mismatch": PID reused; creation identity mismatches recorded identity.
 *    - "unknown": identity or owner state unprovable from evidence.
 *    - "persistent_external": marked persistent or external; survives restart without being misclassified as orphan/leak.
 * 3. ZERO process adoption of prior generations; ZERO reliance on PID alone.
 * 4. ZERO automatic replay of prompts, ZERO auto-retry of ambiguous mutating jobs, ZERO reattachment to unknown stdin/stdout.
 * 5. Interrupted mutating jobs with uncertain outcome persist and return exactly 'unknown_outcome_review_required'.
 * 6. Purely read-only / report-only: NO kill, NO auto-reap.
 * 7. Positive evidence required; missing or uncertain evidence stays unknown.
 * 8. Strict workspace isolation: foreign workspace paths, job IDs, and arguments are redacted/masked.
 * 9. Fail-closed on corrupt registry or legacy schema without lifecycle.
 */

import {
  ProcessRegistry,
  getRuntimeGeneration,
  type ProcessRecord,
} from "./processRegistry.js";
import {
  readProcessStartIdentity,
  compareProcessStartIdentity,
} from "../tools/cliBridgeProcessIdentity.js";
import {
  observeProcessId,
  type PidObservation,
} from "../tools/cliBridgeRecovery.js";
import {
  readJobCheckpoint,
  writeJobCheckpoint,
  type JobCheckpoint,
} from "../tools/cliBridgeReconciliation.js";
import crypto from "node:crypto";
import path from "node:path";

export function normalizeWorkspacePath(ws?: string): string | undefined {
  if (!ws) return undefined;
  try {
    const resolved = path.resolve(ws);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return ws;
  }
}

export type ReconciliationClassification =
  | "terminal"
  | "currently_owned_live"
  | "orphan_candidate"
  | "historical"
  | "identity_mismatch"
  | "unknown"
  | "persistent_external";

export interface ReconciledJobAssessment {
  jobId: string;
  previousStatus?: string;
  reconciledStatus: string;
  hasMutatingWrite: boolean;
  requiresReview: boolean;
  eligibleForRetry: boolean;
  reason: string;
}

export interface ReconciledProcessEntry {
  recordId: string;
  pid: number | null;
  component: string;
  classification: ReconciliationClassification;
  lifecycle: string;
  cleanupPolicy: string;
  runtimeGeneration: string;
  isCurrentRuntime: boolean;
  workspaceRoot?: string;
  jobId?: string;
  sessionId?: string;
  isForeignWorkspace?: boolean;
  recommendedSafeAction: "observe" | "review" | "investigate_identity" | "none";
  reason: string;
  jobAssessment?: ReconciledJobAssessment;
}

export interface ProcessReconciliationReport {
  timestamp: number;
  runtimeGeneration: string;
  isCorrupt: boolean;
  corruptionReason?: string;
  totalRecords: number;
  counts: Record<ReconciliationClassification, number>;
  entries: ReconciledProcessEntry[];
  mutatingJobsRequiringReview: number;
  jobAssessments: ReconciledJobAssessment[];
}

export interface ProcessReconciliationOptions {
  callerWorkspaceRoot?: string;
  graceMs?: number;
  maxEntries?: number;
  persistInterruptedMutations?: boolean;
}

export interface ProcessReconciliationDependencies {
  now?: () => number;
  observePid?: (pid: number) => PidObservation | Promise<PidObservation>;
  readIdentity?: (pid: number) => Promise<string | null>;
  inspectOwner?: (record: Readonly<ProcessRecord>) => Promise<{ state: "live" | "terminal" | "unknown"; source: string }>;
  readJobCheckpoint?: (jobId: string) => Promise<JobCheckpoint | null>;
  persistCheckpoint?: (checkpoint: JobCheckpoint) => Promise<string>;
}

const ALL_CLASSIFICATIONS: ReconciliationClassification[] = [
  "terminal",
  "currently_owned_live",
  "orphan_candidate",
  "historical",
  "identity_mismatch",
  "unknown",
  "persistent_external",
];

const isRecordTerminal = (s: string): boolean =>
  s === "exited" || s === "failed" || s === "terminated";

const isCleanupEligible = (r: ProcessRecord): boolean =>
  (r.lifecycle === "ephemeral" || r.lifecycle === "job" || r.lifecycle === "session") &&
  (r.cleanupPolicy === "terminate_with_owner" || r.cleanupPolicy === "lease_managed");

/**
 * Inspects live owner state with positive authoritative evidence only.
 */
async function defaultInspectOwner(
  record: Readonly<ProcessRecord>
): Promise<{ state: "live" | "terminal" | "unknown"; source: string }> {
  if (record.runtimeGeneration !== getRuntimeGeneration()) {
    return { state: "unknown", source: "historical_generation_not_adopted" };
  }

  if (record.ownership?.jobId) {
    try {
      const { getDelegateJob } = await import("../tools/cliBridgeDelegateJobs.js");
      const job = await getDelegateJob(record.ownership.jobId);
      if (!job || job.cwd !== record.ownership.workspaceRoot || job.jobId !== record.ownership.jobId) {
        return { state: "unknown", source: "job_unavailable_or_scope_mismatch" };
      }
      const done = [
        "succeeded",
        "failed",
        "timed_out",
        "cancelled",
        "verification_failed",
        "permission_blocked",
        "unknown_outcome_review_required",
      ].includes(job.status);
      return { state: done ? "terminal" : "live", source: "cli_bridge_job_status" };
    } catch {
      return { state: "unknown", source: "job_inspection_failed" };
    }
  }

  if (record.ownership?.sessionId) {
    try {
      const { getSession } = await import("../tools/cliBridgeSession.js");
      const session = getSession(record.ownership.sessionId);
      if (!session || session.cwd !== record.ownership.workspaceRoot) {
        return { state: "unknown", source: "session_unavailable_or_scope_mismatch" };
      }
      return {
        state: session.status === "exited" || session.status === "errored" ? "terminal" : "live",
        source: "cli_bridge_session_status",
      };
    } catch {
      return { state: "unknown", source: "session_inspection_failed" };
    }
  }

  return { state: "unknown", source: "owner_job_or_session_not_proven" };
}

/**
 * Reconciles persisted processes with live OS process table and evaluates
 * crash-safe states for interrupted jobs and orphan candidates.
 */
export async function reconcileStartupProcesses(
  registry: ProcessRegistry,
  options: ProcessReconciliationOptions = {},
  deps: ProcessReconciliationDependencies = {}
): Promise<ProcessReconciliationReport> {
  const now = deps.now?.() ?? Date.now();
  const currentGen = getRuntimeGeneration();
  const graceMs = Math.max(1_000, options.graceMs ?? 30_000);
  const maxEntries = Math.max(0, Math.min(200, options.maxEntries ?? 100));

  const counts: Record<ReconciliationClassification, number> = Object.fromEntries(
    ALL_CLASSIFICATIONS.map((c) => [c, 0])
  ) as Record<ReconciliationClassification, number>;

  const report: ProcessReconciliationReport = {
    timestamp: now,
    runtimeGeneration: currentGen,
    isCorrupt: registry.isRegistryCorrupt(),
    corruptionReason: registry.getCorruptionReason(),
    totalRecords: 0,
    counts,
    entries: [],
    mutatingJobsRequiringReview: 0,
    jobAssessments: [],
  };

  // Fail closed if registry is corrupt
  if (report.isCorrupt) {
    return report;
  }

  const observe = deps.observePid ?? observeProcessId;
  const readIdentity = deps.readIdentity ?? readProcessStartIdentity;
  const inspectOwner = deps.inspectOwner ?? defaultInspectOwner;
  const readCheckpoint = deps.readJobCheckpoint ?? readJobCheckpoint;
  const persistCheckpoint = deps.persistCheckpoint ?? writeJobCheckpoint;

  const allRecords = registry.listRecords();

  for (const record of allRecords) {
    const callerWs = normalizeWorkspacePath(options.callerWorkspaceRoot);
    const recordWs = normalizeWorkspacePath(record.ownership?.workspaceRoot);

    // Strict multi-tenant workspace boundary (P0-2 / P1-4):
    // When callerWorkspaceRoot is specified, require EXACT match to record.ownership.workspaceRoot.
    // Records without workspaceRoot (missing/unspecified/ownerless) and records from other workspaces
    // MUST be completely omitted from all scoped entries, counts, owner probes, and checkpoint reads.
    if (callerWs && (!recordWs || recordWs !== callerWs)) {
      continue;
    }

    const isForeign = Boolean(callerWs && recordWs && callerWs !== recordWs);

    report.totalRecords++;

    let classification: ReconciliationClassification = "unknown";
    let reason = "Process status could not be conclusively determined.";
    let recommendedSafeAction: ReconciledProcessEntry["recommendedSafeAction"] = "observe";
    let jobAssessment: ReconciledJobAssessment | undefined;

    const pid = record.pid;
    const isCurrentRuntime = record.runtimeGeneration === currentGen;

    // 1. Terminal state check
    if (isRecordTerminal(record.state)) {
      classification = "terminal";
      reason = `Record is in terminal state '${record.state}'.`;
      recommendedSafeAction = "none";
    }
    // 2. Persistent / external service check
    else if (
      record.lifecycle === "persistent" ||
      record.lifecycle === "external" ||
      record.cleanupPolicy === "keep_alive" ||
      record.cleanupPolicy === "manual_only" ||
      record.cleanupPolicy === "manual"
    ) {
      classification = "persistent_external";
      reason = `Process is marked with lifecycle '${record.lifecycle}' and policy '${record.cleanupPolicy}'. Survives restart; never an orphan candidate.`;
      recommendedSafeAction = "observe";
    }
    // 3. Historical generation check: prior generations are NEVER adopted
    else if (!isCurrentRuntime) {
      if (typeof pid === "number" && pid > 0) {
        const presence = await Promise.resolve(observe(pid)).catch(() => "unknown" as PidObservation);
        if (presence === "pid_absent") {
          classification = "terminal";
          reason = `Historical process PID ${pid} is absent from OS process table.`;
          recommendedSafeAction = "none";
        } else if (presence === "pid_present_unverified") {
          const liveIdentity = await Promise.resolve(readIdentity(pid)).catch(() => null);
          const identityComp = compareProcessStartIdentity(record.creationIdentity, liveIdentity);
          if (identityComp === "mismatch") {
            classification = "identity_mismatch";
            reason = `Historical PID ${pid} is present, but creation identity mismatches recorded identity (PID reused).`;
            recommendedSafeAction = "investigate_identity";
          } else {
            classification = "historical";
            reason = `Historical record from prior runtime generation (${record.runtimeGeneration}). Report-only; never adopted.`;
            recommendedSafeAction = "observe";
          }
        } else {
          classification = "historical";
          reason = `Historical record from prior runtime generation (${record.runtimeGeneration}). Report-only; never adopted.`;
          recommendedSafeAction = "observe";
        }
      } else {
        classification = "historical";
        reason = `Historical record from prior runtime generation without valid PID.`;
        recommendedSafeAction = "observe";
      }
    }
    // 4. Current runtime generation check
    else if (typeof pid !== "number" || pid <= 0 || !record.creationIdentity) {
      classification = "unknown";
      reason = "Current runtime record has no valid PID or creation identity.";
      recommendedSafeAction = "review";
    } else {
      // Check live OS process state
      const presence = await Promise.resolve(observe(pid)).catch(() => "unknown" as PidObservation);
      if (presence === "pid_absent") {
        classification = "terminal";
        reason = `Recorded PID ${pid} is absent from the OS process table.`;
        recommendedSafeAction = "none";
      } else if (presence === "pid_present_unverified") {
        const liveIdentity = await Promise.resolve(readIdentity(pid)).catch(() => null);
        const check = registry.verifyOwnership(record.recordId, liveIdentity, presence);

        if (check.status === "identity_mismatch_blocked") {
          classification = "identity_mismatch";
          reason = `PID ${pid} is present, but process creation identity mismatches recorded identity. PID reuse suspected; ownership rejected.`;
          recommendedSafeAction = "investigate_identity";
        } else if (check.status === "verified_owner") {
          // Check owner liveness with positive evidence
          const ownerEvidence = await Promise.resolve(inspectOwner(record)).catch(
            () => ({ state: "unknown" as const, source: "owner_probe_failed" })
          );

          if (ownerEvidence.state === "live") {
            classification = "currently_owned_live";
            reason = `Process is actively owned by live ${ownerEvidence.source}.`;
            recommendedSafeAction = "observe";
          } else if (ownerEvidence.state === "terminal") {
            const heartbeatAgeMs =
              typeof record.heartbeatAt === "number" ? Math.max(0, now - record.heartbeatAt) : null;
            const isStaleLease = heartbeatAgeMs !== null && heartbeatAgeMs > graceMs;

            if (isCleanupEligible(record) && isStaleLease) {
              // Re-verify in second pass to avoid scan races (owner revived, heartbeat renewed, PID disappeared)
              const latest = registry.getRecord(record.recordId);
              const unchanged =
                latest &&
                !registry.isRegistryCorrupt() &&
                latest.pid === pid &&
                latest.creationIdentity === record.creationIdentity &&
                latest.runtimeGeneration === record.runtimeGeneration &&
                latest.heartbeatAt === record.heartbeatAt &&
                latest.state === record.state;

              if (unchanged) {
                const ownerAgain = await Promise.resolve(inspectOwner(latest)).catch(
                  () => ({ state: "unknown" as const, source: "owner_recheck_failed" })
                );
                const presenceAgain = await Promise.resolve(observe(pid)).catch(() => "unknown" as PidObservation);
                const identityAgain =
                  presenceAgain === "pid_present_unverified"
                    ? await Promise.resolve(readIdentity(pid)).catch(() => null)
                    : null;

                if (
                  ownerAgain.state === "terminal" &&
                  registry.verifyOwnership(record.recordId, identityAgain, presenceAgain).status === "verified_owner"
                ) {
                  classification = "orphan_candidate";
                  reason = `Verified SuperAgent-owned orphan candidate: owner is terminal, lease expired, creation identity confirmed.`;
                  recommendedSafeAction = "review";
                } else {
                  classification = "unknown";
                  reason = "Process state changed during two-pass verification; failing closed as unknown.";
                  recommendedSafeAction = "review";
                }
              } else {
                classification = "unknown";
                reason = "Record state mutated during verification; failing closed as unknown.";
                recommendedSafeAction = "review";
              }
            } else {
              classification = "unknown";
              reason = `Owner is terminal, but process is not cleanup-eligible or lease has not expired beyond grace period (${graceMs}ms).`;
              recommendedSafeAction = "review";
            }
          } else {
            classification = "unknown";
            reason = "Owner status could not be proven with positive evidence (never infer orphan from PID absence alone).";
            recommendedSafeAction = "review";
          }
        } else {
          classification = "unknown";
          reason = check.reason;
          recommendedSafeAction = "review";
        }
      } else {
        classification = "unknown";
        reason = `Presence of PID ${pid} could not be determined.`;
        recommendedSafeAction = "review";
      }
    }

    // 5. Job-Level Crash Reconciliation: Interrupted Mutating Jobs Check (P1-1 / P0 #2 / P1 #3)
    if (record.ownership?.jobId) {
      const jobId = record.ownership.jobId;
      try {
        const rawCheckpoint = await Promise.resolve(readCheckpoint(jobId)).catch(() => null);

        // Checkpoint integrity & positive schema verification (P0 #2):
        // Validate that checkpoint is a valid object and that checkpoint.jobId matches record.ownership.jobId.
        const isCheckpointValid =
          rawCheckpoint !== null &&
          typeof rawCheckpoint === "object" &&
          rawCheckpoint.jobId === jobId;

        const checkpoint: JobCheckpoint | null = isCheckpointValid ? rawCheckpoint : null;

        // Positive evidence required: never infer read-only without verifiable positive evidence.
        // A missing, null, or untrusted checkpoint MUST be treated as potentially mutating (fail-closed).
        const hadMutatingWrite = checkpoint !== null ? checkpoint.hasMutatingWrite === true : true;
        const isProvenReadOnly = checkpoint !== null && checkpoint.hasMutatingWrite === false;

        const isTerminal = isRecordTerminal(record.state);

        // Exit observations (P1 #3)
        const hasRecordedExit = typeof record.exitCode === "number";
        const hasObservedExit = typeof record.terminalObservation?.exitCode === "number";
        const recordedExit = record.exitCode;
        const observedExit = record.terminalObservation?.exitCode;

        const hasRecordedSignal = typeof record.signal === "string" && record.signal.length > 0;
        const hasObservedSignal =
          typeof record.terminalObservation?.signal === "string" &&
          record.terminalObservation.signal.length > 0;
        const recordedSignal = record.signal;
        const observedSignal = record.terminalObservation?.signal;

        // Contradictory exit proof (P1 #3):
        // Conflicting exit codes (e.g. 0 vs 1, or 1 vs 0), conflicting signals, or signal vs clean exit 0
        const hasConflictingExitCodes =
          hasRecordedExit && hasObservedExit && recordedExit !== observedExit;

        const hasConflictingSignals =
          hasRecordedSignal && hasObservedSignal && recordedSignal !== observedSignal;

        const hasSignalVsCleanExitConflict =
          (hasRecordedSignal && hasObservedExit && observedExit === 0) ||
          (hasObservedSignal && hasRecordedExit && recordedExit === 0);

        const hasContradictoryExitProof =
          hasConflictingExitCodes || hasConflictingSignals || hasSignalVsCleanExitConflict;

        // Clean exit: requires mutual consistency, at least one 0, and neither nonzero nor signal
        const hasCleanExit =
          !hasContradictoryExitProof &&
          ((hasRecordedExit && recordedExit === 0) || (hasObservedExit && observedExit === 0)) &&
          !(hasRecordedExit && recordedExit !== 0) &&
          !(hasObservedExit && observedExit !== 0) &&
          !hasRecordedSignal &&
          !hasObservedSignal;

        // Nonzero exit: requires at least one nonzero exit code or signal, without contradiction
        const hasNonzeroExit =
          !hasContradictoryExitProof &&
          ((hasRecordedExit && recordedExit !== 0) ||
            (hasObservedExit && observedExit !== 0) ||
            hasRecordedSignal ||
            hasObservedSignal);

        const verificationState = checkpoint?.verificationState;
        const lastEvent = checkpoint?.lastEvent;

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

        // Authoritative proof of verified rollback / zero lingering side effects
        const hasVerifiedRollback =
          (checkpoint as any)?.rollbackState === "verified_clean" ||
          (checkpoint as any)?.verifiedRollback === true;

        // Contradictory verifier receipts check: if verified is paired with failure, in-progress, or rollback
        const hasContradictoryVerifierReceipt =
          (hasVerifiedState && (hasFailedEvent || isVerifyingInProgress || hasVerifiedRollback)) ||
          (hasVerifiedEvent && (hasFailedState || isVerifyingInProgress || hasVerifiedRollback)) ||
          (hasVerifiedRollback && (hasVerifiedState || hasVerifiedEvent));

        // Durable, self-consistent verifier proof
        const hasConsistentVerifiedProof =
          checkpoint !== null &&
          (hasVerifiedState || hasVerifiedEvent) &&
          !hasFailedState &&
          !hasFailedEvent &&
          !isVerifyingInProgress &&
          !hasContradictoryVerifierReceipt;

        const isAuthoritativelyVerified =
          isTerminal && hasCleanExit && !hasContradictoryExitProof && hasConsistentVerifiedProof;

        if (classification !== "currently_owned_live" && classification !== "persistent_external") {
          if (hasContradictoryExitProof) {
            // Irreconcilable exit evidence contradiction (P1 #3)
            const contradictionDetail = hasConflictingExitCodes
              ? `recorded exitCode (${recordedExit}) conflicts with observed exitCode (${observedExit})`
              : hasConflictingSignals
              ? `recorded signal (${recordedSignal}) conflicts with observed signal (${observedSignal})`
              : `exit signal (${recordedSignal || observedSignal}) conflicts with clean exit code 0`;

            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "in_progress",
              reconciledStatus: "unknown_outcome_review_required",
              hasMutatingWrite: hadMutatingWrite,
              requiresReview: true,
              eligibleForRetry: false,
              reason: `Contradictory exit proof detected: ${contradictionDetail}. Verification evidence cannot be reconciled; operator review required.`,
            };

            report.mutatingJobsRequiringReview++;
            report.jobAssessments.push(jobAssessment);
            if (recommendedSafeAction !== "investigate_identity") {
              recommendedSafeAction = "review";
            }
            reason += ` Interrupted job '${jobId}' has contradictory exit proof: unknown_outcome_review_required.`;
          } else if (!isCheckpointValid) {
            // Missing, invalid, or untrusted checkpoint (P0 #2): Fail closed!
            const checkpointReason =
              rawCheckpoint === null
                ? "Job checkpoint is missing or unreadable; cannot prove job was non-mutating. Automatic retry blocked to prevent duplicate writes; operator review required."
                : `Job checkpoint schema invalid or jobId mismatch (expected '${jobId}', got '${(rawCheckpoint as any)?.jobId}'); untrusted verifier evidence. Operator review required.`;

            jobAssessment = {
              jobId,
              previousStatus: "unknown",
              reconciledStatus: "unknown_outcome_review_required",
              hasMutatingWrite: true,
              requiresReview: true,
              eligibleForRetry: false,
              reason: checkpointReason,
            };

            report.mutatingJobsRequiringReview++;
            report.jobAssessments.push(jobAssessment);
            if (recommendedSafeAction !== "investigate_identity") {
              recommendedSafeAction = "review";
            }
            reason += ` Job '${jobId}' checkpoint missing or untrusted: unknown_outcome_review_required.`;
          } else if (hasContradictoryVerifierReceipt) {
            // Contradictory verification receipts (e.g. verified + rollback, or verified + failed) (P1 #3)
            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "in_progress",
              reconciledStatus: "unknown_outcome_review_required",
              hasMutatingWrite: hadMutatingWrite,
              requiresReview: true,
              eligibleForRetry: false,
              reason: `Contradictory verification receipts detected (lastEvent='${lastEvent}', verificationState='${verificationState}', rollbackState='${(checkpoint as any)?.rollbackState}'). Verifier evidence cannot be reconciled; operator review required.`,
            };

            report.mutatingJobsRequiringReview++;
            report.jobAssessments.push(jobAssessment);
            if (recommendedSafeAction !== "investigate_identity") {
              recommendedSafeAction = "review";
            }
            reason += ` Interrupted job '${jobId}' has contradictory verification receipts: unknown_outcome_review_required.`;
          } else if (isAuthoritativelyVerified) {
            // Completed job verified with authoritative, self-consistent proof; NOT unknown outcome
            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "verified_succeeded",
              reconciledStatus: "succeeded",
              hasMutatingWrite: hadMutatingWrite,
              requiresReview: false,
              eligibleForRetry: false,
              reason: "Terminal job completed and was successfully verified with authoritative, self-consistent proof.",
            };
            report.jobAssessments.push(jobAssessment);
          } else if (hadMutatingWrite && !hasVerifiedRollback) {
            // Fail-closed for mutating jobs:
            // Nonzero exit, verifier crash, unverified exit, contradictory receipts, or missing proof
            // CANNOT be treated as definitive failure with requiresReview: false, because "nonzero exit"
            // alone is not definitive proof that zero mutating writes occurred.
            // Unless there is authoritative proof of verified clean rollback, operator review is required!
            const failureReason = hasContradictoryVerifierReceipt
              ? `Contradictory verification receipts detected (lastEvent='${lastEvent}', verificationState='${verificationState}'). Verifier evidence cannot be reconciled; operator review required.`
              : isVerifyingInProgress
              ? "Process crashed during verifier execution. Verification outcome uncertain; operator review required."
              : hasNonzeroExit
              ? `Mutating job exited with nonzero code (${record.exitCode ?? record.terminalObservation?.exitCode}) without authoritative proof of clean rollback; operator review required.`
              : "Process crashed during unverified mutating operation. Automatic retry blocked to prevent duplicate writes.";

            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "in_progress",
              reconciledStatus: "unknown_outcome_review_required",
              hasMutatingWrite: true,
              requiresReview: true,
              eligibleForRetry: false,
              reason: failureReason,
            };

            report.mutatingJobsRequiringReview++;
            report.jobAssessments.push(jobAssessment);

            if (recommendedSafeAction !== "investigate_identity") {
              recommendedSafeAction = "review";
            }
            reason += ` Interrupted mutating job '${jobId}' requires review: unknown_outcome_review_required.`;

            // Optionally persist this status into the job checkpoint so future checks stay fail-closed
            if (options.persistInterruptedMutations && checkpoint) {
              try {
                await persistCheckpoint({
                  ...checkpoint,
                  lastEvent: "reconciled_unknown_outcome_review_required",
                  verificationState: "unknown_outcome_review_required",
                });
              } catch {
                // Best-effort
              }
            }
          } else if (isTerminal && (hasFailedState || hasFailedEvent || hasNonzeroExit || hasVerifiedRollback)) {
            // Definitive failure for proven non-mutating job OR mutating job with proven clean rollback
            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "failed",
              reconciledStatus:
                checkpoint?.verificationState === "verification_failed"
                  ? "verification_failed"
                  : "failed",
              hasMutatingWrite: hadMutatingWrite,
              requiresReview: false,
              eligibleForRetry: false,
              reason: hasVerifiedRollback
                ? "Mutating job failed but verified clean rollback was confirmed; zero lingering side effects."
                : "Terminal non-mutating job failed with recorded exit code or verification failure; zero mutating side effects.",
            };
            report.jobAssessments.push(jobAssessment);
          } else if (isVerifyingInProgress) {
            // Non-mutating job crashed during verifier
            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "in_progress",
              reconciledStatus: "unknown_outcome_review_required",
              hasMutatingWrite: false,
              requiresReview: true,
              eligibleForRetry: false,
              reason: "Non-mutating job crashed during verifier execution; verification outcome uncertain.",
            };
            report.jobAssessments.push(jobAssessment);
          } else if (isProvenReadOnly) {
            // Non-mutating job interrupted mid-flight before completion (proven read-only with positive evidence)
            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "in_progress",
              reconciledStatus: "interrupted",
              hasMutatingWrite: false,
              requiresReview: false,
              eligibleForRetry: true,
              reason: "Non-mutating job interrupted before completion. Safe for automatic retry.",
            };
            report.jobAssessments.push(jobAssessment);
          } else {
            // Fallback fail-closed
            jobAssessment = {
              jobId,
              previousStatus: checkpoint?.lastEvent ?? "in_progress",
              reconciledStatus: "unknown_outcome_review_required",
              hasMutatingWrite: true,
              requiresReview: true,
              eligibleForRetry: false,
              reason: "Job outcome cannot be verified without trusted checkpoint; automatic retry blocked.",
            };
            report.mutatingJobsRequiringReview++;
            report.jobAssessments.push(jobAssessment);
          }
        }
      } catch {
        // Best-effort checkpoint inspection
      }
    }

    counts[classification]++;

    if (report.entries.length < maxEntries) {
      const maskedWorkspace = isForeign
        ? `[foreign_workspace:${crypto.createHash("sha256").update(recordWs || "").digest("hex").slice(0, 8)}]`
        : recordWs;

      report.entries.push({
        recordId: record.recordId,
        pid: record.pid,
        component: record.component,
        classification,
        lifecycle: record.lifecycle,
        cleanupPolicy: record.cleanupPolicy,
        runtimeGeneration: record.runtimeGeneration,
        isCurrentRuntime,
        workspaceRoot: maskedWorkspace,
        jobId: isForeign ? "[foreign_job]" : record.ownership?.jobId,
        sessionId: isForeign ? "[foreign_session]" : record.ownership?.sessionId,
        isForeignWorkspace: isForeign,
        recommendedSafeAction,
        reason,
        jobAssessment,
      });
    }
  }

  return report;
}
