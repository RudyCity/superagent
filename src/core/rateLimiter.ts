import fs from "fs";
import path from "path";
import { getRootConfigDir, getSettings } from "./config.js";
import { getRateLimitStateFromDb, saveRateLimitStateToDb } from "./storage/historyDb.js";

interface RateLimitState {
  lastTimestamp: number;
  tokensRemaining: number;
}

const CAPACITY = 60; // Max 60 requests in the bucket
const REFILL_RATE_PER_MS = 1 / 1000; // Refill 1 token per second (1000ms)

/**
 * SQLite-backed shared token bucket rate limiter to prevent concurrent
 * Superagent instances from hitting LLM API rate limits.
 * Uses SQLite WAL mode for safe atomic cross-process state updates.
 */
export class SharedRateLimiter {
  private stateKey = "default";
  private processQueue: (() => void)[] = [];
  private processLocked = false;
  private legacyMigrated = false;

  constructor() {}

  private async acquireProcessLock(): Promise<void> {
    if (this.processLocked) {
      await new Promise<void>((resolve) => {
        this.processQueue.push(resolve);
      });
    }
    this.processLocked = true;
  }

  private releaseProcessLock(): void {
    this.processLocked = false;
    const next = this.processQueue.shift();
    if (next) {
      next();
    }
  }

  private migrateLegacyState(): void {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    try {
      const root = getRootConfigDir();
      const legacyStatePath = path.join(root, "rate_limit_state.json");
      if (fs.existsSync(legacyStatePath)) {
        const data = JSON.parse(fs.readFileSync(legacyStatePath, "utf-8"));
        if (typeof data.lastTimestamp === "number" && typeof data.tokensRemaining === "number") {
          saveRateLimitStateToDb(this.stateKey, data.tokensRemaining, data.lastTimestamp);
        }
        fs.unlinkSync(legacyStatePath);
      }
      // Clean up legacy lock file
      const legacyLockPath = path.join(root, "rate_limit.lock");
      if (fs.existsSync(legacyLockPath)) {
        fs.unlinkSync(legacyLockPath);
      }
    } catch {}
  }

  private readState(capacity: number): RateLimitState {
    this.migrateLegacyState();
    const defaultState = { lastTimestamp: Date.now(), tokensRemaining: capacity };
    const dbState = getRateLimitStateFromDb(this.stateKey);
    if (dbState) {
      return { lastTimestamp: dbState.lastUpdated, tokensRemaining: dbState.tokensRemaining };
    }
    return defaultState;
  }

  private writeState(state: RateLimitState): void {
    saveRateLimitStateToDb(this.stateKey, state.tokensRemaining, state.lastTimestamp);
  }

  private getCapacity(): number {
    const settings = getSettings();
    if (settings.rateLimitCapacity > 0) {
      return settings.rateLimitCapacity;
    }
    if (settings.rateLimitRpm > 0) {
      return settings.rateLimitRpm;
    }
    return CAPACITY;
  }

  private getRefillRatePerMs(): number {
    const settings = getSettings();
    if (settings.rateLimitRpm > 0) {
      return settings.rateLimitRpm / 60000;
    }
    return REFILL_RATE_PER_MS;
  }

  /**
   * Acquires a slot from the token bucket. If empty, it pauses execution.
   */
  public async acquire(cost: number = 1): Promise<void> {
    // Bypass in test suites (except when specifically testing the rate limiter)
    if (process.env.VITEST === "true" && process.env.SUPERAGENT_TEST_LIMITS !== "true") {
      return;
    }

    if (getSettings().rateLimitRpm === 0) {
      return;
    }

    const capacity = this.getCapacity();
    const refillRate = this.getRefillRatePerMs();

    while (true) {
      await this.acquireProcessLock();
      try {
        const state = this.readState(capacity);
        const now = Date.now();
        const elapsed = now - state.lastTimestamp;

        // Refill tokens
        const refilled = elapsed * refillRate;
        const newTokens = Math.min(capacity, state.tokensRemaining + refilled);

        if (newTokens >= cost) {
          state.tokensRemaining = newTokens - cost;
          state.lastTimestamp = now;
          this.writeState(state);
          this.releaseProcessLock();
          return;
        }

        // Not enough tokens: Release lock, wait, and retry
        this.releaseProcessLock();
        const waitTime = Math.max(500, Math.ceil((cost - newTokens) / refillRate));
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } catch (err) {
        this.releaseProcessLock();
        throw err;
      }
    }
  }
}

export interface ConcurrencyLease {
  leaseId: string;
  slot: number;
  pid: number;
  lockPath: string;
  heartbeatTimer?: any;
}

export class SharedConcurrencyLimiter {
  private baseLockDir: string;
  private processQueue: (() => void)[] = [];
  private activeLeases = new Map<string, ConcurrencyLease>();

