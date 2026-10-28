/**
 * Long-running, pollable one-shot CLI delegations for MCP callers.
 * These jobs return quickly, run concurrently, persist metadata, and log all output.
 */
import { execa } from "execa";
import { StringDecoder } from "node:string_decoder";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import {
  applyProcessIntent,
  resolveWindowsDirectExecutable,
  spawnHiddenTaskkill,
  traceChildProcess,
} from "../process/processSpawnPolicy.js";
import {
  resolveExpectedArtifacts, snapshotExpectedArtifacts, inspectExpectedArtifacts, artifactClaimIdentity,
  type ArtifactBaseline, type ArtifactEvidence,
} from "./cliBridgeArtifactEvidence.js";
import {
  acquireCrossProcessArtifactClaims, releaseCrossProcessArtifactClaims,
  type CrossProcessArtifactClaims,
} from "./cliBridgeCrossProcessClaims.js";
import { persistJobShard, loadJobShards, loadLegacyJobs, writeCompatibilityJobsSnapshot, jobShardPath, pruneJobRevisions } from "./cliBridgeJobStore.js";
import { classifyDelegateRecovery, type DelegateRecoveryDiagnostic } from "./cliBridgeRecovery.js";
import { readProcessStartIdentity } from "./cliBridgeProcessIdentity.js";
import { getTlineCreatorForJob } from "../channels/tlineJobCreator.js";
import { inspectAgyBridgeLine, AGY_PERMISSION_RECOVERY } from "./cliBridgeAgyPermissions.js";
import { readBoundedLogTail, redactCliBridgeOutput, summarizedPrompt } from "./cliBridgeObservability.js";
import { acquireCliBridgeCapacity, releaseCliBridgeCapacity, updateCliBridgeCapacity, type CliBridgeCapacityLease } from "./cliBridgeCapacity.js";
import { sampleSystemResources, type SystemResourceSample, type ResourcePressureLevel } from "./cliBridgeResourceSampler.js";
import {
  calculateEffectiveSlots, evaluateJobAdmission, CliBridgePriorityQueue,
  DEFAULT_SCHEDULER_POLICY, type JobPriority, type ResourceClass, type ScheduledJobRequest, type SchedulerPolicy,
} from "./cliBridgeScheduler.js";
import {
  acquireResourceClaims, releaseResourceClaims,
  type ResourceClaimRequest, type ResourceClaimLease,
} from "./cliBridgeResourceClaims.js";
import {
  createIsolatedWorktree, removeIsolatedWorktree, inspectWorktreeProvenance,
  type WorktreeMetadata, type WorktreeCommitProvenance,
} from "./cliBridgeWorktreeManager.js";
import {
  executeAcceptanceVerification,
  type AcceptanceContract, type VerificationResult, type JobVerificationState,
} from "./cliBridgeAcceptance.js";
import { getRoleProfile, type AgentRoleProfile } from "./cliBridgeRoleProfiles.js";
import { writeJobCheckpoint, readJobCheckpoint, reconcileJobOnRestart, type JobCheckpoint } from "./cliBridgeReconciliation.js";
import { getProcessSupervisor } from "../process/processSupervisor.js";

export type DelegateJobStatus =
  | "queued"
  | "starting"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "interrupted"
  | "verification_failed"
  | "permission_blocked"
  | "unknown_outcome_review_required";

export interface DelegateJob {
  jobId: string;
  cliAlias: string;
  binary: string;
  cwd: string;
  /** Immutable canonical caller workspace; used to authorize job inspection and cancellation. */
  workspaceRoot?: string;
  /** Caller-declared artifact paths; never inferred from model output. */
  expectedArtifacts?: string[];
  idempotencyKey?: string;
  promptDigest?: string;
  capacitySlot?: number;
  /** Exit zero alone means unverified process completion. */
  completionState?:
    | "pending"
    | "verified"
    | "artifacts_verified"
    | "unverified"
    | "artifact_verification_failed"
    | "verification_failed"
    | "failed"
    | "timed_out"
    | "cancelled"
    | "interrupted"
    | "permission_blocked"
    | "unknown_outcome_review_required";
  /** Diagnostic only: no permission escalation or automatic retries. */
  permissionWarning?: string;
  permissionFailure?: string;
  /** Earlier denial was superseded by a clean terminal AGY result. */
  permissionRecovered?: boolean;
  permissionRecoveryWarning?: string;
  /** Sticky when the terminal AGY result itself declares denied_actions. */
  finalPermissionFailure?: boolean;
  artifactEvidence?: ArtifactEvidence[];
  pid: number | null;
  /** Server-internal provenance; never populated from tool args or user prompt. */
  creator?: { clientMode: "tline"; sessionId: string; workspace: string };
  /** PID of the SuperAgent process that launched the CLI; diagnostic only, never authorization. */
  ownerPid?: number;
  /** Best-effort host-local process creation fingerprints, not permissions. */
  ownerProcessIdentity?: string;
  childProcessIdentity?: string;
  status: DelegateJobStatus;
  startedAt: number;
  updatedAt: number;
  /** Bridge-owner liveness, not evidence of AI progress. */
  heartbeatAt?: number;
  /** Timestamp of latest CLI stdout/stderr. */
  lastOutputAt?: number;
  lastProgressAt?: number;
  activityEvents?: number;
  currentStage?: string;
  endedAt?: number;
  durationMs?: number;
  exitCode: number | null;
  timedOut: boolean;
  timeoutMs: number;
  outputTail: string;
  outputBytes: number;
  logPath: string;
  error?: string;
  // Multi-agent & Scheduler integration fields
  priority?: JobPriority;
  resourceClass?: ResourceClass;
  projectId?: string;
  roleProfile?: string;
  worktreePath?: string;
  branchName?: string;
  baseCommitSha?: string;
  worktreeProvenance?: WorktreeCommitProvenance;
  resourceClaimLeases?: ResourceClaimLease[];
  acceptanceContract?: AcceptanceContract;
  verificationResult?: VerificationResult;
  // Structured completion and verification fields
  processState?: string;
  verificationState?: string;
  taskOutcome?: string;
  evidenceCount?: number;
  verifiedAt?: number;
  failureReason?: string;
  processRecordId?: string;
}

export function isProcessSuccessful(job: Pick<DelegateJob, "status" | "exitCode">): boolean {
  return (
    job.status === "succeeded" ||
    (job.exitCode === 0 &&
      job.status !== "failed" &&
      job.status !== "permission_blocked" &&
      job.status !== "timed_out" &&
      job.status !== "cancelled")
  );
}

export function isTaskVerified(job: Pick<DelegateJob, "completionState" | "status">): boolean {
  return job.completionState === "verified";
}

