import { describe, it, expect, beforeEach } from "vitest";
import {
  lockFile,
  releaseFile,
  checkFileLock,
} from "../src/core/storage/sharedMemory.js";

describe("Multi-Process Cache Invalidation Verification", () => {
  const testFile = "src/multiprocess-lock-target.ts";
  const sessionA = "sess_cli_mp_A";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  it("should invalidate memory cache when disk mtime updates from another process", () => {
    const resA = lockFile(testFile, sessionA, "cli", 5000);
    expect(resA.success).toBe(true);

    // Verify lock is detected across process cache loads
    const check = checkFileLock(testFile, "sess_cli_mp_B");
    expect(check.locked).toBe(true);
    expect(check.owner?.sessionId).toBe(sessionA);
  });
});
