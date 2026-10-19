export type DaemonJobKind = "agent" | "system-memory-retention-sweep";

export interface DaemonJob {
  kind?: DaemonJobKind;
  id: string;
  name: string;
  cronExpression: string;
  prompt: string;
  workspace: string;
  mode: "single" | "multi";
  enabled: boolean;
  createdAt: number;
  lastRun?: number;
  nextRun?: number;
  lastStatus?: "success" | "error" | "running" | "interrupted" | "timed_out" | "queued" | "cancelled";
  lastError?: string;
  lastRunDurationMs?: number;
  runCount: number;
  maxRuns?: number;
  notifyGateway?: boolean;
  tags?: string[];
  /** Explicit additional capabilities for headless execution; defaults remain read-only. */
  allowedTools?: string[];
  /** Optional wall-clock deadline for an individual execution, from 1 ms to 24 hours. */
  timeoutMs?: number;
  /** Immutable approved skill reference in the form skill-name@12-char-version-hash. */
  pinnedSkillVersion?: string;
  /** Automatic retries are honored only when idempotent is explicitly true. */
  retryLimit?: number;
  retryDelayMs?: number;
  idempotent?: boolean;
  /** Durable queue/retry state persisted alongside the job definition. */
  queuedAt?: number;
  retryAt?: number;
  retryCount?: number;
}

export interface DaemonConfig {
  tickIntervalMs: number;
  maxConcurrentJobs: number;
  logPath?: string;
}

export interface DaemonStatus {
  running: boolean;
  pid: number;
  uptime: number;
  activeJobsCount: number;
  totalJobsCount: number;
  lastTickAt?: number;
}

export type DaemonRunStatus =
  | "queued"
  | "running"
  | "success"
  | "error"
  | "interrupted"
  | "timed_out"
  | "cancelled";

export type DaemonNotificationStatus = "not_configured" | "pending" | "delivered" | "failed";

/** Durable execution record for one daemon attempt. Policy JSON is a snapshot, not a live grant. */
export interface DaemonRunRecord {
  runId: string;
  jobId: string;
  attemptNumber: number;
  workspacePath: string;
  projectId: string;
  mode: "single" | "multi";
  status: DaemonRunStatus;
  executionPolicyJson: string;
  pinnedSkillVersion?: string | null;
  startedAt: number;
  completedAt?: number | null;
  durationMs?: number | null;
  outputSummary?: string | null;
  errorMessage?: string | null;
  interruptionReason?: string | null;
  notificationStatus?: DaemonNotificationStatus;
  notificationError?: string | null;
  recoveryAction?: string;
  createdAt?: number;
}

export type NewDaemonRunRecord =
  Omit<DaemonRunRecord, "createdAt" | "notificationStatus" | "recoveryAction"> &
  Partial<Pick<DaemonRunRecord, "createdAt" | "notificationStatus" | "recoveryAction">>;

export type DaemonRunUpdate = Partial<Omit<DaemonRunRecord, "runId" | "jobId" | "createdAt">>;

export interface DaemonRunFilter {
  jobId?: string;
  projectId?: string;
  workspacePath?: string;
  status?: DaemonRunStatus;
  startedAfter?: number;
  startedBefore?: number;
  /** Backward-compatible exclusive upper bound for startedAt. */
  before?: number;
  /** Defaults to 100 and is bounded at 500 by the storage layer. */
  limit?: number;
}
