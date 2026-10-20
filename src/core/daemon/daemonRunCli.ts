import { getDaemonRun, listDaemonRuns } from "../storage/daemonRunLedger.js";
import { redactMemorySecrets } from "../memoryLifecycle.js";
import { projectDaemonRun } from "../channels/unifiedChannelTask.js";
import type { DaemonRunFilter, DaemonRunRecord, DaemonRunStatus } from "./daemonTypes.js";

const VALID_STATUSES = new Set<DaemonRunStatus>([
  "queued", "running", "success", "error", "interrupted", "timed_out", "cancelled",
]);

function parseRunsArgs(args: string[]): DaemonRunFilter {
  const filter: DaemonRunFilter = {};
  const knownFlags = new Set(["--job", "--status", "--limit", "--project"]);
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    if (!option || !knownFlags.has(option) || !value || value.startsWith("--")) {
      throw new Error("Usage: superagent daemon runs [--job <id>] [--status <status>] [--project <id>] [--limit <1-500>]");
    }
    switch (option) {
      case "--job":
        if (filter.jobId !== undefined) throw new Error("Duplicate --job filter");
        filter.jobId = value;
        break;
      case "--project":
        if (filter.projectId !== undefined) throw new Error("Duplicate --project filter");
        filter.projectId = value;
        break;
      case "--status":
        if (filter.status !== undefined) throw new Error("Duplicate --status filter");
        if (!VALID_STATUSES.has(value as DaemonRunStatus)) {
          throw new Error("Invalid daemon status: " + value);
        }
        filter.status = value as DaemonRunStatus;
        break;
      case "--limit": {
        if (filter.limit !== undefined) throw new Error("Duplicate --limit filter");
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 500) {
          throw new Error("--limit must be a whole number between 1 and 500.");
        }
        filter.limit = parsed;
        break;
      }
    }
  }
  return filter;
}

function dateText(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toISOString();
}

function safeDisplay(value: unknown): string {
  return redactMemorySecrets(String(value ?? ""));
}

function printRunSummary(run: DaemonRunRecord): void {
  console.log(
    [
      safeDisplay(run.runId),
      "job=" + safeDisplay(run.jobId),
      "attempt=" + run.attemptNumber,
      "status=" + run.status,
      "unified=" + projectDaemonRun(run).status,
      "started=" + dateText(run.startedAt),
      "duration=" + (run.durationMs ?? "—") + "ms",
      "notification=" + run.notificationStatus,
    ].join(" | "),
  );
}

/** Bounded, read-only CLI history/diagnostic access; caller owns process exit. */
export function handleDaemonRunHistoryCommand(args: string[]): number {
  const subcommand = args[0]?.toLowerCase();
  try {
    if (subcommand === "runs") {
      const filter = parseRunsArgs(args.slice(1));
      const runs = listDaemonRuns(filter);
      console.log("Daemon run history (" + runs.length + "):");
      if (runs.length === 0) console.log("No matching runs.");
      for (const run of runs) printRunSummary(run);
      return 0;
    }

    if (subcommand === "inspect-run") {
      const runId = args[1];
      if (!runId || args.length !== 2 || runId.startsWith("--")) {
        throw new Error("Usage: superagent daemon inspect-run <run-id>");
      }
      const run = getDaemonRun(runId);
      if (!run) {
        console.error("No daemon run found with ID: " + safeDisplay(runId));
        return 1;
      }

      let policy: unknown;
      try {
        policy = JSON.parse(run.executionPolicyJson);
      } catch {
        policy = { error: "Stored policy JSON cannot be decoded" };
      }
      console.log("Daemon run: " + safeDisplay(run.runId));
      console.log("Job: " + safeDisplay(run.jobId) + " | Attempt: " + run.attemptNumber);
      console.log("Project: " + safeDisplay(run.projectId));
      console.log("Workspace: " + safeDisplay(run.workspacePath));
      console.log("Mode: " + run.mode + " | Status: " + run.status);
      console.log("Unified channel status: " + projectDaemonRun(run).status + " | Evidence: " + projectDaemonRun(run).evidence);
      console.log("Pinned skill: " + safeDisplay(run.pinnedSkillVersion ?? "—"));
      console.log("Started: " + dateText(run.startedAt));
      console.log("Completed: " + dateText(run.completedAt));
      console.log("Duration: " + (run.durationMs ?? "—") + "ms");
      console.log("Notification: " + run.notificationStatus);
      if (run.notificationError) console.log("Notification error: " + safeDisplay(run.notificationError));
      if (run.outputSummary) console.log("Output summary: " + safeDisplay(run.outputSummary));
      if (run.errorMessage) console.log("Error: " + safeDisplay(run.errorMessage));
      if (run.interruptionReason) console.log("Interruption: " + safeDisplay(run.interruptionReason));
      console.log("Recovery: " + safeDisplay(run.recoveryAction));
      console.log("Execution policy: " + safeDisplay(JSON.stringify(policy, null, 2)));
      return 0;
    }

    throw new Error("Usage: superagent daemon runs [--job <id>] [--status <status>] [--project <id>] [--limit <n>] | inspect-run <run-id>");
  } catch (error) {
    console.error("Daemon diagnostics failed: " + safeDisplay(error instanceof Error ? error.message : error));
    return 2;
  }
}
