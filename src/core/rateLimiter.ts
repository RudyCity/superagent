import fs from "fs";
import path from "path";
import { getRootConfigDir } from "./config.js";

interface RateLimitState {
  lastTimestamp: number;
  tokensRemaining: number;
}

const CAPACITY = 60; // Max 60 requests in the bucket
const REFILL_RATE_PER_MS = 1 / 1000; // Refill 1 token per second (1000ms)

/**
 * A file-lock-based shared token bucket rate limiter to prevent concurrent
 * Superagent instances from hitting LLM API rate limits.
 */
export class SharedRateLimiter {
  private statePath: string;
  private lockPath: string;

  constructor() {
    const root = getRootConfigDir();
    this.statePath = path.join(root, "rate_limit_state.json");
    this.lockPath = path.join(root, "rate_limit.lock");
  }

  private async acquireLock(): Promise<void> {
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
        // If file exists, check if it's stale (older than 10 seconds)
        if (err.code === "EEXIST") {
          try {
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs > 10000) {
              this.releaseLock(); // Remove stale lock
              continue;
            }
          } catch {}
        }
        // Wait and retry
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Timeout check to prevent infinite loop (safety backup)
        if (Date.now() - start > 15000) {
          this.releaseLock();
        }
      }
    }
  }

  private releaseLock(): void {
    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {}
  }

  private readState(capacity: number): RateLimitState {
    const defaultState = { lastTimestamp: Date.now(), tokensRemaining: capacity };
    if (!fs.existsSync(this.statePath)) {
      return defaultState;
    }
    try {
      const data = fs.readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(data);
      if (typeof parsed.lastTimestamp !== "number" || typeof parsed.tokensRemaining !== "number") {
        return defaultState;
      }
      return parsed;
    } catch {
      return defaultState;
    }
  }

  private writeState(state: RateLimitState): void {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  private getCapacity(): number {
    if (process.env.SUPERAGENT_RATE_LIMIT_CAPACITY) {
      const cap = parseInt(process.env.SUPERAGENT_RATE_LIMIT_CAPACITY, 10);
      if (!isNaN(cap)) return cap;
    }
    if (process.env.SUPERAGENT_RATE_LIMIT_RPM) {
      const rpm = parseInt(process.env.SUPERAGENT_RATE_LIMIT_RPM, 10);
      if (!isNaN(rpm)) return rpm;
    }
    return CAPACITY;
  }

  private getRefillRatePerMs(): number {
    if (process.env.SUPERAGENT_RATE_LIMIT_RPM) {
      const rpm = parseInt(process.env.SUPERAGENT_RATE_LIMIT_RPM, 10);
      if (!isNaN(rpm) && rpm > 0) {
        return rpm / 60000;
      }
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

    if (process.env.SUPERAGENT_RATE_LIMIT_RPM === "0") {
      return;
    }

    const capacity = this.getCapacity();
    const refillRate = this.getRefillRatePerMs();

    while (true) {
      await this.acquireLock();
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
          this.releaseLock();
          return;
        }

        // Not enough tokens: Release lock, wait, and retry
        this.releaseLock();
        const waitTime = Math.max(500, Math.ceil((cost - newTokens) / refillRate));
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } catch (err) {
        this.releaseLock();
        throw err;
      }
    }
  }
}

export class SharedConcurrencyLimiter {
  private lockPath: string;

  constructor() {
    const root = getRootConfigDir();
    this.lockPath = path.join(root, "concurrency.lock");
  }

  public async acquire(): Promise<void> {
    // Bypass in test suites (except when specifically testing the concurrency limiter)
    if (process.env.VITEST === "true" && process.env.SUPERAGENT_TEST_LIMITS !== "true") {
      return;
    }

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
        // If file exists, check if it's stale (older than 60 seconds)
        if (err.code === "EEXIST") {
          try {
            const stat = fs.statSync(this.lockPath);
            if (Date.now() - stat.mtimeMs > 60000) {
              this.release(); // Remove stale lock
              continue;
            }
          } catch {}
        }
        // Wait and retry
        await new Promise((resolve) => setTimeout(resolve, 100));
        // Timeout check to prevent infinite loop (safety backup)
        if (Date.now() - start > 90000) {
          this.release();
        }
      }
    }
  }

  public release(): void {
    // Bypass in test suites (except when specifically testing the concurrency limiter)
    if (process.env.VITEST === "true" && process.env.SUPERAGENT_TEST_LIMITS !== "true") {
      return;
    }

    try {
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
    } catch {}
  }
}

export const rateLimiter = new SharedRateLimiter();
export const concurrencyLimiter = new SharedConcurrencyLimiter();