export function requiresReview(job: Pick<DelegateJob, "completionState" | "status">): boolean {
  return (
    job.completionState === "unknown_outcome_review_required" ||
    job.completionState === "permission_blocked" ||
    job.completionState === "unverified" ||
    job.status === "permission_blocked" ||
    job.status === "unknown_outcome_review_required"
  );
}

export function getTaskOutcome(job: Pick<DelegateJob, "status" | "completionState" | "permissionFailure">): string {
  if (job.status === "permission_blocked" || job.completionState === "permission_blocked" || job.permissionFailure) {
    return "PERMISSION_BLOCKED";
  }
  if (job.completionState === "verified") {
    return "VERIFIED";
  }
  if (job.completionState === "artifacts_verified") {
    return "ARTIFACTS_VERIFIED";
  }
  if (
    job.completionState === "verification_failed" ||
    job.completionState === "artifact_verification_failed" ||
    job.status === "verification_failed"
  ) {
    return "VERIFICATION_FAILED";
  }
  if (
    job.completionState === "unknown_outcome_review_required" ||
    job.status === "unknown_outcome_review_required"
  ) {
    return "REVIEW_REQUIRED";
  }
  if (job.status === "succeeded" && (job.completionState === "unverified" || !job.completionState)) {
    return "PROCESS_OK / UNVERIFIED";
  }
  if (job.status === "timed_out" || job.completionState === "timed_out") {
    return "TIMED_OUT";
  }
  if (job.status === "cancelled" || job.completionState === "cancelled") {
    return "CANCELLED";
  }
  if (job.status === "failed" || job.completionState === "failed") {
    return "FAILED";
  }
  if (job.status === "running" || job.status === "starting") {
    return "RUNNING";
  }
  if (job.status === "queued") {
    return "QUEUED";
  }
  return "UNKNOWN";
}

export interface StartDelegateJobOptions {
  cliAlias: string;
  binary: string;
  prompt: string;
  cwd: string;
  workspaceRoot?: string;
  expectedArtifacts?: string[];
  idempotencyKey?: string;
  args: string[];
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  // Scheduler & multi-agent options
  priority?: JobPriority;
  resourceClass?: ResourceClass;
  projectId?: string;
  queueIfBusy?: boolean;
  roleProfile?: string;
  // Worktree options
  worktree?: boolean;
  baseCommitSha?: string;
  branchName?: string;
  cleanWorktreeOnSuccess?: boolean;
  // Resource claims
  resourceClaims?: ResourceClaimRequest[];
  // Acceptance contract
  acceptanceContract?: AcceptanceContract;
}

const STORAGE_DIR = path.join("cli-bridge", "delegations");
const STORAGE_FILE = "jobs.json";
const MAX_OUTPUT_TAIL_CHARS = 24_000;
const MAX_RETAINED_JOBS = 100;
const jobs = new Map<string, DelegateJob>();
const ownedJobIds = new Set<string>();
const processes = new Map<string, any>();
const runners = new Map<string, Promise<void>>();
const logQueues = new Map<string, Promise<void>>();
const cancellationRequested = new Set<string>();
const killTimers = new Map<string, ReturnType<typeof setTimeout>>();
const heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
const capacityLeases = new Map<string, CliBridgeCapacityLease>();
const progressFragments = new Map<string, string>();
/** In-process claims prevent simultaneous jobs from claiming the same output. */
const artifactClaims = new Map<string, string>();
const artifactBaselines = new Map<string, ArtifactBaseline[]>();
const jobClaims = new Map<string, string[]>();
const jobCrossProcessClaims = new Map<string, CrossProcessArtifactClaims>();

// Dynamic scheduler state
let currentEffectiveCapacity = DEFAULT_SCHEDULER_POLICY.configuredSlots;
let lastCapacityScaleTime = 0;
let lastConfiguredEnv: string | undefined = undefined;
let priorityQueue = new CliBridgePriorityQueue();
const queuedJobOptions = new Map<string, StartDelegateJobOptions>();
const jobWorktreeCleanups = new Map<string, boolean>();
const jobCustomClaims = new Map<string, ResourceClaimLease[]>();

async function releaseArtifactClaims(jobId: string): Promise<void> {
  const owned = jobCrossProcessClaims.get(jobId);
  try {
    if (owned) await releaseCrossProcessArtifactClaims(owned);
  } finally {
    jobCrossProcessClaims.delete(jobId);
    for (const file of jobClaims.get(jobId) ?? []) {
      if (artifactClaims.get(file) === jobId) artifactClaims.delete(file);
    }
    jobClaims.delete(jobId);
    artifactBaselines.delete(jobId);
  }
}

let initializePromise: Promise<void> | undefined;
let persistQueue: Promise<void> = Promise.resolve();
let currentOwnerIdentity: Promise<string | null> | undefined;

function getCurrentOwnerIdentity(): Promise<string | null> {
  currentOwnerIdentity ??= readProcessStartIdentity(process.pid);
  return currentOwnerIdentity;
}

function getStorageDir(): string { return path.join(getRootConfigDir(), STORAGE_DIR); }
function getStoragePath(): string { return path.join(getStorageDir(), STORAGE_FILE); }
function getQueueDir(): string { return path.join(getStorageDir(), "queue"); }

function activeStatus(status: DelegateJobStatus): boolean {
  return status === "starting" || status === "running" || status === "cancelling";
}

function activeJobCount(): number {
  return [...jobs.values()].filter((job) =>
    ownedJobIds.has(job.jobId) && activeStatus(job.status)).length;
}

