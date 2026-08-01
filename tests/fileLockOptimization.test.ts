import { describe, it, expect, beforeEach } from "vitest";
import {
  lockFile,
  releaseFile,
  checkFileLock,
  startLockHeartbeat,
} from "../src/core/storage/sharedMemory.js";

describe("Optimization & Bottleneck Fixes Verification", () => {
  const testFile = "src/optimization-lock-target.ts";
  const sessionA = "sess_cli_opt_A";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  it("should cleanup active heartbeat timers when force unlocked", async () => {
    lockFile(testFile, sessionA, "cli", 5000);
    startLockHeartbeat(testFile, sessionA, "cli", undefined, 100);

    // Force unlock without passing sessionId
    const res = releaseFile(testFile, undefined, undefined, true);
    expect(res.success).toBe(true);

    await new Promise(r => setTimeout(r, 250));

    // File must remain unlocked (timer was cancelled)
    const status = checkFileLock(testFile, "other_session");
    expect(status.locked).toBe(false);
  });
});
