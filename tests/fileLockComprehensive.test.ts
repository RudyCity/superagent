import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lockFile,
  releaseFile,
  checkFileLock,
  setIntentSoftLock,
  startLockHeartbeat,
  stopLockHeartbeat,
  releaseAllSessionLocks,
  getLockStats,
  lockEventEmitter,
  startDeadlockRecoveryDaemon,
  stopDeadlockRecoveryDaemon,
} from "../src/core/storage/sharedMemory.js";
import { predictSemanticConflict } from "../src/core/storage/semanticConflictPredictor.js";
import {
  unlockFileTool,
  getLockStatsTool,
  resolveConflictTool,
  generateLockReportTool,
} from "../src/core/tools/lockTools.js";

describe("Comprehensive Master Edge-Case & Integration Suite (Phases 1-5 Final)", () => {
  const fileA = "src/comp-target-A.ts";
  const fileB = "src/comp-target-B.ts";
  const session1 = "sess_master_101";
  const session2 = "sess_master_102";

  beforeEach(() => {
    releaseFile(fileA, undefined, undefined, true);
    releaseFile(fileB, undefined, undefined, true);
    releaseAllSessionLocks(session1);
    releaseAllSessionLocks(session2);
  });

  afterEach(() => {
    stopDeadlockRecoveryDaemon();
  });

  it("1. Full Lifecycle: Acquire, Soft Lock, Granular Range, Heartbeat, Release", async () => {
    // 1a. Acquire Intent Soft Lock
    const softRes = setIntentSoftLock(fileA, session1, "cli");
    expect(softRes.success).toBe(true);
    expect(softRes.owner?.isIntentSoftLock).toBe(true);

    // 1b. Upgrade to Full Hard Lock
    const hardRes = lockFile(fileA, session1, "cli", 10000);
    expect(hardRes.success).toBe(true);
    expect(hardRes.owner?.isIntentSoftLock).toBe(false);

    // 1c. Granular range lock on non-overlapping line ranges
    const rangeRes = lockFile(fileB, session1, "cli", 10000, undefined, false, { startLine: 1, endLine: 20 });
    expect(rangeRes.success).toBe(true);

    const rangeOtherRes = lockFile(fileB, session2, "cli", 10000, undefined, false, { startLine: 50, endLine: 80 });
    expect(rangeOtherRes.success).toBe(true);

    // 1d. Release
    releaseFile(fileA, session1);
    releaseFile(fileB, session1, undefined, false, { startLine: 1, endLine: 20 });
    expect(checkFileLock(fileA, session2).locked).toBe(false);
  });

  it("2. Tool Chain Execution: stats, unlock, resolve, report", async () => {
    lockFile(fileA, session1, "t-line", 8000);

    // Stats Tool
    const statsJson = await getLockStatsTool.execute({}, process.cwd());
    const statsObj = JSON.parse(statsJson);
    expect(statsObj.totalActiveLocks).toBeGreaterThanOrEqual(1);

    // Predictor
    const prediction = predictSemanticConflict(fileA, session2);
    expect(prediction.hasConflictRisk).toBe(true);

    // Report Tool
    const reportMd = await generateLockReportTool.execute({ targetFile: fileA }, process.cwd());
    expect(reportMd).toContain("Multi-Terminal Lock Health");

    // Resolve Conflict Tool
    const resolveRes = await resolveConflictTool.execute(
      { filePath: fileA, resolutionStrategy: "force_override" },
      process.cwd()
    );
    expect(resolveRes).toContain("Conflict resolved");

    // Unlock Tool
    const unlockRes = await unlockFileTool.execute(
      { filePath: fileA, force: true, reason: "test force-override after resolve" },
      process.cwd()
    );
    expect(unlockRes).toContain("Successfully unlocked");
  });

  it("3. Deadlock Recovery Daemon Stale Lock Cleanup", async () => {
    // Acquire a short TTL lock (50ms)
    lockFile(fileA, session1, "cli", 50);

    await new Promise(r => setTimeout(r, 100));

    // Force deadlock daemon execution check
    startDeadlockRecoveryDaemon(500);

    await new Promise(r => setTimeout(r, 600));

    const check = checkFileLock(fileA, session2);
    expect(check.locked).toBe(false);
  });

  it("4. Event Emitter Verification for IPC, Bridge, and OS Toast", async () => {
    let tlineEventPassed = false;
    let toastEventPassed = false;

    lockEventEmitter.once("tline_bridge_sync", (data: any) => {
      if (data.event === "lock_acquired") tlineEventPassed = true;
    });

    lockEventEmitter.once("os_notification_toast", (data: any) => {
      if (data.title === "File Lock Released") toastEventPassed = true;
    });

    lockFile(fileA, session1, "t-line", 5000);
    expect(tlineEventPassed).toBe(true);

    releaseFile(fileA, session1);
    expect(toastEventPassed).toBe(true);
  });
});
