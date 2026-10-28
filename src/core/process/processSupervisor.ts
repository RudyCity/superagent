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

  constructor(options: ProcessRegistryOptions = {}) {
    this.registry = new ProcessRegistry(options);
  }

  public getRegistry(): ProcessRegistry {
    return this.registry;
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

    const now = Date.now();
    const updated = this.registry.updateRecord(recordId, {
      pid,
      state: "running",
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
    if (!options?.creationIdentity && typeof pid === "number" && pid > 0) {
      void readProcessStartIdentity(pid)
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
   * Respects workspace privacy by masking foreign workspace paths.
   */
  public async getProcessDiagnostics(
    filter: ProcessDiagnosticFilter = {}
  ): Promise<ProcessDiagnosticReport> {
    await this.initialize();

    const now = Date.now();
    const allRecords = this.registry.listRecords();
    const isCorrupt = this.registry.isRegistryCorrupt();
    const corruptionReason = this.registry.getCorruptionReason();

    let activeOwnedCount = 0;
    let historicalCount = 0;
    let terminalCount = 0;
    let identityMismatchCount = 0;
    let unverifiedPidCount = 0;

    const entries: ProcessDiagnosticEntry[] = [];

    for (const record of allRecords) {
      if (filter.component && record.component !== filter.component) continue;
      if (filter.state && record.state !== filter.state) continue;

      if (filter.filterByWorkspaceRoot && record.ownership?.workspaceRoot) {
        if (record.ownership.workspaceRoot !== filter.filterByWorkspaceRoot) {
          continue;
        }
      }

      const observedIdentity =
        typeof record.pid === "number" && record.state === "running"
          ? await readProcessStartIdentity(record.pid).catch(() => null)
          : null;
      const check = this.registry.verifyOwnership(record.recordId, observedIdentity);

      // Aggregate counts
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

      // Workspace privacy guard
      const callerWs = filter.callerWorkspaceRoot;
      const recordWs = record.ownership?.workspaceRoot;
      const isForeign = Boolean(callerWs && recordWs && callerWs !== recordWs);

      const ownership: ProcessDiagnosticEntry["ownership"] = {
        workspaceId: record.ownership?.workspaceId,
        taskId: record.ownership?.taskId,
        jobId: isForeign ? "[foreign_job]" : record.ownership?.jobId,
        sessionId: isForeign ? "[foreign_session]" : record.ownership?.sessionId,
        workspaceRoot: isForeign
          ? `[foreign_workspace:${crypto.createHash("sha256").update(recordWs!).digest("hex").slice(0, 8)}]`
          : recordWs,
        isForeignWorkspace: isForeign,
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
      totalTracked: allRecords.length,
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

export function getProcessSupervisor(options?: ProcessRegistryOptions): ProcessSupervisor {
  if (!globalProcessSupervisor) {
    globalProcessSupervisor = new ProcessSupervisor(options);
  }
  return globalProcessSupervisor;
}

export function resetProcessSupervisorForTest(): void {
  globalProcessSupervisor = null;
}
