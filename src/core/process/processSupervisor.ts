/**
 * SuperAgent Process Supervisor (M1 Foundation)
 *
 * Coordinates process registration, lifecycle observation, and safe diagnostic
 * inspection for SuperAgent subprocesses.
 *
 * Key safety invariants:
 * 1. Explicit ownership registration before or immediately upon spawn.
 * 2. Asynchronous creation identity resolution without blocking execution.
 * 3. Terminal lifecycle and exit observation logging.
 * 4. Read-only diagnostic API suitable for future `/doctor` inspection with workspace privacy.
 * 5. Strict NO-REAP / NO-KILL boundary: zero orphan killing or adoption logic in M1.
 */

import crypto from "node:crypto";
import {
  ProcessRegistry,
  type ProcessRecord,
  type ProcessRecordOwnership,
  type ProcessState,
  type ProcessLifecycle,
  type ProcessCleanupPolicy,
  type ProcessOwnershipCheckResult,
  type ProcessRegistryOptions,
  generateProcessRecordId,
  getRuntimeGeneration,
  sanitizeProcessCommand,
} from "./processRegistry.js";
import { type ProcessLaunchIntent } from "./processSpawnPolicy.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import { getWorkspaceId } from "../config/paths.js";
import {
  reconcileStartupProcesses,
  normalizeWorkspacePath,
  type ProcessReconciliationReport,
  type ProcessReconciliationOptions,
  type ProcessReconciliationDependencies,
} from "./processReconciliation.js";

let cachedSelfCreationIdentity: string | null = null;

export async function getSelfProcessCreationIdentity(): Promise<string | null> {
  if (cachedSelfCreationIdentity) return cachedSelfCreationIdentity;
  try {
    cachedSelfCreationIdentity = await readProcessStartIdentity(process.pid);
  } catch {
    cachedSelfCreationIdentity = null;
  }
  return cachedSelfCreationIdentity;
}

export function setSelfProcessCreationIdentityForTest(identity: string | null): void {
  cachedSelfCreationIdentity = identity;
}

export interface RegisterProcessOptions {
  component: string;
  executable: string;
  args?: readonly string[] | string | null;
  launchIntent?: ProcessLaunchIntent;
  lifecycle?: ProcessLifecycle;
  cleanupPolicy?: ProcessCleanupPolicy;
  parentCreationIdentity?: string | null;
  workspaceRoot?: string;
  sessionId?: string;
  jobId?: string;
  taskId?: string;
  systemScope?: "global" | "workspace";
}

export interface ProcessExitObservation {
  exitCode: number | null;
  signal?: string | null;
  source?: string;
}

export interface ProcessDiagnosticFilter {
  filterByWorkspaceRoot?: string;
  callerWorkspaceRoot?: string;
  component?: string;
  state?: ProcessState;
  /**
   * Explicit privileged global operator mode (P1-4).
   * When true, allows inspecting global service records and unscoped records across the host.
   * When false or omitted, diagnostic queries are strictly tenant/user-scoped.
   */
  isPrivilegedOperator?: boolean;
}

export interface ProcessDiagnosticEntry {
  recordId: string;
  pid: number | null;
  parentPid: number;
  component: string;
  executable: string;
  sanitizedArgs: string[];
  launchIntent: ProcessLaunchIntent;
  state: ProcessState;
  lifecycle: ProcessLifecycle;
  cleanupPolicy: ProcessCleanupPolicy;
  runtimeGeneration: string;
  ownership: {
    workspaceRoot?: string;
    workspaceId?: string;
    sessionId?: string;
    jobId?: string;
    taskId?: string;
    isForeignWorkspace?: boolean;
    systemScope?: "global" | "workspace";
  };
  ownershipStatus: ProcessOwnershipCheckResult["status"];
  isOwnedByCurrentRuntime: boolean;
  registeredAt: number;
  startedAt?: number;
  updatedAt: number;
  exitedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  reason?: string;
}

export interface ProcessDiagnosticReport {
  timestamp: number;
  runtimeGeneration: string;
  isCorrupt: boolean;
  corruptionReason?: string;
  totalTracked: number;
  activeOwnedCount: number;
  historicalCount: number;
  terminalCount: number;
  identityMismatchCount: number;
  unverifiedPidCount: number;
  entries: ProcessDiagnosticEntry[];
}

export class ProcessSupervisor {
  private registry: ProcessRegistry;
  private initialized = false;
  private lastReconciliationReport: ProcessReconciliationReport | null = null;

  constructor(options: ProcessRegistryOptions = {}) {
    this.registry = new ProcessRegistry(options);
  }

