/**
 * Durable Process Ownership Registry (M1 Foundation)
 *
 * Implements a durable, versioned, fail-closed registry for subprocesses spawned
 * or tracked by the SuperAgent runtime.
 *
 * Key safety invariants:
 * 1. Stable SuperAgent record ID independent of PID.
 * 2. PID alone NEVER proves ownership.
 * 3. Explicit ownership only; discovered historical processes are unknown/diagnostic, never adopted.
 * 4. Atomic versioned persistence with bounded retention and compaction.
 * 5. Fail-closed on corrupt or malformed registry state.
 * 6. Never persist raw prompts, secrets, tokens, or environment dumps.
 * 7. Zero process reaper or kill logic in this foundation tier.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  type ProcessLaunchIntent,
  redactSensitiveProcessText,
  sanitizeArgvForTrace,
} from "./processSpawnPolicy.js";
import { getRootConfigDir } from "../config/paths.js";
import {
  compareProcessStartIdentity,
  type ProcessIdentityComparison,
} from "../tools/cliBridgeProcessIdentity.js";
import {
  observeProcessId,
  type PidObservation,
} from "../tools/cliBridgeRecovery.js";

export type ProcessState =
  | "registered"
  | "running"
  | "exited"
  | "failed"
  | "terminated";

export type ProcessLifecycle =
  | "ephemeral"
  | "job"
  | "session"
  | "persistent"
  | "external"
  | "unknown";

export type ProcessCleanupPolicy =
  | "manual"
  | "automatic"
  | "caller_owned"
  | "keep_alive"
  | "terminate_with_owner"
  | "lease_managed"
  | "manual_only";

export interface ProcessRecordOwnership {
  workspaceRoot?: string;
  workspaceId?: string;
  sessionId?: string;
  jobId?: string;
  taskId?: string;
  systemScope?: "global" | "workspace";
}

export interface ProcessTerminalObservation {
  observedAt: number;
  exitCode: number | null;
  signal: string | null;
  source: string;
  durationMs?: number;
}

export interface ProcessRecord {
  readonly recordId: string;
  pid: number | null;
  parentPid: number;
  parentCreationIdentity?: string | null;
  creationIdentity: string | null;
  executable: string;
  sanitizedArgs: string[];
  runtimeGeneration: string;
  ownership?: ProcessRecordOwnership;
  component: string;
  launchIntent: ProcessLaunchIntent;
  state: ProcessState;
  lifecycle: ProcessLifecycle;
  cleanupPolicy: ProcessCleanupPolicy;
  exitCode: number | null;
  signal: string | null;
  registeredAt: number;
  startedAt?: number;
  updatedAt: number;
  exitedAt?: number;
  heartbeatAt?: number;
  terminalObservation?: ProcessTerminalObservation;
}

export interface ProcessRegistryData {
  version: 1;
  updatedAt: number;
  runtimeGeneration: string;
  records: ProcessRecord[];
}

export type ProcessOwnershipStatus =
  | "verified_owner"
  | "identity_mismatch_blocked"
  | "historical_unverified"
  | "unverified_pid_present"
  | "pid_absent"
  | "pid_unknown"
  | "terminal_exited"
  | "corrupt_blocked";

export interface ProcessOwnershipCheckResult {
  readonly recordId: string;
  readonly pid: number | null;
  readonly status: ProcessOwnershipStatus;
  readonly isOwnedByCurrentRuntime: boolean;
  readonly identityComparison: ProcessIdentityComparison;
  readonly pidObservation: PidObservation;
  readonly reason: string;
}

export const DEFAULT_MAX_REGISTRY_RECORDS = 200;

let currentRuntimeGeneration: string = `gen_${Date.now()}_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;

export function getRuntimeGeneration(): string {
  return currentRuntimeGeneration;
}

export function setRuntimeGenerationForTest(generation: string): void {
  currentRuntimeGeneration = generation;
}

export function generateProcessRecordId(): string {
  return `sp_proc_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
}

export function getDefaultRegistryFilePath(): string {
  return path.join(getRootConfigDir(), "process-registry-v1.json");
}

/**
 * Sanitizes input arguments and executable name to eliminate raw prompts,
 * access tokens, and secret flags prior to persistence.
 */
