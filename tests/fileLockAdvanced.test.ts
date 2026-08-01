import { describe, it, expect, beforeEach } from "vitest";
import {
  lockFile,
  releaseFile,
  checkFileLock,
  setIntentSoftLock,
  lockEventEmitter,
} from "../src/core/storage/sharedMemory.js";
import { unlockFileTool } from "../src/core/tools/lockTools.js";

describe("Advanced Cross-Session Lock & Conflict Features", () => {
  const testFile = "src/advanced-lock-target.ts";
  const sessionCLI = "sess_cli_777";
  const sessionTline = "sess_tline_888";

  beforeEach(() => {
    releaseFile(testFile, undefined, undefined, true);
  });

  it("should emit live lock events via lockEventEmitter", async () => {
    let emittedEvent: any = null;
    const listener = (data: any) => {
      emittedEvent = data;
    };

    lockEventEmitter.once("lock_acquired", listener);
    lockFile(testFile, sessionCLI, "cli", 5000);

    expect(emittedEvent).not.toBeNull();
    expect(emittedEvent?.sessionId).toBe(sessionCLI);
  });

  it("should apply Intent Soft-Lock on file read", () => {
    const res = setIntentSoftLock(testFile, sessionCLI, "cli");
    expect(res.success).toBe(true);

    const status = checkFileLock(testFile, sessionTline);
    expect(status.locked).toBe(true);
    expect(status.owner?.isIntentSoftLock).toBe(true);
  });

  it("should unlock file using unlock_file tool force option", async () => {
    lockFile(testFile, sessionCLI, "cli", 5000);
    expect(checkFileLock(testFile, sessionTline).locked).toBe(true);

    const toolRes = await unlockFileTool.execute({ filePath: testFile, force: true }, process.cwd());
    expect(toolRes).toContain("Successfully unlocked");
    expect(checkFileLock(testFile, sessionTline).locked).toBe(false);
  });
});