  public getRegistry(): ProcessRegistry {
    return this.registry;
  }

  public async reconcileOnStartup(
    options: ProcessReconciliationOptions = {},
    deps: ProcessReconciliationDependencies = {}
  ): Promise<ProcessReconciliationReport> {
    await this.initialize();
    const report = await reconcileStartupProcesses(this.registry, options, deps);
    this.lastReconciliationReport = report;
    return report;
  }

  public getLastReconciliationReport(): ProcessReconciliationReport | null {
    return this.lastReconciliationReport;
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    void getSelfProcessCreationIdentity().catch(() => {});
    await this.registry.load();
    this.initialized = true;
  }

  /**
   * Registers a process before or upon launch, generating a stable SuperAgent record ID.
   * Sanitizes all arguments and executable references to ensure zero secrets or raw prompts
   * are persisted to disk.
   */
  public async registerProcess(options: RegisterProcessOptions): Promise<ProcessRecord> {
    await this.initialize();

    const recordId = generateProcessRecordId();
    const { sanitizedExecutable, sanitizedArgs } = sanitizeProcessCommand(
      options.executable,
      options.args
    );

    const now = Date.now();
    const ownership: ProcessRecordOwnership = {
      workspaceRoot: options.workspaceRoot,
      workspaceId: options.workspaceRoot ? getWorkspaceId(options.workspaceRoot) : undefined,
      sessionId: options.sessionId,
      jobId: options.jobId,
      taskId: options.taskId,
      systemScope: options.systemScope ?? (options.workspaceRoot ? "workspace" : "global"),
    };

    const lifecycle: ProcessLifecycle =
      options.lifecycle ??
      (options.cleanupPolicy === "keep_alive"
        ? "persistent"
        : options.component?.includes("session")
        ? "session"
        : options.jobId || options.component?.includes("delegate") || options.component === "cli_bridge"
        ? "job"
        : "ephemeral");

    const parentCreationIdentity =
      options.parentCreationIdentity !== undefined
        ? options.parentCreationIdentity
        : cachedSelfCreationIdentity;

    const record: ProcessRecord = {
      recordId,
      pid: null,
      parentPid: process.pid,
      parentCreationIdentity,
      creationIdentity: null,
      executable: sanitizedExecutable,
      sanitizedArgs,
      runtimeGeneration: getRuntimeGeneration(),
      ownership,
      component: options.component,
      launchIntent: options.launchIntent ?? "headless",
      state: "registered",
      lifecycle,
      cleanupPolicy: options.cleanupPolicy ?? "caller_owned",
      exitCode: null,
      signal: null,
      registeredAt: now,
      updatedAt: now,
    };

    this.registry.addRecord(record);
    try {
      await this.registry.save();
    } catch {
      // Best-effort persistence on registration
    }

    return record;
  }

  /**
   * Binds an OS PID to a previously registered process record upon spawn.
   * Begins asynchronous resolution of OS process creation/birth identity.
   */
  public async recordProcessSpawn(
    recordId: string,
    pid: number,
    options?: { creationIdentity?: string }
  ): Promise<ProcessRecord | null> {
    await this.initialize();

    const existing = this.registry.getRecord(recordId);
    if (!existing) return null;

    // MONOTONIC TERMINAL LIFECYCLE (P1-3):
    // If the process has already reached a terminal state ('exited', 'failed', 'terminated'),
    // an asynchronous or late spawn observation must NEVER resurrect it back to 'running'.
    const isTerminal =
      existing.state === "exited" ||
      existing.state === "failed" ||
      existing.state === "terminated";

    const now = Date.now();
    const validPid = typeof pid === "number" && !isNaN(pid) && pid > 0 ? pid : existing.pid;
    const updated = this.registry.updateRecord(recordId, {
      pid: validPid,
      state: isTerminal ? existing.state : "running",
      startedAt: existing.startedAt ?? now,
      updatedAt: now,
      creationIdentity: options?.creationIdentity ?? existing.creationIdentity,
    });

    try {
      await this.registry.save();
    } catch {
      // Best-effort persistence
    }

    // If creation identity wasn't explicitly supplied, resolve asynchronously via OS probe
    if (!options?.creationIdentity && typeof validPid === "number" && validPid > 0) {
      void readProcessStartIdentity(validPid)
        .then(async (identity) => {
          if (identity) {
            await this.recordProcessIdentity(recordId, identity);
          }
        })
        .catch(() => {});
    }

    return updated ?? null;
  }