export function getSchedulerContext(): {
  effectiveSlots: number;
  pressure: ResourcePressureLevel;
  configuredSlots: number;
  policy: SchedulerPolicy;
} {
  const active = [...jobs.values()].filter((j) => ownedJobIds.has(j.jobId) && activeStatus(j.status));
  const counts = {
    light: active.filter((j) => j.resourceClass === "light").length,
    normal: active.filter((j) => !j.resourceClass || j.resourceClass === "normal").length,
    heavy: active.filter((j) => j.resourceClass === "heavy").length,
    exclusive: active.filter((j) => j.resourceClass === "exclusive").length,
  };
  const sample = sampleSystemResources(counts);
  const configuredEnv = process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
  const configured = Number.parseInt(configuredEnv ?? "", 10);
  const configuredSlots = Number.isFinite(configured) && configured >= 1
    ? Math.max(1, Math.min(8, configured))
    : DEFAULT_SCHEDULER_POLICY.configuredSlots;

  const quotaEnv = process.env.SUPERAGENT_CLI_BRIDGE_PER_PROJECT_QUOTA;
  const parsedQuota = Number.parseInt(quotaEnv ?? "", 10);
  const perProjectQuota = Number.isFinite(parsedQuota) && parsedQuota >= 1
    ? Math.max(1, Math.min(8, parsedQuota))
    : Math.max(DEFAULT_SCHEDULER_POLICY.perProjectQuota, 4);

  if (configuredEnv !== lastConfiguredEnv) {
    lastConfiguredEnv = configuredEnv;
    currentEffectiveCapacity = configuredSlots;
    lastCapacityScaleTime = 0;
  }

  const policy: SchedulerPolicy = {
    ...DEFAULT_SCHEDULER_POLICY,
    minSlots: Math.min(2, configuredSlots),
    maxSlots: 8,
    configuredSlots,
    perProjectQuota,
  };
  const calc = calculateEffectiveSlots(
    sample,
    policy,
    currentEffectiveCapacity,
    lastCapacityScaleTime
  );
  currentEffectiveCapacity = calc.effectiveSlots;
  if (calc.changed) lastCapacityScaleTime = calc.timestamp;
  return {
    effectiveSlots: calc.effectiveSlots,
    pressure: sample.pressure,
    configuredSlots,
    policy,
  };
}

export function getRetainedJobCount(): number {
  return jobs.size;
}

export function getActiveJobCount(): number {
  return [...jobs.values()].filter((j) => activeStatus(j.status)).length;
}

export function getOwnedJobIdCount(): number {
  return ownedJobIds.size;
}

export function getLogQueueCount(): number {
  return logQueues.size;
}

export function pruneJobs(maxRetained = MAX_RETAINED_JOBS): number {
  const completed = [...jobs.values()]
    .filter((job) => !activeStatus(job.status))
    .sort((a, b) => b.startedAt - a.startedAt);
  let prunedCount = 0;
  for (const job of completed.slice(maxRetained)) {
    jobs.delete(job.jobId);
    ownedJobIds.delete(job.jobId);
    runners.delete(job.jobId);
    processes.delete(job.jobId);
    logQueues.delete(job.jobId);
    cancellationRequested.delete(job.jobId);
    progressFragments.delete(job.jobId);
    queuedJobOptions.delete(job.jobId);
    artifactBaselines.delete(job.jobId);
    jobClaims.delete(job.jobId);
    jobWorktreeCleanups.delete(job.jobId);
    jobCustomClaims.delete(job.jobId);
    prunedCount++;
  }
  try {
    pruneJobRevisions(new Set(jobs.keys()));
  } catch {}
  return prunedCount;
}

async function refreshJobShards(): Promise<void> {
  for (const job of await loadJobShards(getStorageDir())) {
    if (!ownedJobIds.has(job.jobId)) jobs.set(job.jobId, job);
  }
  pruneJobs();
}

async function persistQueuedJob(job: DelegateJob, opts: StartDelegateJobOptions): Promise<void> {
  const dir = getQueueDir();
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${job.jobId}.json`);
  const tmp = path.join(dir, `${job.jobId}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify({ job, opts }, null, 2), "utf8");
  await fs.rename(tmp, target);
}

async function removeQueuedJobFile(jobId: string): Promise<void> {
  await fs.rm(path.join(getQueueDir(), `${jobId}.json`), { force: true }).catch(() => {});
}

let isInitializing = false;

async function initialize(): Promise<void> {
  if (isInitializing) return;
  if (!initializePromise) {
    initializePromise = (async () => {
      isInitializing = true;
      try {
        await fs.mkdir(getStorageDir(), { recursive: true });
        await fs.mkdir(getQueueDir(), { recursive: true });

        for (const job of await loadLegacyJobs(getStoragePath())) {
          if (activeStatus(job.status)) {
            job.status = "interrupted";
            job.completionState = "interrupted";
            job.updatedAt = Date.now();
            job.error = "Legacy job has no reattachable process handle; inspect child processes.";
          }
          jobs.set(job.jobId, job);
        }
        await refreshJobShards();
        pruneJobs();

        // Crash reconciliation (M5.1): Inspect uncompleted jobs with checkpoints
        for (const job of jobs.values()) {
          if (activeStatus(job.status) && !ownedJobIds.has(job.jobId)) {
            const cp = await readJobCheckpoint(job.jobId).catch(() => null);
            if (cp) {
              const assessment = await reconcileJobOnRestart(job, cp);
              job.status = assessment.reconciledStatus as DelegateJobStatus;
              if (assessment.reconciledStatus === "unknown_outcome_review_required") {
                job.completionState = "unknown_outcome_review_required";
              }
              job.updatedAt = Date.now();
              job.error = assessment.reason;
              await persistJobShard(getStorageDir(), job).catch(() => {});
            }
          }
        }

        // Restore durable queued jobs across restart (M2.3)
        try {
          const qFiles = await fs.readdir(getQueueDir());
          for (const qf of qFiles) {
            if (!qf.endsWith(".json")) continue;
            try {
              const raw = await fs.readFile(path.join(getQueueDir(), qf), "utf8");
              const parsed = JSON.parse(raw);
              if (parsed.job && parsed.opts) {
                jobs.set(parsed.job.jobId, parsed.job);
                queuedJobOptions.set(parsed.job.jobId, parsed.opts);
                ownedJobIds.add(parsed.job.jobId);
                priorityQueue.enqueue({
                  jobId: parsed.job.jobId,
                  projectId: parsed.job.projectId ?? "default",
                  cliAlias: parsed.job.cliAlias,
                  priority: parsed.job.priority ?? "normal",
                  resourceClass: parsed.job.resourceClass ?? "normal",
                  createdAt: parsed.job.startedAt,
                });
              }
            } catch {}
          }
        } catch {}

        // Self-drain restored queue on startup if slots/quotas allow (M2.3 / S5)
        if (priorityQueue.size() > 0) {
          void drainQueue().catch(() => {});
        }

        // Reconcile and resume running DAGs across restart (M4.2 / S8)
        try {
          const { reconcileRunningDagsOnStartup } = await import("./cliBridgeDag.js");
          void reconcileRunningDagsOnStartup().catch(() => {});
        } catch {}
      } finally {
        isInitializing = false;
      }
    })().catch(error => { initializePromise = undefined; isInitializing = false; throw error; });
  }
  await initializePromise;
}

function persistJobs(): Promise<void> {
  persistQueue = persistQueue.catch(() => {}).then(async () => {
    const dir = getStorageDir();
    for (const id of ownedJobIds) {
      const job = jobs.get(id);
      if (job && (activeStatus(job.status) || runners.has(id) || !job.endedAt)) await persistJobShard(dir, job);
    }
    await writeCompatibilityJobsSnapshot(dir).catch(() => {});
  });
  return persistQueue;
}

