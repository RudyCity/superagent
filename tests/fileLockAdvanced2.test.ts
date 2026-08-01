import { describe, it, expect, beforeEach } from "vitest";
import {
  lockFile,
  releaseFile,
  checkFileLock,
  startLockHeartbeat,
  stopLockHeartbeat,
} from "../src/core/storage/sharedMemory.js";
import { recordLockEvent } from "../src/core/storage/historyDb.js";

describe("Phase 2 Advanced Lock & Conflict Features", () => {
  const testFile = "src/advanced2-lock-target.ts";
  const sessionCLI = "sess_cli_999";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  it("should start and stop lock heartbeat without errors", async () => {
    lockFile(testFile, sessionCLI, "cli", 5000);
    startLockHeartbeat(testFile, sessionCLI, "cli", undefined, 100);

    await new Promise(r => setTimeout(r, 250));

    const status = checkFileLock(testFile, sessionCLI);
    expect(status.locked).toBe(false); // owner session has access

    stopLockHeartbeat(testFile, sessionCLI);
  });

  it("should record lock analytics in SQLite historyDb", () => {
    expect(() => {
      recordLockEvent(testFile, sessionCLI, "cli", "acquired");
      recordLockEvent(testFile, sessionCLI, "cli", "conflict_blocked");
      recordLockEvent(testFile, sessionCLI, "cli", "released");
    }).not.toThrow();
  });
});