  /**
   * Records verified process creation/birth identity (ticks or boot-id starttime).
   */
  public async recordProcessIdentity(
    recordId: string,
    identity: string
  ): Promise<ProcessRecord | null> {
    await this.initialize();

    const existing = this.registry.getRecord(recordId);
    if (!existing) return null;

    const updated = this.registry.updateRecord(recordId, {
      creationIdentity: identity,
      updatedAt: Date.now(),
    });

    try {
      await this.registry.save();
    } catch {
      // Best-effort persistence
    }

    return updated ?? null;
  }

  /**
   * Records periodic heartbeat timestamp for a running process.
   */
  public async recordProcessHeartbeat(recordId: string): Promise<void> {
    await this.initialize();

    const existing = this.registry.getRecord(recordId);
    if (
      !existing ||
      existing.state === "exited" ||
      existing.state === "failed" ||
      existing.state === "terminated"
    ) {
      return;
    }

    const now = Date.now();
    this.registry.updateRecord(recordId, {
      heartbeatAt: now,
      updatedAt: now,
    });

    try {
      await this.registry.save();
    } catch {
      // Best-effort
    }
  }

  /**
   * Records process exit observation (exit code, signal, duration) and marks the record terminal.
   */
  public async recordProcessExit(
    recordId: string,
    observation: ProcessExitObservation
  ): Promise<ProcessRecord | null> {
    await this.initialize();

    const existing = this.registry.getRecord(recordId);
    if (!existing) return null;

    const now = Date.now();
    const durationMs = existing.startedAt ? Math.max(0, now - existing.startedAt) : undefined;
    const isSignalExit = typeof observation.signal === "string" && observation.signal.length > 0;
    const finalState: ProcessState = isSignalExit
      ? "terminated"
      : observation.exitCode === 0
      ? "exited"
      : "failed";

    const updated = this.registry.updateRecord(recordId, {
      state: finalState,
      exitCode: observation.exitCode,
      signal: observation.signal ?? null,
      exitedAt: now,
      updatedAt: now,
      terminalObservation: {
        observedAt: now,
        exitCode: observation.exitCode,
        signal: observation.signal ?? null,
        source: observation.source || "process_exit",
        durationMs,
      },
    });

    try {
      await this.registry.save();
    } catch {
      // Best-effort
    }

    return updated ?? null;
  }

  /**
   * Read-only diagnostic inspection API suitable for `/doctor` processes.
   * Respects workspace privacy: user-scoped diagnostics strictly return same-workspace
   * records and counts only; foreign and ownerless records are completely omitted (P1-4).
   * Explicit privileged global operator mode (isPrivilegedOperator: true) is required
   * to inspect host-wide global services.
   */
  public async getProcessDiagnostics(
    filter: ProcessDiagnosticFilter = {}
  ): Promise<ProcessDiagnosticReport> {
    await this.initialize();

    const now = Date.now();
    const allRecords = this.registry.listRecords();
    const isCorrupt = this.registry.isRegistryCorrupt();
    const corruptionReason = this.registry.getCorruptionReason();

    const isPrivilegedOperator = filter.isPrivilegedOperator === true;
    const targetWsRaw = filter.callerWorkspaceRoot ?? filter.filterByWorkspaceRoot;
    const targetWs = normalizeWorkspacePath(targetWsRaw);

    // If neither privileged operator mode nor a valid workspace is specified,
    // fail closed to protect host and foreign workspace privacy.
    if (!isPrivilegedOperator && !targetWs) {
      return {
        timestamp: now,
        runtimeGeneration: getRuntimeGeneration(),
        isCorrupt,
        corruptionReason,
        totalTracked: 0,
        activeOwnedCount: 0,
        historicalCount: 0,
        terminalCount: 0,
        identityMismatchCount: 0,
        unverifiedPidCount: 0,
        entries: [],
      };
    }

    let activeOwnedCount = 0;
    let historicalCount = 0;
    let terminalCount = 0;
    let identityMismatchCount = 0;
    let unverifiedPidCount = 0;

    const entries: ProcessDiagnosticEntry[] = [];

    for (const record of allRecords) {
      if (filter.component && record.component !== filter.component) continue;
      if (filter.state && record.state !== filter.state) continue;

      if (!isPrivilegedOperator) {
        // User-scoped diagnostics (P1-4):
        // Strictly require exact match to requested workspace.
        // Omit foreign and ownerless records completely from entries and counts!
        const recordWs = normalizeWorkspacePath(record.ownership?.workspaceRoot);
        if (!recordWs || recordWs !== targetWs) {
          continue;
        }
      } else if (filter.filterByWorkspaceRoot) {
        const filterWs = normalizeWorkspacePath(filter.filterByWorkspaceRoot);
        const recordWs = normalizeWorkspacePath(record.ownership?.workspaceRoot);
        if (!recordWs || recordWs !== filterWs) {
          continue;
        }
      }

      const observedIdentity =
        typeof record.pid === "number" && record.state === "running"
          ? await readProcessStartIdentity(record.pid).catch(() => null)
          : null;
      const check = this.registry.verifyOwnership(record.recordId, observedIdentity);

      // Aggregate counts strictly over matching records
      if (check.isOwnedByCurrentRuntime) {
        activeOwnedCount++;
      } else if (check.status === "historical_unverified") {
        historicalCount++;
      } else if (check.status === "terminal_exited") {
        terminalCount++;
      } else if (check.status === "identity_mismatch_blocked") {
        identityMismatchCount++;
      } else if (check.status === "unverified_pid_present") {
        unverifiedPidCount++;
      }

      const ownership: ProcessDiagnosticEntry["ownership"] = {
        workspaceId: record.ownership?.workspaceId,
        taskId: record.ownership?.taskId,
        jobId: record.ownership?.jobId,
        sessionId: record.ownership?.sessionId,
        systemScope: record.ownership?.systemScope,
        workspaceRoot: record.ownership?.workspaceRoot,
        isForeignWorkspace: false,
      };

      entries.push({
        recordId: record.recordId,
        pid: record.pid,
        parentPid: record.parentPid,
        component: record.component,
        executable: record.executable,
        sanitizedArgs: record.sanitizedArgs,
        launchIntent: record.launchIntent,
        state: record.state,
        lifecycle: record.lifecycle,
        cleanupPolicy: record.cleanupPolicy,
        runtimeGeneration: record.runtimeGeneration,
        ownership,
        ownershipStatus: check.status,
        isOwnedByCurrentRuntime: check.isOwnedByCurrentRuntime,
        registeredAt: record.registeredAt,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        exitedAt: record.exitedAt,
        exitCode: record.exitCode,
        signal: record.signal,
        reason: check.reason,
      });
    }

    return {
      timestamp: now,
      runtimeGeneration: getRuntimeGeneration(),
      isCorrupt,
      corruptionReason,
      totalTracked: entries.length,
      activeOwnedCount,
      historicalCount,
      terminalCount,
      identityMismatchCount,
      unverifiedPidCount,
      entries,
    };
  }
}

