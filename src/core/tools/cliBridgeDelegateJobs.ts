/**
 * Long-running, pollable one-shot CLI delegations for MCP callers.
 * These jobs return quickly, run concurrently, persist metadata, and log all output.
 */
import { execa } from "execa";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import {
  resolveExpectedArtifacts, snapshotExpectedArtifacts, inspectExpectedArtifacts, artifactClaimIdentity,
  type ArtifactBaseline, type ArtifactEvidence,
} from "./cliBridgeArtifactEvidence.js";
import {
  acquireCrossProcessArtifactClaims, releaseCrossProcessArtifactClaims,
  type CrossProcessArtifactClaims,
} from "./cliBridgeCrossProcessClaims.js";
import { persistJobShard, loadJobShards, loadLegacyJobs, writeCompatibilityJobsSnapshot, jobShardPath } from "./cliBridgeJobStore.js";
import { classifyDelegateRecovery, type DelegateRecoveryDiagnostic } from "./cliBridgeRecovery.js";
import { readProcessStartIdentity } from "./cliBridgeProcessIdentity.js";
import { getTlineCreatorForJob } from "../channels/tlineJobCreator.js";
import { inspectAgyBridgeLine, AGY_PERMISSION_RECOVERY } from "./cliBridgeAgyPermissions.js";
import { readBoundedLogTail, redactCliBridgeOutput, summarizedPrompt } from "./cliBridgeObservability.js";
import { acquireCliBridgeCapacity, releaseCliBridgeCapacity, type CliBridgeCapacityLease } from "./cliBridgeCapacity.js";

export type DelegateJobStatus =
  | "starting" | "running" | "cancelling" | "succeeded" | "failed" | "timed_out" | "cancelled" | "interrupted" | "verification_failed" | "permission_blocked";

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
  completionState?: "pending" | "artifacts_verified" | "unverified" | "artifact_verification_failed" | "failed" | "timed_out" | "cancelled" | "interrupted" | "permission_blocked";
  /** Diagnostic only: no permission escalation or automatic retries. */
  permissionWarning?: string;
  permissionFailure?: string;
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
}

const STORAGE_DIR = path.join("cli-bridge", "delegations");
const STORAGE_FILE = "jobs.json";
const MAX_OUTPUT_TAIL_CHARS = 24_000;
const MAX_RETAINED_JOBS = 100;
const DEFAULT_MAX_CONCURRENT_JOBS = 4;
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
// Computed once per SuperAgent process so parallel delegations do not issue
// duplicate OS/CIM probes for the same long-lived parent.
let currentOwnerIdentity: Promise<string | null> | undefined;
function getCurrentOwnerIdentity(): Promise<string | null> {
  currentOwnerIdentity ??= readProcessStartIdentity(process.pid);
  return currentOwnerIdentity;
}

function getStorageDir(): string { return path.join(getRootConfigDir(), STORAGE_DIR); }
function getStoragePath(): string { return path.join(getStorageDir(), STORAGE_FILE); }
function activeStatus(status: DelegateJobStatus): boolean {
  return status === "starting" || status === "running" || status === "cancelling";
}
function activeJobCount(): number {
  return [...jobs.values()].filter((job) => activeStatus(job.status)).length;
}
function maxConcurrentJobs(): number {
  const configured = Number.parseInt(process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS ?? "", 10);
  if (!Number.isFinite(configured) || configured < 1) return DEFAULT_MAX_CONCURRENT_JOBS;
  return Math.min(12, configured);
}
function pruneJobs(): void {
  const completed = [...jobs.values()].filter((job) => !activeStatus(job.status)).sort((a, b) => b.startedAt - a.startedAt);
  for (const job of completed.slice(MAX_RETAINED_JOBS)) jobs.delete(job.jobId);
}

