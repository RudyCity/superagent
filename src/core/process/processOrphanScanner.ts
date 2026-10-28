/**
 * M2 ownership-aware read-only orphan scanner.
 * No kill, reap, process adoption, registry mutation, or console spawn occurs here.
 * Historical process records are report-only even when the recorded parent PID is absent.
 */
import { ProcessRegistry, getRuntimeGeneration, type ProcessRecord } from "./processRegistry.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import { observeProcessId, type PidObservation } from "../tools/cliBridgeRecovery.js";

export type ProcessScanClassification =
  | "terminal" | "currently_owned_live" | "orphan_candidate" | "historical"
  | "identity_mismatch" | "unknown" | "persistent_external";
export type OwnerState = "live" | "terminal" | "unknown";
export interface OwnerStateEvidence {
  state: OwnerState;
  /** Source of explicit job/session owner evidence; PID state alone cannot authorize cleanup. */
  source: string;
}
export interface ProcessScanEntry {
  recordId: string;
  pid: number | null;
  component: string;
  classification: ProcessScanClassification;
  ageMs: number;
  heartbeatAgeMs: number | null;
  cleanupPolicy: string;
  recommendedSafeAction: "observe" | "review" | "investigate_identity";
}
export interface ProcessScanReport {
  timestamp: number;
  isCorrupt: boolean;
  total: number;
  counts: Record<ProcessScanClassification, number>;
  entries: ProcessScanEntry[];
}
export interface ProcessScanDependencies {
  now?: () => number;
  observePid?: (pid: number) => PidObservation | Promise<PidObservation>;
  readIdentity?: (pid: number) => Promise<string | null>;
  inspectOwner?: (record: Readonly<ProcessRecord>) => OwnerStateEvidence | Promise<OwnerStateEvidence>;
}
export interface ProcessScanOptions {
  /** Required: fail closed if a caller workspace is not available. */
  callerWorkspaceRoot: string;
  graceMs?: number;
  maxEntries?: number;
}
const classifications: ProcessScanClassification[] = [
  "terminal", "currently_owned_live", "orphan_candidate", "historical",
  "identity_mismatch", "unknown", "persistent_external",
];
const isTerminal = (s: string): boolean => s === "exited" || s === "failed" || s === "terminated";
const eligible = (r: ProcessRecord): boolean =>
  (r.lifecycle === "ephemeral" || r.lifecycle === "job" || r.lifecycle === "session") &&
  (r.cleanupPolicy === "terminate_with_owner" || r.cleanupPolicy === "lease_managed");

