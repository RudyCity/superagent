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

export class SharedConcurrencyLimiter {
  private lockPath: string;
  private processQueue: (() => void)[] = [];
  private processLocked = false;

  constructor() {
    const root = getRootConfigDir();
    this.lockPath = path.join(root, "concurrency.lock");
  }

  public async acquire(): Promise<void> {
    // Bypass in test suites (except when specifically testing the concurrency limiter)
    if (process.env.VITEST === "true" && process.env.SUPERAGENT_TEST_LIMITS !== "true") {
      return;
    }

    if (this.processLocked) {
      await new Promise<void>((resolve) => {
        this.processQueue.push(resolve);
      });
    }
    this.processLocked = true;

    const start = Date.now();
    while (true) {
      try {
        // wx: Open file for writing, fail if it exists
        const fd = fs.openSync(this.lockPath, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (err: any) {
        // Self-heal if parent directory does not exist
        if (err.code === "ENOENT") {
          try {
            fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
            continue;
          } catch {}
        }
        // If file exists, check if it's stale (older than 60 seconds or process is dead)
        if (err.code === "EEXIST") {
          try {
            const content = fs.readFileSync(this.lockPath, "utf-8").trim();
            const pid = parseInt(content, 10);
            let isAlive = false;
            if (!isNaN(pid) && pid > 0) {
              try {
                process.kill(pid, 0);
                isAlive = true;
              } catch (e: any) {
                isAlive = e.code === "EPERM";
              }
            }
            const stat = fs.statSync(this.lockPath);
            if (!isAlive || Date.now() - stat.mtimeMs > 60000) {
              this.releaseFileLock(); // Remove stale lock
              continue;
            }
          } catch {}
        }
        // Wait and retry
        await new Promise((resolve) => setTimeout(resolve, 100));
        // Timeout check to prevent infinite loop (safety backup)
        if (Date.now() - start > 90000) {
          this.releaseFileLock();
        }
      }
    }
  }

  private releaseFileLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {}
  }

  public release(): void {
    // Bypass in test suites (except when specifically testing the concurrency limiter)
    if (process.env.VITEST === "true" && process.env.SUPERAGENT_TEST_LIMITS !== "true") {
      return;
    }

    this.releaseFileLock();
    this.processLocked = false;
    const next = this.processQueue.shift();
    if (next) {
      next();
    }
  }
}

export const rateLimiter = new SharedRateLimiter();
export const concurrencyLimiter = new SharedConcurrencyLimiter();
