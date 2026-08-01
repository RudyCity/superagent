import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  lockFile,
  releaseFile,
  checkFileLock,
  getLockStats,
  lockEventEmitter,
  startDeadlockRecoveryDaemon,
  stopDeadlockRecoveryDaemon,
} from "../src/core/storage/sharedMemory.js";
import { getLockStatsTool } from "../src/core/tools/lockTools.js";

describe("Phase 3 Ultimate Cross-Session Lock & Conflict Features", () => {
  const testFile = "src/phase3-lock-target.ts";
  const sessionCLI = "sess_cli_p3_111";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  afterEach(() => {
    stopDeadlockRecoveryDaemon();
  });

  it("should emit tline_bridge_sync event when acquiring lock", async () => {
    let bridgeEvent: any = null;
    const listener = (data: any) => {
      bridgeEvent = data;
    };

    lockEventEmitter.once("tline_bridge_sync", listener);
    lockFile(testFile, sessionCLI, "t-line", 5000);

    expect(bridgeEvent).not.toBeNull();
    expect(bridgeEvent?.event).toBe("lock_acquired");
    expect(bridgeEvent?.lock?.terminalType).toBe("t-line");
  });

  it("should retrieve lock stats via getLockStats and get_lock_stats tool", async () => {
    lockFile(testFile, sessionCLI, "cli", 5000);

    const stats = getLockStats();
    expect(stats.totalActiveLocks).toBeGreaterThanOrEqual(1);
    expect(stats.locksByTerminal["cli"]).toBeGreaterThanOrEqual(1);

    const toolOutput = await getLockStatsTool.execute({}, process.cwd());
    const parsed = JSON.parse(toolOutput);
    expect(parsed.totalActiveLocks).toBeGreaterThanOrEqual(1);
  });

  it("should start and stop deadlock recovery daemon cleanly", () => {
    expect(() => {
      startDeadlockRecoveryDaemon(1000);
      stopDeadlockRecoveryDaemon();
    }).not.toThrow();
  });
});
