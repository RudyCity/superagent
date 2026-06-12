import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "fs";
import { SharedRateLimiter } from "../src/core/rateLimiter.js";

describe("SharedRateLimiter", () => {
  let limiter: SharedRateLimiter;

  beforeEach(() => {
    vi.restoreAllMocks();
    limiter = new SharedRateLimiter();
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
});
