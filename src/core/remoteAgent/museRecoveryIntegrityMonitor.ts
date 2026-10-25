/**
 * Phase 4l — bounded, read-only, periodic verification of Muse recovery
 * persistence, including on-disk journal, sealed archives and private stores.
 * Nothing here repairs, prunes, resumes tools, logs secrets or contacts peers.
 *
 * The monitor caches only redacted counts and error codes, never raw errors,
 * filenames, private paths, keys, credentials or result payloads.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectMuseRecoveryStorage } from "./museRecoveryBackup.js";
import type { MuseRecoveryHealth } from "./museRecoveryBackup.js";
import { MuseRecoveryIntegrityEvents } from "./museRecoveryIntegrityEvents.js";

export type MuseIntegrityState = "not_initialized" | "healthy" | "degraded" | "failed" | "stale";
export type MuseIntegrityReason =
  | "NO_JOURNAL_YET"
  | "VALIDATED"
  | "STORAGE_CHECK_FAILED"
  | "CHECK_OVERDUE"
  | "ALERT_LEDGER_INVALID";

export type MuseIntegritySnapshot = {
  state: MuseIntegrityState;
  reason: MuseIntegrityReason;
  lastCheckAt: number | null;
  lastHealthyAt: number | null;
  nextCheckAt: number | null;
  totalChecks: number;
  totalFailures: number;
  consecutiveFailures: number;
  activeBatches: number | null;
  archivedTombstones: number | null;
  encryptedResults: number | null;
  encryptedIntents: number | null;
  durableAlertCount: number;
  lastAlertAt: number | null;
};

/** Per-port, read-only integrity verification; test-only scan injection. */
export class MuseRecoveryIntegrityMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: MuseIntegrityState = "not_initialized";
  private reason: MuseIntegrityReason = "NO_JOURNAL_YET";
  private lastCheckAt: number | null = null;
  private lastHealthyAt: number | null = null;
  private totalChecks = 0;
  private totalFailures = 0;
  private consecutiveFailures = 0;
  private counts: MuseRecoveryHealth | null = null;
  private readonly root: string;
  private readonly events: MuseRecoveryIntegrityEvents;
  private durableAlertCount = 0;
  private lastAlertAt: number | null = null;

  constructor(
    readonly port: number,
    readonly intervalMs = 60_000,
    root = path.join(os.homedir(), ".superagent-r"),
    private readonly probe: (port: number, root: string) => MuseRecoveryHealth = inspectMuseRecoveryStorage,
    private readonly notify?: (event: { port: number; state: "degraded" | "failed" | "healthy"; reason: MuseIntegrityReason }) => void,
  ) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 ||
        !Number.isSafeInteger(intervalMs) || intervalMs < 100 || intervalMs > 86_400_000) {
      throw new Error("Invalid recovery monitoring options");
    }
    this.root = root;
    this.events = new MuseRecoveryIntegrityEvents(port, root);
  }

  /** Missing journal is normal for a fresh owner, but NEVER if artifacts exist. */
  private uninitialized(): boolean {
    const names = [
      "muse-batches-" + this.port + ".json",
      "muse-results-" + this.port + ".json",
      "muse-results-" + this.port + ".json.key",
      "muse-execution-" + this.port + ".json",
      "muse-execution-" + this.port + ".json.key",
      "muse-tombstones-" + this.port + ".key",
      "muse-tombstones-" + this.port,
      "muse-restore-" + this.port + ".incomplete",
      "muse-integrity-" + this.port + ".jsonl",
    ];
    try {
      const stat = fs.lstatSync(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Unsafe recovery monitoring root");
      }
      const present = fs.readdirSync(this.root);
      return !names.some(name => present.includes(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
      throw new Error("Recovery directory inspection failed");
    }
  }

  /** Explicit scan, never launched by a public unauthenticated mutation API. */
  check(now = Date.now()): MuseIntegritySnapshot {
    if (!Number.isSafeInteger(now) || now < 1) throw new Error("Invalid monitoring clock");
    this.totalChecks++;
    this.lastCheckAt = now;
    try {
      const history = this.events.read(); // malformed events are a hard integrity fault
      if (history.length >= MuseRecoveryIntegrityEvents.maxEvents) {
        throw new Error("Integrity event ledger at retention cap");
      }
      this.durableAlertCount = history.length;
      this.lastAlertAt = history.at(-1)?.observedAt ?? null;
      if (this.uninitialized()) {
        this.state = "not_initialized";
        this.reason = "NO_JOURNAL_YET";
        this.consecutiveFailures = 0;
        this.counts = null;
      } else {
        const result = this.probe(this.port, this.root);
        if (result.port !== this.port || result.integrityBlocked !== 0) {
          throw new Error("Recovery integrity probe invalid");
        }
        this.state = "healthy";
        this.reason = "VALIDATED";
        this.lastHealthyAt = now;
        this.consecutiveFailures = 0;
        this.counts = result;
      }
      if (this.state === "healthy" && history.length &&
          history.at(-1)?.state !== "healthy") {
        const record = this.events.append(now, "healthy", "VALIDATED");
        this.durableAlertCount++;
        this.lastAlertAt = record.observedAt;
        try { this.notify?.({ port: this.port, state: "healthy", reason: "VALIDATED" }); } catch {}
      }
    } catch {
      this.totalFailures++;
      // Preserve an already confirmed FAIL state across an owner restart.
      // A new process cannot downgrade a durable failure to a "first warning".
      if (this.consecutiveFailures === 0) {
        try {
          if (this.events.read().at(-1)?.state === "failed") this.consecutiveFailures = 1;
        } catch { /* the ledger itself is invalid; deny below */ }
      }
      this.consecutiveFailures++;
      this.state = this.consecutiveFailures >= 2 ? "failed" : "degraded";
      this.reason = "STORAGE_CHECK_FAILED";
      this.counts = null;
      try {
        const history = this.events.read();
        this.durableAlertCount = history.length;
        this.lastAlertAt = history.at(-1)?.observedAt ?? null;
        if (history.at(-1)?.state !== this.state) {
          const record = this.events.append(now, this.state, "STORAGE_CHECK_FAILED");
          this.durableAlertCount++;
          this.lastAlertAt = record.observedAt;
          try { this.notify?.({ port: this.port, state: this.state as "degraded" | "failed", reason: "STORAGE_CHECK_FAILED" }); } catch {}
        }
      } catch {
        this.state = "failed";
        this.reason = "ALERT_LEDGER_INVALID";
      }
    }
    return this.snapshot(now);
  }

  snapshot(now = Date.now()): MuseIntegritySnapshot {
    const stale = this.lastCheckAt !== null &&
      (now < this.lastCheckAt || now - this.lastCheckAt > this.intervalMs * 3);
    const state = stale ? "stale" : this.state;
    return {
      state,
      reason: stale ? "CHECK_OVERDUE" : this.reason,
      lastCheckAt: this.lastCheckAt,
      lastHealthyAt: this.lastHealthyAt,
      nextCheckAt: this.lastCheckAt === null ? null : this.lastCheckAt + this.intervalMs,
      totalChecks: this.totalChecks,
      totalFailures: this.totalFailures,
      consecutiveFailures: this.consecutiveFailures,
      activeBatches: state === "healthy" ? this.counts?.active ?? null : null,
      archivedTombstones: state === "healthy" ? this.counts?.archived ?? null : null,
      encryptedResults: state === "healthy" ? this.counts?.encryptedResults ?? null : null,
      encryptedIntents: state === "healthy" ? this.counts?.encryptedIntents ?? null : null,
      durableAlertCount: this.durableAlertCount,
      lastAlertAt: this.lastAlertAt,
    };
  }

  start(): void {
    if (this.timer) return;
    this.check();
    this.timer = setInterval(() => { this.check(); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