function queueLog(jobId: string, logPath: string, chunk: string): void {
  if (!chunk) return;
  const previous = logQueues.get(jobId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => fs.appendFile(logPath, chunk, "utf8"));
  logQueues.set(jobId, next);
  void next.catch(() => {});
}

function applyAgyPermissionSignal(job: DelegateJob, signal: ReturnType<typeof inspectAgyBridgeLine>): void {
  if (signal.modeWarning) job.permissionWarning = signal.modeWarning;
  if (signal.finalPermissionDenied) {
    job.finalPermissionFailure = true;
    job.permissionFailure = signal.finalPermissionDenied;
    job.permissionRecovered = false;
    job.permissionRecoveryWarning = undefined;
    return;
  }
  if (signal.permissionDenied) job.permissionFailure = signal.permissionDenied;
  if (signal.finalResult && !job.finalPermissionFailure && job.permissionFailure) {
    job.permissionRecovered = true;
    job.permissionRecoveryWarning = `Earlier AGY permission denial was superseded by a clean final result: ${job.permissionFailure}`;
    job.permissionFailure = undefined;
  }
}

function updateOutput(job: DelegateJob, chunk: Buffer | string): void {
  const raw = chunk.toString();
  if (job.cliAlias === "agy") {
    const merged = (progressFragments.get(job.jobId) ?? "") + raw;
    const parts = merged.split(/\r?\n/);
    progressFragments.set(job.jobId, parts.pop()?.slice(-4096) ?? "");
    for (const part of parts) {
      const signal = inspectAgyBridgeLine(part);
      applyAgyPermissionSignal(job, signal);
      if (part.length > 65536 || !part.trimStart().startsWith("{")) continue;
      try {
        const record = JSON.parse(part) as Record<string, any>;
        if (!["init", "step_update", "result"].includes(record.event)) continue;
        job.activityEvents = (job.activityEvents ?? 0) + 1;
        job.lastProgressAt = Date.now();
        if (record.event === "init") job.currentStage = "AGY initialized";
        else if (record.event === "result") job.currentStage = "AGY returned final result";
        else {
          const step = record.step_update;
          const type = String(step?.step_type ?? "step").slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, "");
          const state = String(step?.state ?? "progress").slice(0, 24).replace(/[^a-zA-Z0-9_-]/g, "");
          job.currentStage = type + ": " + state;
        }
      } catch { /* other CLI output is not trusted JSON progress */ }
    }
  }
  const output = redactCliBridgeOutput(raw);
  job.outputTail = `${job.outputTail}${output}`.slice(-MAX_OUTPUT_TAIL_CHARS);
  job.outputBytes += Buffer.byteLength(output, "utf8");
  job.updatedAt = Date.now();
  job.lastOutputAt = job.updatedAt;
  queueLog(job.jobId, job.logPath, output);
}

function killProcessTree(jobId: string, proc: any): void {
  if (!proc) return;
  const pid = typeof proc.pid === "number" ? proc.pid : jobs.get(jobId)?.pid;
  if (process.platform === "win32" && pid) {
    spawnHiddenTaskkill(pid, true, "cliBridgeDelegateJobs.killProcessTree");
  } else if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { proc.kill?.("SIGTERM"); } catch {} }
  } else {
    try { proc.kill?.("SIGTERM"); } catch {}
  }
  const oldTimer = killTimers.get(jobId);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    if (process.platform === "win32" && pid) {
      spawnHiddenTaskkill(pid, true, "cliBridgeDelegateJobs.killProcessTreeDelayed");
    } else if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill?.("SIGKILL"); } catch {} }
    }
  }, 5_000);
  timer.unref?.();
  killTimers.set(jobId, timer);
}

async function drainQueue(): Promise<void> {
  while (priorityQueue.size() > 0) {
    const { effectiveSlots, pressure } = getSchedulerContext();
    const activeJobs = [...jobs.values()].filter((j) => ownedJobIds.has(j.jobId) && activeStatus(j.status));
    const activeRequests: ScheduledJobRequest[] = activeJobs.map((j) => ({
      jobId: j.jobId,
      projectId: j.projectId ?? "default",
      cliAlias: j.cliAlias,
      priority: j.priority ?? "normal",
      resourceClass: j.resourceClass ?? "normal",
      createdAt: j.startedAt,
    }));

    const next = priorityQueue.dequeueNextEligible(activeRequests, effectiveSlots, pressure);
    if (!next) break;

    const queuedJob = jobs.get(next.job.jobId);
    const queuedOpts = queuedJobOptions.get(next.job.jobId);
    if (!queuedJob || !queuedOpts) {
      priorityQueue.remove(next.job.jobId);
      continue;
    }

    queuedJobOptions.delete(next.job.jobId);
    await removeQueuedJobFile(next.job.jobId).catch(() => {});

    void launchJobExecution(queuedJob, queuedOpts, effectiveSlots).catch((err) => {
      queuedJob.status = "failed";
      queuedJob.completionState = "failed";
      queuedJob.error = err instanceof Error ? err.message : String(err);
      void persistJobs().catch(() => {});
    });
  }
}

