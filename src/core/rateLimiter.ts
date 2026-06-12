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

  private readState(): RateLimitState {
    if (!fs.existsSync(this.statePath)) {
      return { lastTimestamp: Date.now(), tokensRemaining: CAPACITY };
    }
    try {
      const data = fs.readFileSync(this.statePath, "utf-8");
      return JSON.parse(data);
    } catch {
      return { lastTimestamp: Date.now(), tokensRemaining: CAPACITY };
    }
  }

  private writeState(state: RateLimitState): void {
    fs.writeFileSync(this.statePath, JSON.stringify(state, null, 2), "utf-8");
  }

  /**
   * Acquires a slot from the token bucket. If empty, it pauses execution.
   */
  public async acquire(cost: number = 1): Promise<void> {
    while (true) {
      await this.acquireLock();
      try {
        const state = this.readState();
        const now = Date.now();
        const elapsed = now - state.lastTimestamp;

        // Refill tokens
        const refilled = elapsed * REFILL_RATE_PER_MS;
        const newTokens = Math.min(CAPACITY, state.tokensRemaining + refilled);

        if (newTokens >= cost) {
          state.tokensRemaining = newTokens - cost;
          state.lastTimestamp = now;
          this.writeState(state);
          this.releaseLock();
          return;
        }

        // Not enough tokens: Release lock, wait, and retry
        this.releaseLock();
        const waitTime = Math.max(500, Math.ceil((cost - newTokens) / REFILL_RATE_PER_MS));
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      } catch (err) {
        this.releaseLock();
        throw err;
      }
    }
  }
}

export const rateLimiter = new SharedRateLimiter();