// Global process supervisor singleton
let globalProcessSupervisor: ProcessSupervisor | null = null;
let hasBootstrappedSupervisor = false;

export function getProcessSupervisor(options?: ProcessRegistryOptions): ProcessSupervisor {
  if (!globalProcessSupervisor) {
    globalProcessSupervisor = new ProcessSupervisor(options);
  }
  return globalProcessSupervisor;
}

export interface BootstrapProcessSupervisorOptions {
  workspaceRoot?: string;
  silent?: boolean;
}

/**
 * Executes safe, once-per-owner runtime startup reconciliation (P0-1).
 * Strictly scoped to the active workspace to prevent foreign workspace enumeration.
 * Completely non-destructive: zero automatic cleanup, zero process kill, zero prompt replay.
 */
export async function bootstrapProcessSupervisorOnStartup(
  options: BootstrapProcessSupervisorOptions = {}
): Promise<ProcessReconciliationReport | null> {
  const supervisor = getProcessSupervisor();
  if (hasBootstrappedSupervisor) {
    return supervisor.getLastReconciliationReport();
  }
  hasBootstrappedSupervisor = true;

  try {
    await supervisor.initialize();
    const targetWs = options.workspaceRoot ?? process.cwd();
    const report = await supervisor.reconcileOnStartup({
      callerWorkspaceRoot: targetWs,
    });

    if (report.isCorrupt && !options.silent) {
      console.warn(
        `[ProcessSupervisor] Warning: Process registry file is corrupt (${report.corruptionReason}). Process supervision is operating in safe fail-closed mode.`
      );
    } else if (report.mutatingJobsRequiringReview > 0 && !options.silent) {
      console.warn(
        `[ProcessSupervisor] Alert: Startup reconciliation detected ${report.mutatingJobsRequiringReview} interrupted mutating job(s) requiring operator review ('unknown_outcome_review_required'). Zero prompt replay executed.`
      );
    }

    return report;
  } catch (err: any) {
    if (!options.silent) {
      console.warn(
        `[ProcessSupervisor] Non-fatal startup reconciliation error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return supervisor.getLastReconciliationReport();
  }
}

export function resetProcessSupervisorForTest(): void {
  globalProcessSupervisor = null;
  hasBootstrappedSupervisor = false;
}

export function resetSupervisorBootstrapForTest(): void {
  resetProcessSupervisorForTest();
}