async function finishJob(job: DelegateJob, proc: any, timeoutMs: number): Promise<void> {
  try {
    const result = await proc;
    if (result?.all && typeof result.all === "string") updateOutput(job, result.all);
    if (job.cliAlias === "agy") {
      const lastLine = progressFragments.get(job.jobId);
      if (lastLine) {
        const signal = inspectAgyBridgeLine(lastLine);
        applyAgyPermissionSignal(job, signal);
      }
    }
    job.exitCode = typeof result?.exitCode === "number" ? result.exitCode : null;
    job.timedOut = result?.timedOut === true;
    if (job.timedOut) killProcessTree(job.jobId, proc);
    if (cancellationRequested.has(job.jobId)) job.status = "cancelled";
    else if (job.timedOut) job.status = "timed_out";
    else if (job.permissionFailure) {
      job.status = "permission_blocked";
      job.completionState = "permission_blocked";
      job.error = job.permissionFailure + " " + AGY_PERMISSION_RECOVERY;
    } else if (job.exitCode === 0) {
      // 1. Acceptance contract verification (M3.2)
      if (job.acceptanceContract && Object.keys(job.acceptanceContract).length > 0) {
        const vResult = await executeAcceptanceVerification(job.cwd, job.acceptanceContract, {
          timeoutMs: job.timeoutMs,
          workspaceRoot: job.workspaceRoot ?? job.cwd,
        });
        job.verificationResult = vResult;
        if (vResult.state === "verified") {
          job.status = "succeeded";
          job.completionState = "verified";
        } else {
          job.status = "verification_failed";
          job.completionState = "verification_failed";
          job.error = vResult.failureReason || "Acceptance contract verification failed.";
        }
      } else {
        // 2. Legacy expectedArtifacts path
        const baseline = artifactBaselines.get(job.jobId);
        if (!baseline?.length) {
          job.status = "succeeded";
          job.completionState = "unverified";
        } else {
          const evidence = await inspectExpectedArtifacts(baseline, job.cwd, job.workspaceRoot ?? job.cwd);
          job.artifactEvidence = evidence;
          if (evidence.every(item => item.state === "created" || item.state === "updated")) {
            job.status = "succeeded";
            job.completionState = "artifacts_verified";
          } else {
            job.status = "verification_failed";
            job.completionState = "artifact_verification_failed";
            job.error = "CLI exited 0, but one or more expected artifact files were not newly created or changed.";
          }
        }
      }
    } else job.status = "failed";

    if (result?.failed && job.exitCode === null && !job.timedOut && !cancellationRequested.has(job.jobId)) {
      job.error = "The CLI process failed before returning an exit code.";
    }
  } catch (error) {
    job.status = cancellationRequested.has(job.jobId) ? "cancelled" : "failed";
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (cancellationRequested.has(job.jobId)) {
      job.status = "cancelled";
      job.completionState = "cancelled";
    }
    if (!job.completionState || job.completionState === "pending") {
      job.completionState = job.status === "cancelled" ? "cancelled"
        : job.status === "timed_out" ? "timed_out" : "failed";
    }

    // Inspect git worktree commit provenance if worktree was used (M1.7 & M3.1)
    if (job.worktreePath) {
      try {
        job.worktreeProvenance = await inspectWorktreeProvenance(job.worktreePath, job.baseCommitSha);
      } catch {}
      if (jobWorktreeCleanups.get(job.jobId) && job.status === "succeeded") {
        await removeIsolatedWorktree({
          repoRoot: job.workspaceRoot ?? job.cwd,
          worktreePath: job.worktreePath,
          branchName: job.branchName,
        }).catch(() => {});
      }
      jobWorktreeCleanups.delete(job.jobId);
    }

    // Release custom resource claims (M3.1)
    const customClaims = jobCustomClaims.get(job.jobId);
    if (customClaims) {
      try {
        await releaseResourceClaims(customClaims);
      } catch (error) {
        job.error = [job.error, "Resource claim cleanup needs operator review: " + (error instanceof Error ? error.message : String(error))].filter(Boolean).join("; ");
      } finally {
        jobCustomClaims.delete(job.jobId);
      }
    }

    try {
      const lease = capacityLeases.get(job.jobId);
      if (lease) {
        await releaseCliBridgeCapacity(lease);
        capacityLeases.delete(job.jobId);
      }
    } catch (error) {
      job.error = [job.error, "Capacity slot cleanup needs operator review: " + (error instanceof Error ? error.message : String(error))].filter(Boolean).join("; ");
    }
    try {
      await releaseArtifactClaims(job.jobId);
    } catch (error) {
      job.error = [job.error, "Artifact lock cleanup needs operator review: " + (error instanceof Error ? error.message : String(error))].filter(Boolean).join("; ");
    }

    const pulse = heartbeatTimers.get(job.jobId);
    if (pulse) clearInterval(pulse);
    heartbeatTimers.delete(job.jobId);
    const timer = killTimers.get(job.jobId);
    if (timer) clearTimeout(timer);
    killTimers.delete(job.jobId);
    job.endedAt = Date.now();
    job.updatedAt = job.endedAt;
    job.durationMs = job.endedAt - job.startedAt;
    if (job.processRecordId) {
      void getProcessSupervisor().recordProcessExit(job.processRecordId, {
        exitCode: job.exitCode,
        signal: null,
        source: "cliBridgeDelegateJobs.finishJob",
      }).catch(() => {});
    }
    job.pid = null;
    job.processState = job.status;
    job.verificationState = job.verificationResult?.state ?? job.completionState ?? "unverified";
    job.taskOutcome = getTaskOutcome(job);
    job.evidenceCount =
      (job.artifactEvidence?.length ?? 0) +
      (job.verificationResult?.artifactDetails?.length ?? 0) +
      (job.verificationResult?.commandResults?.length ?? 0);
    job.verifiedAt = job.verificationResult?.verifiedAt;
    job.failureReason = job.error ?? job.verificationResult?.failureReason;
    processes.delete(job.jobId);
    progressFragments.delete(job.jobId);
    cancellationRequested.delete(job.jobId);
    await (logQueues.get(job.jobId) ?? Promise.resolve()).catch(() => {});
    queueLog(job.jobId, job.logPath, `\n\n[CLI Bridge job finished: status=${job.status} proof=${job.completionState} exit=${job.exitCode ?? "?"} timedOut=${job.timedOut} duration=${job.durationMs}ms timeout=${timeoutMs}ms]\n`);
    await (logQueues.get(job.jobId) ?? Promise.resolve()).catch(() => {});
    logQueues.delete(job.jobId);

    // Write final checkpoint (M5.1)
    await writeJobCheckpoint({
      checkpointId: `cp_${job.jobId}_term`,
      jobId: job.jobId,
      timestamp: job.endedAt,
      lastEvent: `job_finished_${job.status}`,
      worktreePath: job.worktreePath,
      branchName: job.branchName,
      resourceClaims: jobClaims.get(job.jobId) ?? [],
      ownerProcessIdentity: job.ownerProcessIdentity,
      childProcessIdentity: job.childProcessIdentity,
      verificationState: job.completionState ?? "unknown",
      hasMutatingWrite: Boolean(job.expectedArtifacts?.length || job.worktreePath),
    }).catch(() => {});

    await persistJobs();
    ownedJobIds.delete(job.jobId);
    runners.delete(job.jobId);
    pruneJobs();

    // Notify listeners and UI
    try {
      const { notifyTasksChanged } = await import("./state.js");
      notifyTasksChanged();
    } catch {}

    // Wake and drain priority queue (M2.3)
    void drainQueue().catch(() => {});
  }
}

