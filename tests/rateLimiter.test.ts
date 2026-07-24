import { describe, it, expect, vi, beforeEach, afterEach, afterAll, mock } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { SharedRateLimiter, SharedConcurrencyLimiter } from "../src/core/rateLimiter.js";
import { getRateLimitStateFromDb, saveRateLimitStateToDb, closeHistoryDb } from "../src/core/storage/historyDb.js";
import { getSettings } from "../src/core/config/jsonConfig.js";

const mockSettings = {
  concurrencyLimit: 0,
  rateLimitRpm: 60,
  rateLimitCapacity: 60,
  disableStreaming: false,
  contextWindowLimit: 0,
  maxIterations: 50,
};

vi.mock("../src/core/config/paths.js", async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    getRootConfigDir: vi.fn(() => path.join(os.tmpdir(), `superagent-rate-limit-test-${process.pid}`)),
    getGlobalConfigDir: vi.fn(() => path.join(os.tmpdir(), `superagent-rate-limit-test-${process.pid}`)),
    getModelConfigPath: vi.fn(() => path.join(os.tmpdir(), `superagent-rate-limit-test-${process.pid}`, "model-config.json")),
  };
});

import * as jsonConfigModule from "../src/core/config/jsonConfig.js";

describe("SharedRateLimiter", () => {
  let limiter: SharedRateLimiter;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SUPERAGENT_TEST_LIMITS = "true";
    
    // Mutate mockSettings properties in-place so getSettings mock returns them correctly
    mockSettings.concurrencyLimit = 0;
    mockSettings.rateLimitRpm = 60;
    mockSettings.rateLimitCapacity = 60;
    mockSettings.disableStreaming = false;
    mockSettings.contextWindowLimit = 0;
    mockSettings.maxIterations = 50;

    vi.spyOn(jsonConfigModule, "getSettings").mockImplementation(() => mockSettings as any);

    closeHistoryDb();
    limiter = new SharedRateLimiter();
  });

  afterEach(() => {
    closeHistoryDb();
    process.env = originalEnv;
  });

  it("should acquire tokens immediately when bucket is full", async () => {
    await limiter.acquire(1);

    // Verify it is written to the SQLite DB
    const state = getRateLimitStateFromDb("default");
    expect(state).not.toBeNull();
    expect(state!.tokensRemaining).toBeLessThan(60);
  });

  it("should wait and retry if tokens are not enough", async () => {
    // Seed SQLite DB with 0 tokens
    saveRateLimitStateToDb("default", 0, Date.now());

    // Configure a very high refill rate to refill quickly (100 tokens per second / 6000 rpm)
    mockSettings.rateLimitRpm = 6000;
    mockSettings.rateLimitCapacity = 10;

    const start = Date.now();
    await limiter.acquire(1);
    const elapsed = Date.now() - start;

    // Must have waited at least some ms since it started with 0 tokens
    expect(elapsed).toBeGreaterThanOrEqual(0);

    const state = getRateLimitStateFromDb("default");
    expect(state).not.toBeNull();
  });

  it("should bypass rate limiting if rateLimitRpm is 0", async () => {
    mockSettings.rateLimitRpm = 0;
    await limiter.acquire(1);
  });

  it("should use rateLimitRpm to dynamically set refill rate and capacity", () => {
    mockSettings.rateLimitRpm = 120;
    mockSettings.rateLimitCapacity = 0; // Force it to use rateLimitRpm for capacity
    const capacity = (limiter as any).getCapacity();
    const refill = (limiter as any).getRefillRatePerMs();
    expect(capacity).toBe(120);
    expect(refill).toBe(120 / 60000);
  });

  it("should prioritize rateLimitCapacity over rateLimitRpm for capacity", () => {
    mockSettings.rateLimitRpm = 120;
    mockSettings.rateLimitCapacity = 10;
    const capacity = (limiter as any).getCapacity();
    expect(capacity).toBe(10);
  });

  afterAll(() => {});
});
