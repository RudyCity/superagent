import { getProcessSupervisor } from "../process/processSupervisor.js";
import { scanManagedProcessOrphans } from "../process/processOrphanScanner.js";
import { reconcileStartupProcesses } from "../process/processReconciliation.js";

const compactId = (value?: string): string => {
  if (!value) return "-";
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : "[redacted]";
};

/**
 * Read-only, caller-workspace-scoped process status. Never enumerates
 * unregistered OS processes, never discloses another workspace's metadata.
 */
export async function formatProcessStatus(callerWorkspaceRoot: string, detailed = false): Promise<string> {
  if (!callerWorkspaceRoot) return "Process diagnostics unavailable: workspace is unknown.";
  const supervisor = getProcessSupervisor();
  await supervisor.initialize();
  const registry = supervisor.getRegistry();
  const report = await scanManagedProcessOrphans(registry, {
    callerWorkspaceRoot, graceMs: 30_000, maxEntries: detailed ? 25 : 8,
  });
  const reconciliation = await reconcileStartupProcesses(registry, {
    callerWorkspaceRoot,
    graceMs: 30_000,
    maxEntries: detailed ? 25 : 8,
  });

  const lines: string[] = [
    detailed ? "SUPERAGENT — PROCESS DOCTOR (READ-ONLY)" : "SUPERAGENT — PROCESS STATUS (READ-ONLY)",
    "Scope: current workspace only; no automatic cleanup or process adoption.",
    "Managed process records: " + report.total,
    "Owned/live: " + report.counts.currently_owned_live,
    "Terminal: " + report.counts.terminal,
    "Historical: " + report.counts.historical,
    "Unknown: " + report.counts.unknown,
    "Orphan candidates: " + report.counts.orphan_candidate,
    "Identity mismatch: " + report.counts.identity_mismatch,
    "Persistent / external: " + report.counts.persistent_external,
    "Reconciliation findings: " +
      (reconciliation.mutatingJobsRequiringReview > 0
        ? `${reconciliation.mutatingJobsRequiringReview} mutating job(s) require review ('unknown_outcome_review_required')`
        : "clean / no pending mutating review"),
  ];
  if (reconciliation.mutatingJobsRequiringReview > 0) {
    lines.push("Recommendation: operator review required for interrupted mutating jobs (zero prompt replay).");
  }
  if (report.isCorrupt) {
    lines.push("WARNING: Process registry corrupt. ALL ownership and cleanup claims blocked.");
    return lines.join("\n");
  }
  if (detailed) {
    lines.push("", "Read-only findings (max 25, no paths/argv):");
    for (const entry of report.entries) {
      const record = registry.getRecord(entry.recordId);
      const owner = record?.ownership?.workspaceRoot === callerWorkspaceRoot ? record.ownership : undefined;
      const matchedReconciled = reconciliation.entries.find(e => e.recordId === entry.recordId);
      const jobStatus = matchedReconciled?.jobAssessment?.reconciledStatus;
      lines.push(
        "- " + entry.classification +
        " | component=" + compactId(entry.component) +
        " | pid=" + (entry.pid ?? "-") +
        " | age=" + Math.round(entry.ageMs / 1000) + "s" +
        " | heartbeat=" + (entry.heartbeatAgeMs === null ? "unknown" : Math.round(entry.heartbeatAgeMs / 1000) + "s") +
        " | job=" + compactId(owner?.jobId) +
        (jobStatus ? " | job_status=" + compactId(jobStatus) : "") +
        " | session=" + compactId(owner?.sessionId) +
        " | policy=" + compactId(entry.cleanupPolicy) +
        " | action=" + (jobStatus === "unknown_outcome_review_required" ? "review" : entry.recommendedSafeAction)
      );
    }
    lines.push(
      "",
      "Owner evidence unavailable => UNKNOWN (never infer orphan from parent PID alone).",
      "Historical/unknown AGY, Antigravity, cmd.exe or provider processes are report-only.",
      "Use /status processes for summary. No process termination is available from these commands."
    );
  } else {
    lines.push("Use /doctor processes for read-only details.");
  }
  return lines.join("\n");
}
