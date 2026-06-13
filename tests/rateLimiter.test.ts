import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import { SharedRateLimiter, SharedConcurrencyLimiter } from "../src/core/rateLimiter.js";

describe("SharedRateLimiter", () => {
  let limiter: SharedRateLimiter;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env.SUPERAGENT_TEST_LIMITS = "true";
    limiter = new SharedRateLimiter();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should acquire tokens immediately when bucket is full", async () => {
    const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(false);
    const spyOpen = vi.spyOn(fs, "openSync").mockReturnValue(1);
    const spyWrite = vi.spyOn(fs, "writeSync").mockReturnValue(1);
    const spyClose = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
    const spyUnlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    const spyWriteFile = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    await expect(limiter.acquire(1)).resolves.not.toThrow();

    expect(spyWriteFile).toHaveBeenCalled();
  });

  it("should wait and retry if tokens are not enough", async () => {
    // Return a state with 0 tokens
    const spyExists = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      if (typeof p === "string" && p.includes("rate_limit_state.json")) return true;
      return false;
    });

    const spyOpen = vi.spyOn(fs, "openSync").mockReturnValue(1);
    const spyWrite = vi.spyOn(fs, "writeSync").mockReturnValue(1);
    const spyClose = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
    const spyUnlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});
    
    // First read: 0 tokens. Second read: enough tokens (simulated via mock or elapsed time)
    let readCount = 0;
    const spyReadFile = vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      readCount++;
      if (readCount === 1) {
        return JSON.stringify({ lastTimestamp: Date.now(), tokensRemaining: 0 });
      }
      return JSON.stringify({ lastTimestamp: Date.now() - 10000, tokensRemaining: 10 });
    });
    const spyWriteFile = vi.spyOn(fs, "writeFileSync").mockImplementation(() => {});

    await limiter.acquire(2);

    expect(readCount).toBeGreaterThan(1);
    expect(spyWriteFile).toHaveBeenCalled();
  });

  it("should bypass rate limiting if SUPERAGENT_RATE_LIMIT_RPM is '0'", async () => {
    process.env.SUPERAGENT_RATE_LIMIT_RPM = "0";
    const spyOpen = vi.spyOn(fs, "openSync");
    await expect(limiter.acquire(1)).resolves.not.toThrow();
    expect(spyOpen).not.toHaveBeenCalled();
  });

  it("should use SUPERAGENT_RATE_LIMIT_RPM to dynamically set refill rate and capacity", () => {
    process.env.SUPERAGENT_RATE_LIMIT_RPM = "30";
    const capacity = (limiter as any).getCapacity();
    const refillRate = (limiter as any).getRefillRatePerMs();
    expect(capacity).toBe(30);
    expect(refillRate).toBe(30 / 60000);
  });

  it("should prioritize SUPERAGENT_RATE_LIMIT_CAPACITY over RPM for capacity", () => {
    process.env.SUPERAGENT_RATE_LIMIT_RPM = "30";
    process.env.SUPERAGENT_RATE_LIMIT_CAPACITY = "5";
    const capacity = (limiter as any).getCapacity();
    expect(capacity).toBe(5);
  });
});

describe("SharedConcurrencyLimiter", () => {
  let concurrency: SharedConcurrencyLimiter;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    process.env.SUPERAGENT_TEST_LIMITS = "true";
    concurrency = new SharedConcurrencyLimiter();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should acquire lock successfully", async () => {
    const spyOpen = vi.spyOn(fs, "openSync").mockReturnValue(1);
    const spyWrite = vi.spyOn(fs, "writeSync").mockReturnValue(1);
    const spyClose = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
    const spyUnlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    await expect(concurrency.acquire()).resolves.not.toThrow();
    expect(spyOpen).toHaveBeenCalled();
  });

  it("should release lock successfully", () => {
    const spyExists = vi.spyOn(fs, "existsSync").mockReturnValue(true);
    const spyUnlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {});

    concurrency.release();
    expect(spyUnlink).toHaveBeenCalled();
  });
});