export function sanitizeProcessCommand(
  executable: string,
  args?: readonly string[] | string | null
): { sanitizedExecutable: string; sanitizedArgs: string[] } {
  const baseName = path.basename(executable || "<unknown>");
  const sanitizedExecutable = redactSensitiveProcessText(baseName, 100);
  const sanitizedArgs = sanitizeArgvForTrace(args, 32);
  return { sanitizedExecutable, sanitizedArgs };
}

export interface ProcessRegistryOptions {
  storagePath?: string;
  maxRecords?: number;
}

export class ProcessRegistry {
  private records = new Map<string, ProcessRecord>();
  private storagePath: string;
  private maxRecords: number;
  private isCorrupt = false;
  private corruptionReason?: string;
  private isInitialized = false;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(options: ProcessRegistryOptions = {}) {
    this.storagePath = path.resolve(options.storagePath ?? getDefaultRegistryFilePath());
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_REGISTRY_RECORDS;
  }

  public getStoragePath(): string {
    return this.storagePath;
  }

  public isRegistryCorrupt(): boolean {
    return this.isCorrupt;
  }

  public getCorruptionReason(): string | undefined {
    return this.corruptionReason;
  }

  public markCorruptForTest(reason: string): void {
    this.isCorrupt = true;
    this.corruptionReason = reason;
  }

  /**
   * Loads the process registry from disk.
   * If the file is missing or empty, initializes cleanly.
   * If the file exists but has invalid JSON or invalid schema, FAILS CLOSED
   * by marking the registry corrupt and refusing to adopt records.
   */
  public async load(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!fs.existsSync(this.storagePath)) {
        this.records.clear();
        this.isCorrupt = false;
        this.corruptionReason = undefined;
        this.isInitialized = true;
        return { success: true };
      }

