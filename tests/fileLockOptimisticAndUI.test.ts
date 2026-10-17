import { afterEach, beforeEach, describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { lockFile, releaseFile, getLockStats, lockEventEmitter } from "../src/core/storage/sharedMemory.js";
import { editTool } from "../src/core/tools/fileEditTools.js";

describe("Optimistic Concurrency & Lock UI Tests", () => {
  let testDir: string;
  let testFile: string;
  const session1 = `sess_file_lock_test_${process.pid}_1`;
  const session2 = `sess_file_lock_test_${process.pid}_2`;
  let lockListener: ((payload: any) => void) | undefined;

  beforeEach(async () => {
    // Give each test a private file. A shared tests/ file made this suite race
    // with parallel Vitest workers that also edit or lock repository fixtures.
    testDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-file-lock-test-"));
    testFile = path.join(testDir, "test-concurrency-target.txt");
    await fs.writeFile(testFile, "line 1\nline 2\nline 3", "utf-8");
    releaseFile(testFile, session1);
    releaseFile(testFile, session2);
  });

  afterEach(async () => {
    if (lockListener) {
      lockEventEmitter.off("tline_bridge_sync", lockListener);
      lockListener = undefined;
    }
    releaseFile(testFile, session1);
    releaseFile(testFile, session2);
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should track lock stats changes and emit events correctly", () => {
    let emitted = false;
    const absTestPath = path.resolve(testFile);
    lockListener = (payload: any) => {
      if (payload.event === "lock_acquired" && path.resolve(payload.lock.filePath) === absTestPath) {
        emitted = true;
      }
    };
    lockEventEmitter.on("tline_bridge_sync", lockListener);

    const before = getLockStats().totalActiveLocks;
    const lockRes = lockFile(testFile, session1, "cli", 5000);
    expect(lockRes.success).toBe(true);

    const stats = getLockStats();
    expect(stats.totalActiveLocks).toBeGreaterThanOrEqual(before + 1);
    expect(emitted).toBe(true);
  });

  it("should trigger edit tool correctly under normal conditions", async () => {
    const res = await editTool.execute(
      {
        filePath: testFile,
        oldString: "line 2",
        newString: "line 2 modified",
      },
      process.cwd(),
      new AbortController().signal,
    );
    expect(res).toContain("File edited");
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toContain("line 2 modified");
  });
});
