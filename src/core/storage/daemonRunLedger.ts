import { redactMemorySecrets } from "../memoryLifecycle.js";
import { getHistoryDb } from "./historyDb.js";
import type { DaemonRunFilter, DaemonRunRecord, DaemonRunStatus, DaemonRunUpdate, NewDaemonRunRecord } from "../daemon/daemonTypes.js";

const RUN_STATUSES: DaemonRunStatus[] = ["queued", "running", "success", "error", "interrupted", "timed_out", "cancelled"];
const NOTIFICATION_STATUSES = ["not_configured", "pending", "delivered", "failed"] as const;

function mapRow(row: any): DaemonRunRecord {
  return {
    runId: String(row.run_id),
    jobId: String(row.job_id),
    attemptNumber: Number(row.attempt_number),
    workspacePath: String(row.workspace_path),
    projectId: String(row.project_id),
    mode: row.mode === "multi" ? "multi" : "single",
    status: row.status as DaemonRunStatus,
    executionPolicyJson: String(row.execution_policy_json),
    pinnedSkillVersion: row.pinned_skill_version ?? null,
    startedAt: Number(row.started_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    outputSummary: row.output_summary ?? null,
    errorMessage: row.error_message ?? null,
    interruptionReason: row.interruption_reason ?? null,
    notificationStatus: row.notification_status,
    notificationError: row.notification_error ?? null,
    recoveryAction: String(row.recovery_action || "none"),
    createdAt: Number(row.created_at),
  };
}

function validateRunInput(input: Pick<DaemonRunRecord, "runId" | "jobId" | "workspacePath" | "projectId" | "mode" | "status" | "attemptNumber" | "executionPolicyJson">): void {
  for (const [field, value] of Object.entries({
    runId: input.runId,
    jobId: input.jobId,
    workspacePath: input.workspacePath,
    projectId: input.projectId,
  })) {
    if (typeof value !== "string" || !value.trim() || value.length > 2048) {
      throw new Error(`Invalid daemon run ${field}: expected a non-empty string up to 2048 characters.`);
    }
  }
  if (!Number.isSafeInteger(input.attemptNumber) || input.attemptNumber < 1) {
    throw new Error("Invalid daemon run attemptNumber: expected a positive integer.");
  }
  if (input.mode !== "single" && input.mode !== "multi") throw new Error("Invalid daemon run mode.");
  if (!RUN_STATUSES.includes(input.status)) throw new Error("Invalid daemon run status.");
  if (typeof input.executionPolicyJson !== "string") throw new Error("Invalid daemon run executionPolicyJson.");
  try {
    const parsed = JSON.parse(input.executionPolicyJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("policy must be an object");
  } catch {
    throw new Error("Invalid daemon run executionPolicyJson: expected a JSON object.");
  }
}

/** Persist one execution attempt. Output and error text are redacted at the storage boundary. */
export function insertDaemonRun(input: NewDaemonRunRecord): DaemonRunRecord {
  validateRunInput(input);
  const notificationStatus = input.notificationStatus ?? "not_configured";
  if (!(NOTIFICATION_STATUSES as readonly string[]).includes(notificationStatus)) {
    throw new Error("Invalid daemon run notificationStatus.");
  }

  getHistoryDb().prepare(`
    INSERT INTO daemon_runs (
      run_id, job_id, attempt_number, workspace_path, project_id, mode, status,
      execution_policy_json, pinned_skill_version, started_at, completed_at, duration_ms,
      output_summary, error_message, interruption_reason, notification_status, notification_error,
      recovery_action, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.runId,
    input.jobId,
    input.attemptNumber,
    input.workspacePath,
    input.projectId,
    input.mode,
    input.status,
    input.executionPolicyJson,
    input.pinnedSkillVersion ?? null,
    input.startedAt,
    input.completedAt ?? null,
    input.durationMs ?? null,
    input.outputSummary == null ? null : redactMemorySecrets(input.outputSummary),
    input.errorMessage == null ? null : redactMemorySecrets(input.errorMessage),
    input.interruptionReason == null ? null : redactMemorySecrets(input.interruptionReason),
    notificationStatus,
    input.notificationError == null ? null : redactMemorySecrets(input.notificationError),
    input.recoveryAction ?? "none",
    input.createdAt ?? Date.now(),
  );

  const inserted = getDaemonRun(input.runId);
  if (!inserted) throw new Error(`Daemon run insert failed: ${input.runId}`);
  return inserted;
}

/** Update an allowlisted set of run fields; returns null when the run does not exist. */
export function updateDaemonRun(runId: string, updates: DaemonRunUpdate): DaemonRunRecord | null {
  if (!runId.trim()) throw new Error("Daemon run ID is required.");
  if (updates.status !== undefined && !RUN_STATUSES.includes(updates.status)) throw new Error("Invalid daemon run status.");
  if (updates.mode !== undefined && updates.mode !== "single" && updates.mode !== "multi") throw new Error("Invalid daemon run mode.");
  if (updates.notificationStatus !== undefined && !(NOTIFICATION_STATUSES as readonly string[]).includes(updates.notificationStatus)) {
    throw new Error("Invalid daemon run notificationStatus.");
  }

  const columnByProperty: Array<[keyof DaemonRunUpdate, string]> = [
    ["attemptNumber", "attempt_number"],
    ["workspacePath", "workspace_path"],
    ["projectId", "project_id"],
    ["mode", "mode"],
    ["status", "status"],
    ["executionPolicyJson", "execution_policy_json"],
    ["pinnedSkillVersion", "pinned_skill_version"],
    ["startedAt", "started_at"],
    ["completedAt", "completed_at"],
    ["durationMs", "duration_ms"],
    ["outputSummary", "output_summary"],
    ["errorMessage", "error_message"],
    ["interruptionReason", "interruption_reason"],
    ["notificationStatus", "notification_status"],
    ["notificationError", "notification_error"],
    ["recoveryAction", "recovery_action"],
  ];
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [property, column] of columnByProperty) {
    if (!Object.prototype.hasOwnProperty.call(updates, property)) continue;
    let value: unknown = updates[property];
    if (["outputSummary", "errorMessage", "interruptionReason", "notificationError"].includes(property) && typeof value === "string") {
      value = redactMemorySecrets(value);
    }
    if (property === "attemptNumber" && value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1)) {
      throw new Error("Invalid daemon run attemptNumber: expected a positive integer.");
    }
    if (property === "executionPolicyJson" && value !== undefined) {
      try {
        const parsed = JSON.parse(String(value));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      } catch {
        throw new Error("Invalid daemon run executionPolicyJson: expected a JSON object.");
      }
    }
    assignments.push(`${column} = ?`);
    values.push(value ?? null);
  }

  if (!assignments.length) return getDaemonRun(runId);
  values.push(runId);
  getHistoryDb().prepare(`UPDATE daemon_runs SET ${assignments.join(", ")} WHERE run_id = ?`).run(...values);
  return getDaemonRun(runId);
}

export function getDaemonRun(runId: string): DaemonRunRecord | null {
  const row = getHistoryDb().prepare("SELECT * FROM daemon_runs WHERE run_id = ?").get(runId) as any;
  return row ? mapRow(row) : null;
}

export function listDaemonRuns(filter: DaemonRunFilter = {}): DaemonRunRecord[] {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.jobId) {
    where.push("job_id = ?");
    values.push(filter.jobId);
  }
  if (filter.projectId) {
    where.push("project_id = ?");
    values.push(filter.projectId);
  }
  if (filter.workspacePath) {
    where.push("workspace_path = ?");
    values.push(filter.workspacePath);
  }
  if (filter.status) {
    if (!RUN_STATUSES.includes(filter.status)) throw new Error("Invalid daemon run status filter.");
    where.push("status = ?");
    values.push(filter.status);
  }
  if (filter.startedAfter !== undefined) {
    if (!Number.isFinite(filter.startedAfter)) throw new Error("Invalid daemon run startedAfter filter.");
    where.push("started_at >= ?");
    values.push(filter.startedAfter);
  }
  if (filter.startedBefore !== undefined) {
    if (!Number.isFinite(filter.startedBefore)) throw new Error("Invalid daemon run startedBefore filter.");
    where.push("started_at <= ?");
    values.push(filter.startedBefore);
  }
  if (filter.before !== undefined) {
    if (!Number.isFinite(filter.before)) throw new Error("Invalid daemon run before filter.");
    where.push("started_at < ?");
    values.push(filter.before);
  }
  const requestedLimit = filter.limit ?? 100;
  if (!Number.isFinite(requestedLimit)) throw new Error("Invalid daemon run limit.");
  const limit = Math.max(1, Math.min(500, Math.floor(requestedLimit)));
  const sql = `SELECT * FROM daemon_runs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC, run_id DESC LIMIT ?`;
  return (getHistoryDb().prepare(sql).all(...values, limit) as any[]).map(mapRow);
}