  constructor() {
    this.baseLockDir = getRootConfigDir();
  }

  private getSlotPath(slot: number, limit: number): string {
    if (limit === 1 && slot === 0) {
      return path.join(this.baseLockDir, "concurrency.lock");
    }
    return path.join(this.baseLockDir, `concurrency_slot_${slot}.lock`);
  }

  private isProcessAlive(pid: number): boolean {
    if (isNaN(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e.code === "EPERM";
    }
  }

  public async acquire(limitArg?: number): Promise<ConcurrencyLease | null> {
    let limit = limitArg;
    if (limit === undefined) {
      try {
        limit = getSettings()?.concurrencyLimit ?? 0;
      } catch {
        limit = 0;
      }
    }

    // 0 = unlimited / disabled
    if (limit <= 0) {
      return null;
    }

    // Bypass in test suites unless explicitly requested
    const isTest = (process.env.VITEST === "true" || process.env.BUN_TEST === "1") && process.env.SUPERAGENT_TEST_LIMITS !== "true";
    if (isTest) {
      return null;
    }

    const leaseId = `lease_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    while (true) {
      for (let slot = 0; slot < limit; slot++) {
        const slotPath = this.getSlotPath(slot, limit);
        try {
          const fd = fs.openSync(slotPath, "wx");
          const payload = JSON.stringify({
            leaseId,
            pid: process.pid,
            slot,
            acquiredAt: Date.now(),
            updatedAt: Date.now(),
          });
          fs.writeSync(fd, payload);
          fs.closeSync(fd);

          const heartbeatTimer = setInterval(() => {
            try {
              if (fs.existsSync(slotPath)) {
                const now = Date.now();
                fs.utimesSync(slotPath, now / 1000, now / 1000);
              }
            } catch {}
          }, 5000);
          if (heartbeatTimer.unref) heartbeatTimer.unref();

          const lease: ConcurrencyLease = {
            leaseId,
            slot,
            pid: process.pid,
            lockPath: slotPath,
            heartbeatTimer,
          };
          this.activeLeases.set(leaseId, lease);
          return lease;
        } catch (err: any) {
          if (err.code === "ENOENT") {
            try {
              fs.mkdirSync(path.dirname(slotPath), { recursive: true });
            } catch {}
            continue;
          }

          if (err.code === "EEXIST") {
            try {
              const content = fs.readFileSync(slotPath, "utf-8").trim();
              let ownerPid = NaN;
              if (content.startsWith("{")) {
                const parsed = JSON.parse(content);
                ownerPid = parsed.pid;
              } else {
                ownerPid = parseInt(content, 10);
              }

              const alive = this.isProcessAlive(ownerPid);
              // DEEP-05: Never delete a live owner lock merely because >60s.
              // Only clean up if the process is DEAD.
              if (!alive) {
                try {
                  fs.unlinkSync(slotPath);
                } catch {}
              }
            } catch {}
          }
        }
      }

      await new Promise<void>((resolve) => {
        let timer: any = null;
        let settled = false;

        const wake = () => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          const idx = this.processQueue.indexOf(wake);
          if (idx !== -1) {
            this.processQueue.splice(idx, 1);
          }
          resolve();
        };

        timer = setTimeout(() => {
          wake();
        }, 100);

        this.processQueue.push(wake);
      });
    }
  }

  public getQueueLength(): number {
    return this.processQueue.length;
  }

  public release(lease?: ConcurrencyLease | null): void {
    if (!lease) {
      // Legacy fallback: release first active lease owned by this process
      const first = this.activeLeases.values().next().value;
      if (first) {
        this.release(first);
      }
      return;
    }

    if (lease.heartbeatTimer) {
      clearInterval(lease.heartbeatTimer);
    }

    this.activeLeases.delete(lease.leaseId);

    // Only release lock file if owned by this lease
    try {
      if (fs.existsSync(lease.lockPath)) {
        const content = fs.readFileSync(lease.lockPath, "utf-8").trim();
        let shouldUnlink = false;
        if (content.startsWith("{")) {
          const parsed = JSON.parse(content);
          if (parsed.leaseId === lease.leaseId && parsed.pid === lease.pid) {
            shouldUnlink = true;
          }
        } else {
          const pid = parseInt(content, 10);
          if (pid === lease.pid) {
            shouldUnlink = true;
          }
        }
        if (shouldUnlink) {
          fs.unlinkSync(lease.lockPath);
        }
      }
    } catch {}

    while (this.processQueue.length > 0) {
      const next = this.processQueue.shift();
      if (next) {
        next();
        break;
      }
    }
  }
}

export const rateLimiter = new SharedRateLimiter();
export const concurrencyLimiter = new SharedConcurrencyLimiter();