async function refreshJobShards(): Promise<void> {
  for (const job of await loadJobShards(getStorageDir())) {
    if (!ownedJobIds.has(job.jobId)) jobs.set(job.jobId, job);
  }
}
async function initialize(): Promise<void> {
  if (!initializePromise) {
    initializePromise = (async () => {
      await fs.mkdir(getStorageDir(), { recursive: true });
      for (const job of await loadLegacyJobs(getStoragePath())) {
        // Old snapshots have no owner identity: never infer that their
        // apparently running subprocesses can safely be cancelled.
        if (activeStatus(job.status)) {
          job.status = "interrupted";
          job.completionState = "interrupted";
          job.updatedAt = Date.now();
          job.error = "Legacy job has no reattachable process handle; inspect child processes.";
        }
        jobs.set(job.jobId, job);
      }
      await refreshJobShards();
    })().catch(error => { initializePromise = undefined; throw error; });
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
function updateOutput(job: DelegateJob, chunk: Buffer | string): void {
  const raw = chunk.toString();
  if (job.cliAlias === "agy") {
    const merged = (progressFragments.get(job.jobId) ?? "") + raw;
    const parts = merged.split(/\r?\n/);
    progressFragments.set(job.jobId, parts.pop()?.slice(-4096) ?? "");
    for (const part of parts) {
      const signal = inspectAgyBridgeLine(part);
      if (signal.modeWarning) job.permissionWarning = signal.modeWarning;
      if (signal.permissionDenied) job.permissionFailure = signal.permissionDenied;
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
    try { spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch {}
  } else if (pid) {
    try { process.kill(-pid, "SIGTERM"); } catch { try { proc.kill?.("SIGTERM"); } catch {} }
  } else {
    try { proc.kill?.("SIGTERM"); } catch {}
  }
  const oldTimer = killTimers.get(jobId);
  if (oldTimer) clearTimeout(oldTimer);
  const timer = setTimeout(() => {
    if (process.platform === "win32" && pid) {
      try { spawn("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }).on("error", () => {}); } catch {}
    } else if (pid) {
      try { process.kill(-pid, "SIGKILL"); } catch { try { proc.kill?.("SIGKILL"); } catch {} }
    }
  }, 5_000);
  timer.unref?.();
  killTimers.set(jobId, timer);
}

async function finishJob(job: DelegateJob, proc: any, timeoutMs: number): Promise<void> {
  try {
    const result = await proc;
    if (result?.all && typeof result.all === "string") updateOutput(job, result.all);
    // A final NDJSON record may arrive without a trailing newline.
    if (job.cliAlias === "agy") {
      const lastLine = progressFragments.get(job.jobId);
      if (lastLine) {
        const signal = inspectAgyBridgeLine(lastLine);
        if (signal.modeWarning) job.permissionWarning = signal.modeWarning;
        if (signal.permissionDenied) job.permissionFailure = signal.permissionDenied;
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
    } else job.status = "failed";
    if (result?.failed && job.exitCode === null && !job.timedOut && !cancellationRequested.has(job.jobId)) {
      job.error = "The CLI process failed before returning an exit code.";
    }
  } catch (error) {
    job.status = cancellationRequested.has(job.jobId) ? "cancelled" : "failed";
    job.error = error instanceof Error ? error.message : String(error);
  } finally {
    // Cancellation can race with asynchronous artifact hashing after process exit.
    if (cancellationRequested.has(job.jobId)) {
      job.status = "cancelled";
      job.completionState = "cancelled";
    }
    if (!job.completionState || job.completionState === "pending") {
      job.completionState = job.status === "cancelled" ? "cancelled"
        : job.status === "timed_out" ? "timed_out" : "failed";
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
    job.pid = null;
    processes.delete(job.jobId);
    progressFragments.delete(job.jobId);
    cancellationRequested.delete(job.jobId);
    await (logQueues.get(job.jobId) ?? Promise.resolve()).catch(() => {});
    logQueues.delete(job.jobId);
    queueLog(job.jobId, job.logPath, `\n\n[CLI Bridge job finished: status=${job.status} proof=${job.completionState} exit=${job.exitCode ?? "?"} timedOut=${job.timedOut} duration=${job.durationMs}ms timeout=${timeoutMs}ms]\n`);
    await (logQueues.get(job.jobId) ?? Promise.resolve()).catch(() => {});
    // Publish a terminal read only after persisted metadata catches up.
    // The runner remains tracked until this write finishes.
    await persistJobs();
    runners.delete(job.jobId);
    try {
      const { notifyTasksChanged } = await import("./state.js");
      notifyTasksChanged();
    } catch {}
  }
}

export async function startDelegateJob(opts: StartDelegateJobOptions): Promise<DelegateJob> {
  await initialize();
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1_000 || opts.timeoutMs > 7_200_000) {
    throw new Error("Background delegation timeoutMs must be between 1000 and 7200000 (2 hours).");
  }
  if (opts.idempotencyKey !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/.test(opts.idempotencyKey)) {
    throw new Error("CLI Bridge idempotencyKey must be 1–120 safe characters.");
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
      return { ...existing }; // do not rerun an already dispatched request
    }
  }
  const cap = maxConcurrentJobs();
  const count = activeJobCount();
  if (count >= cap) throw new Error(`CLI Bridge concurrency limit reached (${count}/${cap}). Wait for a job to finish or cancel one, then retry.`);
  const artifactFiles = resolveExpectedArtifacts(opts.cwd, opts.workspaceRoot ?? opts.cwd, opts.expectedArtifacts);
  const claimKeys = artifactFiles.map(artifactClaimIdentity);
  const locked = claimKeys.find(file => artifactClaims.has(file));
  if (locked) throw new Error("CLI Bridge artifact claim already held by an active delegation in this process.");

  const startedAt = Date.now();
  const jobId = `clj_${startedAt}_${crypto.randomBytes(4).toString("hex")}`;
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
  };

  // Reserve the concurrency slot synchronously before any filesystem I/O.
  // Without this reservation, simultaneous MCP calls can both pass the cap
  // check and start more children than SUPERAGENT_CLI_BRIDGE_MAX_JOBS allows.
  jobs.set(jobId, job);
  ownedJobIds.add(jobId);
  jobClaims.set(jobId, claimKeys);
  for (const file of claimKeys) artifactClaims.set(file, jobId);
  try {
    job.ownerProcessIdentity = (await getCurrentOwnerIdentity()) ?? undefined;
    if (artifactFiles.length) {
      // The per-process reservation happens before this await. Other SuperAgent
      // instances must acquire the same host-local exclusive claims before
      // reading pre-run baselines or spawning a child.
      jobCrossProcessClaims.set(jobId, await acquireCrossProcessArtifactClaims(claimKeys, jobId));
      artifactBaselines.set(jobId, await snapshotExpectedArtifacts(artifactFiles, job.workspaceRoot ?? job.cwd));
    }
    const lease = await acquireCliBridgeCapacity(cap, jobId);
    capacityLeases.set(jobId, lease);
    job.capacitySlot = lease.index;
    await fs.mkdir(logDir, { recursive: true });
    await fs.writeFile(logPath, `[CLI Bridge job ${jobId}]\nCLI: ${opts.cliAlias}\nWorking directory: ${opts.cwd}\nTimeout: ${opts.timeoutMs}ms\n--- output ---\n`, "utf8");
    await persistJobs();
  } catch (error) {
    job.status = "failed";
    job.completionState = "failed";
    const lease = capacityLeases.get(jobId);
    if (lease) { await releaseCliBridgeCapacity(lease).catch(() => {}); capacityLeases.delete(jobId); }
    await releaseArtifactClaims(jobId).catch(() => {});
    job.error = error instanceof Error ? error.message : String(error);
    job.endedAt = Date.now();
    job.durationMs = job.endedAt - job.startedAt;
    job.updatedAt = job.endedAt;
    await persistJobs().catch(() => {});
    throw error;
  }

  let proc: any;
  try {
    proc = execa(opts.binary, opts.args, {
      cwd: opts.cwd, all: true, buffer: false, reject: false,
      env: opts.env ?? process.env, input: opts.prompt, timeout: opts.timeoutMs,
      forceKillAfterDelay: 5_000, windowsHide: true, detached: process.platform !== "win32",
    });
  } catch (error) {
    job.status = "failed";
    job.completionState = "failed";
    const lease = capacityLeases.get(jobId);
    if (lease) { await releaseCliBridgeCapacity(lease).catch(() => {}); capacityLeases.delete(jobId); }
    await releaseArtifactClaims(jobId).catch(() => {});
    job.error = error instanceof Error ? error.message : String(error);
    job.endedAt = Date.now();
    job.durationMs = job.endedAt - job.startedAt;
    job.updatedAt = job.endedAt;
    await persistJobs().catch(() => {});
    throw error;
  }

  processes.set(jobId, proc);
  job.pid = typeof proc.pid === "number" ? proc.pid : null;
  job.status = "running";
  job.updatedAt = Date.now();
  // Preserve multi-byte characters even when a subprocess writes them across chunks.
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
  runners.set(jobId, runner);
  // Heartbeat proves only that the SuperAgent bridge owner is alive.
  const pulse = setInterval(() => {
    if (!activeStatus(job.status)) return;
    job.heartbeatAt = Date.now();
    void persistJobs().catch(() => {});
  }, 20_000);
  pulse.unref?.();
  heartbeatTimers.set(jobId, pulse);

  // Start birth identity probing only after output listeners and the exit
  // finalizer are registered. The OS probe may take seconds on Windows; never
  // delay CLI output collection or delegate.start while it runs.
  void readProcessStartIdentity(job.pid).then(async identity => {
    if (!identity || !activeStatus(job.status)) return;
    job.childProcessIdentity = identity;
    await persistJobs().catch(() => {});
  }).catch(() => {});

  // Do not encourage a duplicate retry if the child has already started.
  await persistJobs().catch((error) => {
    job.error = `Job started, but metadata persistence failed: ${error instanceof Error ? error.message : String(error)}`;
  });
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

/**
 * Diagnostic only: reads last recorded state, never reattaches subprocesses,
 * rewrites peer snapshots, sends a signal or releases cross-process claims.
 * The caller MUST authorize workspace access before exposing the result.
 */
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

/** Test helper; terminates active children and clears its configured store. */
export async function __resetDelegateJobsForTests(): Promise<void> {
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
  await Promise.allSettled([...capacityLeases.values()].map(releaseCliBridgeCapacity));
  capacityLeases.clear();
  artifactClaims.clear(); artifactBaselines.clear(); jobClaims.clear(); jobCrossProcessClaims.clear();
  initializePromise = undefined;
  persistQueue = Promise.resolve();
  for (const id of ownedForCleanup) await fs.rm(jobShardPath(getStorageDir(), id), { recursive: true, force: true }).catch(() => {});
  try { await fs.rm(getStoragePath(), { force: true }); } catch {}
}