/** Positive authoritative evidence only; missing owner data always returns unknown. */
async function inspectLiveOwner(record: Readonly<ProcessRecord>): Promise<OwnerStateEvidence> {
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
      const done = ["succeeded", "failed", "timed_out", "cancelled", "verification_failed", "permission_blocked"].includes(job.status);
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
 * Returns only records within the exact caller workspace.
 * Unregistered historical AGY/cmd.exe and foreign workspace processes are NEVER included.
 * All observations are rechecked after awaiting owner state, with an additional final
 * snapshot check to prevent reclassifying a revived owner, changed policy or renewed lease.
 */
export async function scanManagedProcessOrphans(
  registry: ProcessRegistry,
  options: ProcessScanOptions,
  deps: ProcessScanDependencies = {},
): Promise<ProcessScanReport> {
  const now = deps.now?.() ?? Date.now();
  const counts = Object.fromEntries(classifications.map(s => [s, 0])) as Record<ProcessScanClassification, number>;
  const report: ProcessScanReport = { timestamp: now, isCorrupt: registry.isRegistryCorrupt(), total: 0, counts, entries: [] };
  if (report.isCorrupt || !options.callerWorkspaceRoot) return report;
  const observe = deps.observePid ?? observeProcessId;
  const identity = deps.readIdentity ?? readProcessStartIdentity;
  const owner = deps.inspectOwner ?? inspectLiveOwner;
  const graceMs = Math.max(1_000, options.graceMs ?? 30_000);
  const maxEntries = Math.max(0, Math.min(200, options.maxEntries ?? 100));
  // Strictly scoped: not even foreign record counts are leaked to callers.
  const records = registry.listRecords().filter(r => r.ownership?.workspaceRoot === options.callerWorkspaceRoot);
  for (const record of records) {
    let classification: ProcessScanClassification = "unknown";
    const ageMs = Math.max(0, now - (record.startedAt ?? record.registeredAt));
    const heartbeatAgeMs = typeof record.heartbeatAt === "number" ? Math.max(0, now - record.heartbeatAt) : null;
    if (isTerminal(record.state)) {
      classification = "terminal";
    } else if (record.lifecycle === "persistent" || record.lifecycle === "external" ||
      record.cleanupPolicy === "keep_alive" || record.cleanupPolicy === "manual_only" ||
      record.cleanupPolicy === "manual") {
      classification = "persistent_external";
    } else if (record.runtimeGeneration !== getRuntimeGeneration()) {
      classification = "historical";
    } else if (typeof record.pid === "number" && record.pid > 0 &&
      record.creationIdentity) {
      const pid = record.pid;
      const presence = await Promise.resolve(observe(pid)).catch(() => "unknown" as PidObservation);
      const liveIdentity = presence === "pid_present_unverified"
        ? await identity(pid).catch(() => null) : null;
      const check = registry.verifyOwnership(record.recordId, liveIdentity, presence);
      if (check.status === "identity_mismatch_blocked") {
        classification = "identity_mismatch";
      } else if (check.status === "verified_owner") {
        const firstOwner = await Promise.resolve(owner(record)).catch(
          () => ({ state: "unknown" as const, source: "owner_probe_failed" }));
        if (firstOwner.state === "live") {
          classification = "currently_owned_live";
        } else if (firstOwner.state === "terminal" && firstOwner.source && eligible(record) &&
          heartbeatAgeMs !== null && heartbeatAgeMs > graceMs) {
          const latest = registry.getRecord(record.recordId);
          const unchanged = latest && !registry.isRegistryCorrupt() &&
            latest.pid === pid && latest.creationIdentity === record.creationIdentity &&
            latest.runtimeGeneration === record.runtimeGeneration &&
            latest.heartbeatAt === record.heartbeatAt && latest.state === record.state &&
            latest.lifecycle === record.lifecycle && latest.cleanupPolicy === record.cleanupPolicy &&
            latest.ownership?.workspaceRoot === options.callerWorkspaceRoot &&
            latest.ownership?.jobId === record.ownership?.jobId &&
            latest.ownership?.sessionId === record.ownership?.sessionId;
          if (unchanged) {
            const ownerAgain = await Promise.resolve(owner(latest)).catch(
              () => ({ state: "unknown" as const, source: "owner_recheck_failed" }));
            const presenceAgain = await Promise.resolve(observe(pid)).catch(() => "unknown" as PidObservation);
            const identityAgain = presenceAgain === "pid_present_unverified"
              ? await identity(pid).catch(() => null) : null;
            const finalRecord = registry.getRecord(record.recordId);
            const leaseStillValid = finalRecord && !registry.isRegistryCorrupt() &&
              finalRecord.pid === pid && finalRecord.creationIdentity === record.creationIdentity &&
              finalRecord.runtimeGeneration === record.runtimeGeneration &&
              finalRecord.heartbeatAt === record.heartbeatAt &&
              finalRecord.state === record.state &&
              finalRecord.lifecycle === record.lifecycle &&
              finalRecord.cleanupPolicy === record.cleanupPolicy &&
              finalRecord.ownership?.workspaceRoot === options.callerWorkspaceRoot &&
              finalRecord.ownership?.jobId === record.ownership?.jobId &&
              finalRecord.ownership?.sessionId === record.ownership?.sessionId;
            if (ownerAgain.state === "terminal" && ownerAgain.source && leaseStillValid &&
              registry.verifyOwnership(record.recordId, identityAgain, presenceAgain).status === "verified_owner") {
              classification = "orphan_candidate";
            }
          }
        }
      }
    }
    report.total++;
    counts[classification]++;
    if (report.entries.length < maxEntries) {
      report.entries.push({
        recordId: record.recordId, pid: record.pid, component: record.component,
        classification, ageMs, heartbeatAgeMs, cleanupPolicy: record.cleanupPolicy,
        recommendedSafeAction: classification === "identity_mismatch"
          ? "investigate_identity" : classification === "orphan_candidate" || classification === "unknown"
          ? "review" : "observe",
      });
    }
  }
  return report;
}