      const content = await fsp.readFile(this.storagePath, "utf8");
      const trimmed = content.trim();
      if (!trimmed) {
        this.records.clear();
        this.isCorrupt = false;
        this.corruptionReason = undefined;
        this.isInitialized = true;
        return { success: true };
      }

      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        this.isCorrupt = true;
        this.corruptionReason = `Malformed JSON in registry: ${err instanceof Error ? err.message : String(err)}`;
        return { success: false, error: this.corruptionReason };
      }

      if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.records)) {
        this.isCorrupt = true;
        this.corruptionReason = "Schema violation: registry must be an object with version=1 and a records array";
        return { success: false, error: this.corruptionReason };
      }

      this.records.clear();
      for (const item of parsed.records) {
        if (!item || typeof item !== "object" || typeof item.recordId !== "string" || !item.recordId) {
          this.isCorrupt = true;
          this.corruptionReason = "Corrupted record in registry: missing or invalid recordId";
          return { success: false, error: this.corruptionReason };
        }
        const normalized = this.normalizeLoadedRecord(item);
        this.records.set(item.recordId, normalized);
      }

      this.isCorrupt = false;
      this.corruptionReason = undefined;
      this.isInitialized = true;
      return { success: true };
    } catch (err) {
      this.isCorrupt = true;
      this.corruptionReason = `Failed to read process registry file: ${err instanceof Error ? err.message : String(err)}`;
      return { success: false, error: this.corruptionReason };
    }
  }

  private normalizeLoadedRecord(item: any): ProcessRecord {
    const lifecycle: ProcessLifecycle =
      ["ephemeral", "job", "session", "persistent", "external"].includes(item.lifecycle)
        ? (item.lifecycle as ProcessLifecycle)
        : "unknown";

    return {
      ...item,
      lifecycle,
      parentCreationIdentity: item.parentCreationIdentity ?? null,
    };
  }

  /**
   * Reconciles a local record with an on-disk record.
   * Monotonic terminal invariant (P0-3 / P1-3):
   * Terminal state ("exited", "failed", "terminated") ALWAYS wins over active states.
   * No stale resurrection is ever permitted.
   */
  private reconcileRecordPair(local: ProcessRecord, disk: ProcessRecord): ProcessRecord {
    const isTerminal = (s: ProcessState) =>
      s === "exited" || s === "failed" || s === "terminated";
    const diskTerminal = isTerminal(disk.state);
    const localTerminal = isTerminal(local.state);

    let state: ProcessState;
    let exitCode: number | null;
    let signal: string | null;
    let exitedAt: number | undefined;
    let terminalObservation = local.terminalObservation || disk.terminalObservation;

    if (diskTerminal && !localTerminal) {
      // Disk is terminal, local is not: disk terminal state wins monotonically (no resurrection)
      state = disk.state;
      exitCode = disk.exitCode;
      signal = disk.signal;
      exitedAt = disk.exitedAt;
      terminalObservation = disk.terminalObservation || terminalObservation;
    } else if (localTerminal && !diskTerminal) {
      // Local is terminal, disk is not: local terminal state wins monotonically
      state = local.state;
      exitCode = local.exitCode;
      signal = local.signal;
      exitedAt = local.exitedAt;
      terminalObservation = local.terminalObservation || terminalObservation;
    } else {
      // Both terminal or both non-terminal: later updatedAt wins the state
      const localTime = local.updatedAt || local.registeredAt || 0;
      const diskTime = disk.updatedAt || disk.registeredAt || 0;
      if (diskTime > localTime) {
        state = disk.state;
        exitCode = disk.exitCode;
        signal = disk.signal;
        exitedAt = disk.exitedAt;
        terminalObservation = disk.terminalObservation || terminalObservation;
      } else {
        state = local.state;
        exitCode = local.exitCode;
        signal = local.signal;
        exitedAt = local.exitedAt;
        terminalObservation = local.terminalObservation || terminalObservation;
      }
    }

    return {
      ...disk,
      ...local,
      state,
      exitCode,
      signal,
      exitedAt,
      terminalObservation,
      recordId: local.recordId,
      pid: local.pid ?? disk.pid,
      creationIdentity: local.creationIdentity || disk.creationIdentity,
      parentCreationIdentity: local.parentCreationIdentity || disk.parentCreationIdentity,
      startedAt: local.startedAt ?? disk.startedAt,
      registeredAt: Math.min(local.registeredAt, disk.registeredAt || local.registeredAt),
      updatedAt: Math.max(local.updatedAt || 0, disk.updatedAt || 0),
      heartbeatAt: Math.max(local.heartbeatAt || 0, disk.heartbeatAt || 0) || undefined,
      ownership: local.ownership || disk.ownership,
      lifecycle: local.lifecycle !== "unknown" ? local.lifecycle : disk.lifecycle,
      cleanupPolicy: local.cleanupPolicy || disk.cleanupPolicy,
    };
  }

  /**
   * Cross-process exclusive mutual exclusion lock for registry persistence.
   * Uses OS-level exclusive file creation flag 'wx' (O_CREAT | O_EXCL).
   * Enforces fail-closed stale-lock recovery by verifying owner PID liveness.
   */
  private async withRegistryLock<T>(fn: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
    const lockPath = `${this.storagePath}.lock`;
    const targetDir = path.dirname(this.storagePath);
    await fsp.mkdir(targetDir, { recursive: true });
    const startTime = Date.now();
    let lockHandle: fsp.FileHandle | null = null;

    while (Date.now() - startTime < timeoutMs) {
      let acquiredHandle: fsp.FileHandle | null = null;
      try {
        acquiredHandle = await fsp.open(lockPath, "wx", 0o600);
        try {
          await acquiredHandle.writeFile(
            JSON.stringify({
              pid: process.pid,
              createdAt: Date.now(),
              token: crypto.randomBytes(4).toString("hex"),
            })
          );
          await acquiredHandle.sync();
        } catch (writeErr) {
          // If writeFile or sync fails, close FD and unlink orphan lock immediately
          try {
            await acquiredHandle.close();
          } catch {}
          try {
            await fsp.unlink(lockPath);
          } catch {}
          throw writeErr;
        }
        lockHandle = acquiredHandle;
        break;
      } catch (err: any) {
        if (err.code === "EEXIST") {
          let isStale = false;
          let staleToken: string | null = null;
          let stalePid: number | null = null;
          let staleCreatedAt: number | null = null;

          try {
            const raw = await fsp.readFile(lockPath, "utf8");
            const data = JSON.parse(raw);
            if (typeof data.pid === "number" && typeof data.token === "string") {
              try {
                process.kill(data.pid, 0);
              } catch (killErr: any) {
                if (killErr.code === "ESRCH") {
                  isStale = true;
                  staleToken = data.token;
                  stalePid = data.pid;
                  staleCreatedAt = data.createdAt;
                }
              }
              if (!isStale && typeof data.createdAt === "number" && Date.now() - data.createdAt > 8_000) {
                try {
                  process.kill(data.pid, 0);
                } catch (kErr: any) {
                  if (kErr.code === "ESRCH") {
                    isStale = true;
                    staleToken = data.token;
                    stalePid = data.pid;
                    staleCreatedAt = data.createdAt;
                  }
                }
              }
            }
          } catch {
            // Malformed, empty, or unreadable lock file.
            // Do NOT delete unverified locks blindly. Safe fail-closed beats risky auto-recovery.
          }

          if (isStale && staleToken && stalePid !== null) {
            // TOCTOU guard: Re-read lock file immediately before unlinking to ensure it has NOT
            // been replaced by an active replacement lock from another concurrent process!
            try {
              const verifyRaw = await fsp.readFile(lockPath, "utf8");
              const verifyData = JSON.parse(verifyRaw);
              if (
                verifyData.token === staleToken &&
                verifyData.pid === stalePid &&
                verifyData.createdAt === staleCreatedAt
              ) {
                await fsp.unlink(lockPath);
              }
            } catch {
              // File changed, already removed, or unreadable; skip unlink to preserve active locks
            }
            continue;
          }

          const delay = 10 + Math.floor(Math.random() * 25);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }

    if (!lockHandle) {
      throw new Error(`Timed out waiting for process registry lock: ${lockPath}`);
    }

    try {
      return await fn();
    } finally {
      try {
        await lockHandle.close();
      } catch {}
      try {
        await fsp.unlink(lockPath);
      } catch {}
    }
  }

  /**
   * Persists the current registry state to disk atomically using an exclusive
   * cross-process lock, re-read and merge-by-record-id, and safe atomic replacement.
   * If the registry is in a corrupt state, saves are strictly rejected.
   */
  public save(): Promise<void> {
    const operation = this.saveQueue.then(() => this.persistSnapshot());
    this.saveQueue = operation.catch(() => {});
    return operation;
  }

  private async persistSnapshot(): Promise<void> {
    if (this.isCorrupt) {
      throw new Error(`Cannot persist registry: registry is marked corrupt (${this.corruptionReason}). Fail-closed.`);
    }

    await this.withRegistryLock(async () => {
      // Re-read on-disk records before writing to reconcile with concurrent writers (P0-3)
      if (fs.existsSync(this.storagePath)) {
        try {
          const content = await fsp.readFile(this.storagePath, "utf8");
          const trimmed = content.trim();
          if (trimmed) {
            let parsed: any;
            try {
              parsed = JSON.parse(trimmed);
            } catch (jsonErr) {
              this.isCorrupt = true;
              this.corruptionReason = `Corrupted JSON encountered during locked re-read: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`;
              throw new Error(`Cannot persist registry: registry on disk is corrupt. Fail-closed.`);
            }

            if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
              this.isCorrupt = true;
              this.corruptionReason = "Schema violation encountered during locked re-read";
              throw new Error(`Cannot persist registry: registry on disk has schema violation. Fail-closed.`);
            }

            // Merge disk records into memory
            for (const item of parsed.records) {
              if (!item || typeof item !== "object" || !item.recordId) {
                this.isCorrupt = true;
                this.corruptionReason = "Corrupt record in registry: missing or invalid recordId";
                throw new Error("Cannot persist registry: record on disk is corrupt. Fail-closed.");
              }
              const diskRecord = this.normalizeLoadedRecord(item);
              const localRecord = this.records.get(item.recordId);
              if (!localRecord) {
                this.records.set(item.recordId, diskRecord);
              } else {
                const merged = this.reconcileRecordPair(localRecord, diskRecord);
                this.records.set(item.recordId, merged);
              }
            }
          }
        } catch (readErr) {
          if (this.isCorrupt) throw readErr;
          // If reading failed due to non-corruption reasons (e.g. file vanished), proceed with local records
        }
      }

      this.compact();

      const data: ProcessRegistryData = {
        version: 1,
        updatedAt: Date.now(),
        runtimeGeneration: getRuntimeGeneration(),
        records: Array.from(this.records.values()),
      };

      const targetDir = path.dirname(this.storagePath);
      await fsp.mkdir(targetDir, { recursive: true });

      const serialized = JSON.stringify(data, null, 2);
      const tempFile = path.join(
        targetDir,
        `.tmp.proc_reg.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}`
      );

      try {
        await fsp.writeFile(tempFile, serialized, "utf8");

        let renamed = false;
        let lastRenameErr: unknown = null;
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await fsp.rename(tempFile, this.storagePath);
            renamed = true;
            break;
          } catch (renameErr) {
            lastRenameErr = renameErr;
            if (process.platform === "win32") {
              await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
              continue;
            }
            throw renameErr;
          }
        }

        if (!renamed) {
          throw new Error(
            `Failed to atomically replace process registry at ${this.storagePath} after retries: ${
              lastRenameErr instanceof Error ? lastRenameErr.message : String(lastRenameErr)
            }. Fail-closed with original registry intact.`
          );
        }
      } catch (err) {
        try {
          if (fs.existsSync(tempFile)) {
            await fsp.unlink(tempFile);
          }
        } catch {}
        throw err;
      }
    });
  }

  /**
   * Compacts the registry when records exceed maxRecords.
   * Active records ("registered", "running") are NEVER dropped.
   * Terminal records ("exited", "failed", "terminated") are pruned from oldest to newest.
   */
  public compact(): void {
    if (this.records.size <= this.maxRecords) return;

    const all = Array.from(this.records.values());
    const active = all.filter((r) => r.state === "registered" || r.state === "running");
    const terminal = all.filter((r) => r.state !== "registered" && r.state !== "running");

    // Sort terminal records newest first by updatedAt/exitedAt
    terminal.sort((a, b) => {
      const timeA = a.exitedAt || a.updatedAt || a.registeredAt;
      const timeB = b.exitedAt || b.updatedAt || b.registeredAt;
      return timeB - timeA;
    });

    const allowedTerminal = Math.max(0, this.maxRecords - active.length);
    const keptTerminal = terminal.slice(0, allowedTerminal);

    this.records.clear();
    for (const r of active) {
      this.records.set(r.recordId, r);
    }
    for (const r of keptTerminal) {
      this.records.set(r.recordId, r);
    }
  }

  public addRecord(record: ProcessRecord): void {
    if (this.isCorrupt) {
      throw new Error("Cannot add record: registry is corrupt (fail-closed).");
    }
    this.records.set(record.recordId, record);
  }

  public getRecord(recordId: string): ProcessRecord | undefined {
    return this.records.get(recordId);
  }

  public updateRecord(recordId: string, patch: Partial<ProcessRecord>): ProcessRecord | undefined {
    if (this.isCorrupt) {
      throw new Error("Cannot update record: registry is corrupt (fail-closed).");
    }
    const existing = this.records.get(recordId);
    if (!existing) return undefined;

    // Monotonic terminal lifecycle (P1-3):
    // A record in terminal state ("exited", "failed", "terminated") must NEVER regress
    // back to "running" or "registered".
    const isTerminal =
      existing.state === "exited" ||
      existing.state === "failed" ||
      existing.state === "terminated";

    const resolvedState =
      isTerminal && (patch.state === "running" || patch.state === "registered")
        ? existing.state
        : (patch.state ?? existing.state);

    const updated: ProcessRecord = {
      ...existing,
      ...patch,
      state: resolvedState,
      recordId: existing.recordId, // immutable
      updatedAt: Date.now(),
    };
    this.records.set(recordId, updated);
    return updated;
  }

  public listRecords(): ProcessRecord[] {
    return Array.from(this.records.values());
  }

  public clearForTest(): void {
    this.records.clear();
    this.isCorrupt = false;
    this.corruptionReason = undefined;
    this.isInitialized = true;
  }

  /**
   * Verifies explicit ownership of a recorded process.
   * PID alone NEVER proves ownership.
   * Historical processes from older runtime generations are diagnostic, NEVER adopted.
   */
  public verifyOwnership(
    recordId: string,
    observedIdentity?: string | null,
    observedPidState?: PidObservation
  ): ProcessOwnershipCheckResult {
    if (this.isCorrupt) {
      return {
        recordId,
        pid: null,
        status: "corrupt_blocked",
        isOwnedByCurrentRuntime: false,
        identityComparison: "unknown",
        pidObservation: "unknown",
        reason: "Registry is corrupt; fail-closed. No ownership can be verified.",
      };
    }

    const record = this.records.get(recordId);
    if (!record) {
      return {
        recordId,
        pid: null,
        status: "pid_unknown",
        isOwnedByCurrentRuntime: false,
        identityComparison: "unknown",
        pidObservation: "unknown",
        reason: `Process record "${recordId}" is not present in registry.`,
      };
    }

    const pid = record.pid;
    if (record.state === "exited" || record.state === "failed" || record.state === "terminated") {
      return {
        recordId,
        pid,
        status: "terminal_exited",
        isOwnedByCurrentRuntime: false,
        identityComparison: "unknown",
        pidObservation: typeof pid === "number" ? (observedPidState ?? observeProcessId(pid)) : "pid_absent",
        reason: `Process record is in terminal state "${record.state}".`,
      };
    }

    // Historical process check: Must match the current SuperAgent runtime generation
    const isCurrentRuntime = record.runtimeGeneration === getRuntimeGeneration();
    if (!isCurrentRuntime) {
      return {
        recordId,
        pid,
        status: "historical_unverified",
        isOwnedByCurrentRuntime: false,
        identityComparison: "unknown",
        pidObservation: typeof pid === "number" ? (observedPidState ?? observeProcessId(pid)) : "unknown",
        reason: `Record was created by a different runtime generation (${record.runtimeGeneration}). Historical processes are diagnostic only and never adopted.`,
      };
    }

    if (pid === null) {
      return {
        recordId,
        pid: null,
        status: "pid_unknown",
        isOwnedByCurrentRuntime: false,
        identityComparison: "unknown",
        pidObservation: "unknown",
        reason: "Process record has no associated OS PID yet.",
      };
    }

    const pidObservation = observedPidState ?? observeProcessId(pid);
    if (pidObservation === "pid_absent") {
      return {
        recordId,
        pid,
        status: "pid_absent",
        isOwnedByCurrentRuntime: false,
        identityComparison: "unknown",
        pidObservation: "pid_absent",
        reason: `Recorded PID ${pid} is absent from the OS process table.`,
      };
    }

    if (pidObservation !== "pid_present_unverified") {
      return {
        recordId,
        pid,
        status: "pid_unknown",
        isOwnedByCurrentRuntime: false,
        identityComparison: "unknown",
        pidObservation,
        reason: `Presence of recorded PID ${pid} could not be conclusively determined.`,
      };
    }

    // PID is present in OS. Evaluate creation/start identity.
    const identityComparison = compareProcessStartIdentity(record.creationIdentity, observedIdentity);
    if (identityComparison === "mismatch") {
      return {
        recordId,
        pid,
        status: "identity_mismatch_blocked",
        isOwnedByCurrentRuntime: false,
        identityComparison: "mismatch",
        pidObservation,
        reason: `PID ${pid} is present in the OS, but process creation identity mismatches recorded identity. PID reuse suspected; ownership rejected.`,
      };
    }

    if (identityComparison === "matched_unverified") {
      return {
        recordId,
        pid,
        status: "verified_owner",
        isOwnedByCurrentRuntime: true,
        identityComparison: "matched_unverified",
        pidObservation,
        reason: `PID ${pid} and process creation identity match the current runtime generation. Explicit ownership verified.`,
      };
    }

    // Identity is unknown (either recorded or observed was null/unavailable)
    return {
      recordId,
      pid,
      status: "unverified_pid_present",
      isOwnedByCurrentRuntime: false,
      identityComparison: "unknown",
      pidObservation,
      reason: `PID ${pid} is present, but creation identity was unavailable. PID alone NEVER proves ownership.`,
    };
  }
}
