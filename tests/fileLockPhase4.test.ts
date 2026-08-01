import { describe, it, expect, beforeEach } from "vitest";
import {
  lockFile,
  releaseFile,
  checkFileLock,
  lockEventEmitter,
} from "../src/core/storage/sharedMemory.js";
import { resolveConflictTool } from "../src/core/tools/lockTools.js";

describe("Phase 4 Granular Block Lock & Multi-Machine Features", () => {
  const testFile = "src/phase4-lock-target.ts";
  const sessionA = "sess_cli_p4_A";
  const sessionB = "sess_cli_p4_B";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  it("should allow non-overlapping granular line range locks on the same file", () => {
    // Session A locks lines 1-50
    const resA = lockFile(testFile, sessionA, "cli", 5000, undefined, false, { startLine: 1, endLine: 50 });
    expect(resA.success).toBe(true);

    // Session B attempts to lock lines 100-150 (Non-overlapping) -> Should Succeed
    const resB = lockFile(testFile, sessionB, "cli", 5000, undefined, false, { startLine: 100, endLine: 150 });
    expect(resB.success).toBe(true);

    // Session B attempts to lock lines 40-60 (Overlapping with 1-50) -> Should Fail
    const resBOverlap = lockFile(testFile, sessionB, "cli", 5000, undefined, false, { startLine: 40, endLine: 60 });
    expect(resBOverlap.success).toBe(false);
  });

  it("should emit remote_node_lock_propagated event for workspace chain sync", async () => {
    let propagatedEvent: any = null;
    const listener = (data: any) => {
      propagatedEvent = data;
    };

    lockEventEmitter.once("remote_node_lock_propagated", listener);
    lockFile(testFile, sessionA, "cli", 5000, undefined, false, undefined, "remote_tline_node_1");

    expect(propagatedEvent).not.toBeNull();
    expect(propagatedEvent?.remoteNodeId).toBe("remote_tline_node_1");
  });

  it("should resolve lock conflict via resolve_lock_conflict tool", async () => {
    lockFile(testFile, sessionA, "cli", 5000);
    expect(checkFileLock(testFile, sessionB).locked).toBe(true);

    const toolRes = await resolveConflictTool.execute(
      { filePath: testFile, resolutionStrategy: "force_override" },
      process.cwd()
    );

    expect(toolRes).toContain("Conflict resolved");
    expect(checkFileLock(testFile, sessionB).locked).toBe(false);
  });
});