async function launchJobExecution(
  job: DelegateJob,
  opts: StartDelegateJobOptions,
  effectiveCapacitySlots: number
): Promise<void> {
  ownedJobIds.add(job.jobId);
  const claimKeys = jobClaims.get(job.jobId) ?? [];
  if (!job.logPath) {
    job.logPath = path.join(getRootConfigDir(), "logs", "cli-bridge", `job-${job.jobId}.log`);
  }
  const logDir = path.dirname(job.logPath);

  try {
    job.ownerProcessIdentity = (await getCurrentOwnerIdentity()) ?? undefined;

    // Checkpoint at start (M5.1)
    await writeJobCheckpoint({
      checkpointId: `cp_${job.jobId}_start`,
      jobId: job.jobId,
      timestamp: job.startedAt,
      lastEvent: "job_started",
      worktreePath: job.worktreePath,
      branchName: job.branchName,
      resourceClaims: claimKeys,
      ownerProcessIdentity: job.ownerProcessIdentity,
      verificationState: "pending",
      hasMutatingWrite: Boolean(job.expectedArtifacts?.length || job.worktreePath),
    }).catch(() => {});

    // Worktree isolation setup (M1.7 & M3.1)
    if (opts.worktree) {
      const repoRoot = opts.workspaceRoot ?? opts.cwd;
      const branchName = opts.branchName || `agent-wt-${job.jobId}`;
      const wtMeta = await createIsolatedWorktree({
        repoRoot,
        baseCommitSha: opts.baseCommitSha,
        branchName,
      });
      job.worktreePath = wtMeta.worktreePath;
      job.branchName = wtMeta.branchName;
      job.baseCommitSha = wtMeta.baseCommitSha;
      job.cwd = wtMeta.worktreePath;
      if (opts.cleanWorktreeOnSuccess) {
        jobWorktreeCleanups.set(job.jobId, true);
      }
    }

    // Resource claims acquisition (M3.1)
    if (opts.resourceClaims && opts.resourceClaims.length > 0) {
      const claimLeases = await acquireResourceClaims(opts.resourceClaims, job.jobId);
      job.resourceClaimLeases = claimLeases;
      jobCustomClaims.set(job.jobId, claimLeases);
    }

    const artifactFiles = resolveExpectedArtifacts(job.cwd, job.workspaceRoot ?? job.cwd, opts.expectedArtifacts);
    if (artifactFiles.length) {
      jobCrossProcessClaims.set(job.jobId, await acquireCrossProcessArtifactClaims(claimKeys, job.jobId));
      artifactBaselines.set(job.jobId, await snapshotExpectedArtifacts(artifactFiles, job.workspaceRoot ?? job.cwd));
    }

    // Dynamic capacity acquisition (M2.2)
    const lease = await acquireCliBridgeCapacity(effectiveCapacitySlots, job.jobId, {
      ownerProcessIdentity: job.ownerProcessIdentity,
      cliAlias: opts.cliAlias,
      workspaceDigest: job.workspaceRoot ? crypto.createHash("sha256").update(job.workspaceRoot).digest("hex").slice(0, 16) : undefined,
    });
    capacityLeases.set(job.jobId, lease);
    job.capacitySlot = lease.index;

    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(
      job.logPath,
      `[CLI Bridge job ${job.jobId}]\nCLI: ${opts.cliAlias}\nWorking directory: ${job.cwd}\nTimeout: ${opts.timeoutMs}ms\n--- output ---\n`,
      "utf8"
    );
    await persistJobs();
  } catch (error) {
    job.status = "failed";
    job.completionState = "failed";
    const lease = capacityLeases.get(job.jobId);
    if (lease) { await releaseCliBridgeCapacity(lease).catch(() => {}); capacityLeases.delete(job.jobId); }
    const customClaims = jobCustomClaims.get(job.jobId);
    if (customClaims) { await releaseResourceClaims(customClaims).catch(() => {}); jobCustomClaims.delete(job.jobId); }
    await releaseArtifactClaims(job.jobId).catch(() => {});
    job.error = error instanceof Error ? error.message : String(error);
    job.endedAt = Date.now();
    job.durationMs = job.endedAt - job.startedAt;
    if (job.processRecordId) {
      void getProcessSupervisor().recordProcessExit(job.processRecordId, {
        exitCode: job.exitCode,
        signal: null,
        source: "cliBridgeDelegateJobs.finishJob",
      }).catch(() => {});
    }
    job.updatedAt = job.endedAt;
    await persistJobs().catch(() => {});
    throw error;
  }

  let runArgs = opts.args ? [...opts.args] : [];
  const binaryBase = path.basename(opts.binary).toLowerCase();
  const isAgyBinary = binaryBase === "agy" || binaryBase === "agy.exe" || binaryBase === "agy.cmd" || binaryBase === "agy.bat";
  if (isAgyBinary && opts.prompt) {
    const hasPrint = runArgs.includes("-p") || runArgs.includes("--print") || runArgs.includes("-i");
    if (!hasPrint) {
      const mode = opts.roleProfile === "reviewer" || opts.roleProfile === "architect" ? "plan" : "accept-edits";
      runArgs = ["--mode", mode, "-p", opts.prompt, ...runArgs];
    }
  }

  let proc: any;
  const resolvedJobBinary = resolveWindowsDirectExecutable(opts.binary, opts.env ?? process.env);
  try {
    const reg = await getProcessSupervisor().registerProcess({
      component: "cli_bridge",
      jobId: job.jobId,
      workspaceRoot: job.workspaceRoot ?? job.cwd,
      executable: resolvedJobBinary,
      args: runArgs,
      launchIntent: "headless",
      cleanupPolicy: "caller_owned",
    });
    job.processRecordId = reg.recordId;
  } catch {}
  try {
    const jobExecOpts = applyProcessIntent({
      cwd: job.cwd, all: true, buffer: false, reject: false,
      env: opts.env ?? process.env, input: opts.prompt, timeout: opts.timeoutMs,
      forceKillAfterDelay: 5_000, detached: process.platform !== "win32",
    }, "headless");
    proc = traceChildProcess(
      execa(resolvedJobBinary, runArgs, jobExecOpts),
      {
        caller: "cliBridgeDelegateJobs.launchDelegateJob",
        executable: resolvedJobBinary,
        args: runArgs,
        cwd: job.cwd,
        intent: "headless",
        options: jobExecOpts,
      }
    );
  } catch (error) {
    job.status = "failed";
    job.completionState = "failed";
    const lease = capacityLeases.get(job.jobId);
    if (lease) { await releaseCliBridgeCapacity(lease).catch(() => {}); capacityLeases.delete(job.jobId); }
    const customClaims = jobCustomClaims.get(job.jobId);
    if (customClaims) { await releaseResourceClaims(customClaims).catch(() => {}); jobCustomClaims.delete(job.jobId); }
    await releaseArtifactClaims(job.jobId).catch(() => {});
    job.error = error instanceof Error ? error.message : String(error);
    job.endedAt = Date.now();
    job.durationMs = job.endedAt - job.startedAt;
    if (job.processRecordId) {
      void getProcessSupervisor().recordProcessExit(job.processRecordId, {
        exitCode: job.exitCode,
        signal: null,
        source: "cliBridgeDelegateJobs.finishJob",
      }).catch(() => {});
    }
    job.updatedAt = job.endedAt;
    await persistJobs().catch(() => {});
    throw error;
  }

  processes.set(job.jobId, proc);
  job.pid = typeof proc.pid === "number" ? proc.pid : null;
  job.status = "running";
  job.updatedAt = Date.now();
  if (job.processRecordId && job.pid) {
    void getProcessSupervisor().recordProcessSpawn(job.processRecordId, job.pid).catch(() => {});
  }
  const initialLease = capacityLeases.get(job.jobId);
  if (initialLease && job.pid) {
    void updateCliBridgeCapacity(initialLease, { childPid: job.pid });
  }

  const wireOutput = (stream: any) => {
    const decoder = new StringDecoder("utf8");
    stream?.on("data", (chunk: Buffer | string) => {
      const cleanChunk = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (cleanChunk) updateOutput(job, cleanChunk);
    });
    stream?.on("end", () => {
      const remaining = decoder.end();
      if (remaining) updateOutput(job, remaining);
    });
  };
  if (proc.all) wireOutput(proc.all);
  else {
    wireOutput(proc.stderr);
    wireOutput(proc.stdout);
  }

  const runner = finishJob(job, proc, opts.timeoutMs);
  runners.set(job.jobId, runner);

  const pulse = setInterval(() => {
    if (!activeStatus(job.status)) return;
    job.heartbeatAt = Date.now();
    if (job.processRecordId) {
      void getProcessSupervisor().recordProcessHeartbeat(job.processRecordId).catch(() => {});
    }
    const currentLease = capacityLeases.get(job.jobId);
    if (currentLease) {
      void updateCliBridgeCapacity(currentLease, { heartbeatAt: job.heartbeatAt });
    }
    void persistJobs().catch(() => {});
  }, 20_000);
  pulse.unref?.();
  heartbeatTimers.set(job.jobId, pulse);

  void readProcessStartIdentity(job.pid).then(async identity => {
    if (!identity || !activeStatus(job.status)) return;
    job.childProcessIdentity = identity;
    if (job.processRecordId) {
      void getProcessSupervisor().recordProcessIdentity(job.processRecordId, identity).catch(() => {});
    }
    const currentLease = capacityLeases.get(job.jobId);
    if (currentLease) {
      void updateCliBridgeCapacity(currentLease, { childProcessIdentity: identity });
    }
    await persistJobs().catch(() => {});
  }).catch(() => {});

  await persistJobs().catch((error) => {
    job.error = `Job started, but metadata persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  });
}

export async function startDelegateJob(opts: StartDelegateJobOptions): Promise<DelegateJob> {
  await initialize();
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > 7_200_000) {
    throw new Error("Background delegation timeoutMs must be between 1000 and 7200000 (2 hours).");
  }
  if (opts.idempotencyKey !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(opts.idempotencyKey)) {
    throw new Error("CLI Bridge idempotencyKey must be 1–120 safe characters.");
  }

  // Role profile default resolution (M4.1)
  if (opts.roleProfile) {
    const profile = getRoleProfile(opts.roleProfile);
    if (profile) {
      opts.resourceClass ??= profile.resourceClass;
      opts.priority ??= "normal";
      if (opts.worktree === undefined && profile.worktreePolicy === "isolated") {
        opts.worktree = true;
      }
      opts.acceptanceContract ??= profile.defaultAcceptance;
      opts.prompt = `${profile.systemInstructions}\n\n${opts.prompt}`;
    }
  }

  const digest = summarizedPrompt(opts.prompt);
  if (opts.idempotencyKey) {
    await refreshJobShards();
    const existing = [...jobs.values()].find(job => job.idempotencyKey === opts.idempotencyKey &&
      job.workspaceRoot === (opts.workspaceRoot ?? opts.cwd));
    if (existing) {
      if (existing.cliAlias !== opts.cliAlias || existing.promptDigest !== digest) {
        throw new Error("Idempotency key already belongs to another CLI/prompt in this workspace.");
      }
      return { ...existing };
    }
  }

  // Adaptive scheduler & admission control (M2.1, M2.2, M2.3)
  const { effectiveSlots, pressure, configuredSlots, policy } = getSchedulerContext();
  const projectId = opts.projectId ?? (opts.workspaceRoot ? crypto.createHash("sha256").update(opts.workspaceRoot).digest("hex").slice(0, 12) : "default");
  const priority: JobPriority = opts.priority ?? "normal";
  const resourceClass: ResourceClass = opts.resourceClass ?? "normal";

  const scheduledRequest: ScheduledJobRequest = {
    jobId: "", // will be assigned below
    projectId,
    cliAlias: opts.cliAlias,
    priority,
    resourceClass,
    createdAt: Date.now(),
  };

  const activeJobs = [...jobs.values()].filter((j) => ownedJobIds.has(j.jobId) && activeStatus(j.status));
  const activeScheduledRequests: ScheduledJobRequest[] = activeJobs.map((j) => ({
    jobId: j.jobId,
    projectId: j.projectId ?? "default",
    cliAlias: j.cliAlias,
    priority: j.priority ?? "normal",
    resourceClass: j.resourceClass ?? "normal",
    createdAt: j.startedAt,
  }));

  const artifactFiles = resolveExpectedArtifacts(opts.cwd, opts.workspaceRoot ?? opts.cwd, opts.expectedArtifacts);
  const claimKeys = artifactFiles.map(artifactClaimIdentity);
  const locked = claimKeys.find(file => artifactClaims.has(file));
  if (locked) throw new Error("CLI Bridge artifact claim already held by an active delegation in this process.");

  const startedAt = Date.now();
  const jobId = `clj_${startedAt}_${crypto.randomBytes(4).toString("hex")}`;
  scheduledRequest.jobId = jobId;

  const creator = getTlineCreatorForJob(opts.workspaceRoot ?? opts.cwd);
  const logDir = path.join(getRootConfigDir(), "logs", "cli-bridge");
  const logPath = path.join(logDir, `job-${jobId}.log`);

  const job: DelegateJob = {
    jobId, cliAlias: opts.cliAlias, binary: opts.binary, cwd: opts.cwd,
    workspaceRoot: opts.workspaceRoot ?? opts.cwd,
    ...(creator ? { creator } : {}),
    expectedArtifacts: opts.expectedArtifacts?.slice(),
    idempotencyKey: opts.idempotencyKey,
    promptDigest: digest,
    completionState: "pending",
    pid: null,
    ownerPid: process.pid,
    status: "starting", startedAt, updatedAt: startedAt, heartbeatAt: startedAt, exitCode: null, timedOut: false, timeoutMs: opts.timeoutMs,
    outputTail: "", outputBytes: 0, logPath,
    priority,
    resourceClass,
    projectId,
    roleProfile: opts.roleProfile,
    acceptanceContract: opts.acceptanceContract,
  };

  // Evaluate admission against dynamic capacity and quotas
  const decision = evaluateJobAdmission(
    scheduledRequest,
    activeScheduledRequests,
    effectiveSlots,
    pressure,
    policy
  );

  if (!decision.admitted) {
    if (opts.queueIfBusy) {
      job.status = "queued";
      jobs.set(jobId, job);
      ownedJobIds.add(jobId);
      queuedJobOptions.set(jobId, opts);
      priorityQueue.enqueue(scheduledRequest);
      await persistQueuedJob(job, opts);
      await persistJobs();
      return { ...job };
    }
    throw new Error(`CLI Bridge concurrency limit reached (${decision.reason ?? "capacity full"}). Wait for a job to finish or cancel one, then retry.`);
  }

  // Reserve slot
  jobs.set(jobId, job);
  ownedJobIds.add(jobId);
  jobClaims.set(jobId, claimKeys);
  for (const file of claimKeys) artifactClaims.set(file, jobId);

  await launchJobExecution(job, opts, effectiveSlots);
  return { ...job };
}

async function awaitTerminalPersistence(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  const runningFinalizer = runners.get(jobId);
  if (job && !activeStatus(job.status) && runningFinalizer) {
    await runningFinalizer.catch(() => {});
  }
}

export async function listDelegateJobs(): Promise<DelegateJob[]> {
  await initialize();
  await refreshJobShards();
  await Promise.all([...jobs.keys()].map(awaitTerminalPersistence));
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map((job) => ({ ...job, outputTail: "" }));
}

export async function getDelegateJob(jobId: string): Promise<DelegateJob | null> {
  await initialize();
  await refreshJobShards();
  await awaitTerminalPersistence(jobId);
  const job = jobs.get(jobId);
  return job ? { ...job } : null;
}

export async function tailDelegateJob(jobId: string, limit = 200): Promise<{ job: DelegateJob; output: string } | null> {
  await initialize();
  await refreshJobShards();
  await awaitTerminalPersistence(jobId);
  const job = jobs.get(jobId);
  if (!job) return null;
  const safeLimit = Math.max(1, Math.min(2_000, Math.floor(limit) || 200));
  try {
    return { job: { ...job }, output: await readBoundedLogTail(job.logPath, safeLimit) };
  } catch {
    return { job: { ...job }, output: job.outputTail || "(no output captured yet)" };
  }
}

export async function cancelDelegateJob(jobId: string): Promise<{ ok: boolean; message: string; job?: DelegateJob }> {
  await initialize();
  await refreshJobShards();
  const job = jobs.get(jobId);
  if (!job) return { ok: false, message: `No CLI Bridge delegation job found with id ${jobId}.` };
  if (job.status === "queued") {
    priorityQueue.remove(jobId);
    queuedJobOptions.delete(jobId);
    await removeQueuedJobFile(jobId).catch(() => {});
    job.status = "cancelled";
    job.completionState = "cancelled";
    job.updatedAt = Date.now();
    await persistJobs();
    return { ok: true, message: `Queued job ${jobId} was cancelled before starting.`, job: { ...job } };
  }
  if (!activeStatus(job.status)) return { ok: false, message: `Job ${jobId} is already ${job.status}.`, job: { ...job } };
  const proc = processes.get(jobId);
  if (!proc) return { ok: false, message: `Job ${jobId} has no process handle; inspect its log.`, job: { ...job } };
  cancellationRequested.add(jobId);
  job.status = "cancelling";
  job.updatedAt = Date.now();
  killProcessTree(jobId, proc);
  await persistJobs();
  return { ok: true, message: `Cancellation requested for ${jobId}; poll delegate.get to confirm it has exited.`, job: { ...job } };
}

export async function getDelegateJobRecovery(jobId: string): Promise<DelegateRecoveryDiagnostic | null> {
  const job = await getDelegateJob(jobId);
  if (!job) return null;
  const ownerIdentityObservation = await readProcessStartIdentity(job.ownerPid);
  const childIdentityObservation = await readProcessStartIdentity(job.pid);
  return classifyDelegateRecovery(job, {
    ownedByCurrentRuntime: ownedJobIds.has(jobId) && processes.has(jobId),
    ownerIdentityObservation, childIdentityObservation,
  });
}

export function getQueuedJobCount(): number {
  return priorityQueue.size();
}

export function __populateCompletedJobsForTests(jobsList: DelegateJob[]): void {
  for (const j of jobsList) {
    jobs.set(j.jobId, j);
  }
}

export async function __resetDelegateJobsForTests(opts?: { keepDiskFiles?: boolean }): Promise<void> {
  for (const [jobId, proc] of [...processes.entries()]) {
    cancellationRequested.add(jobId);
    killProcessTree(jobId, proc);
  }
  await Promise.allSettled([...runners.values()]);
  for (const timer of killTimers.values()) clearTimeout(timer);
  const ownedForCleanup = [...ownedJobIds];
  for (const pulse of heartbeatTimers.values()) clearInterval(pulse);
  heartbeatTimers.clear();
  progressFragments.clear();
  jobs.clear(); processes.clear(); runners.clear(); logQueues.clear(); cancellationRequested.clear(); killTimers.clear();
  ownedJobIds.clear();
  await Promise.allSettled([...jobCrossProcessClaims.keys()].map(releaseArtifactClaims));
  await Promise.allSettled([...jobCustomClaims.values()].map(releaseResourceClaims));
  jobCustomClaims.clear();
  await Promise.allSettled([...capacityLeases.values()].map(releaseCliBridgeCapacity));
  capacityLeases.clear();
  artifactClaims.clear(); artifactBaselines.clear(); jobClaims.clear(); jobCrossProcessClaims.clear();
  priorityQueue = new CliBridgePriorityQueue();
  queuedJobOptions.clear();
  jobWorktreeCleanups.clear();
  currentEffectiveCapacity = DEFAULT_SCHEDULER_POLICY.configuredSlots;
  lastCapacityScaleTime = 0;
  lastConfiguredEnv = undefined;
  initializePromise = undefined;
  isInitializing = false;
  persistQueue = Promise.resolve();
  if (!opts?.keepDiskFiles) {
    for (const id of ownedForCleanup) await fs.rm(jobShardPath(getStorageDir(), id), { recursive: true, force: true }).catch(() => {});
    await fs.rm(getQueueDir(), { recursive: true, force: true }).catch(() => {});
    try { await fs.rm(getStoragePath(), { force: true }); } catch {}
  }
}
