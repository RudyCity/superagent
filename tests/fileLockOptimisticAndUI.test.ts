import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { lockFile, releaseFile, getLockStats, lockEventEmitter } from "../src/core/storage/sharedMemory.js";
import { editTool } from "../src/core/tools/fileEditTools.js";

describe("Optimistic Concurrency & Lock UI Tests", () => {
  const testFile = "tests/test-concurrency-target.txt";
  const session1 = "sess_1";
  const session2 = "sess_2";

  beforeEach(async () => {
    try {
      await fs.writeFile(testFile, "line 1\nline 2\nline 3", "utf-8");
    } catch {}
    releaseFile(testFile, session1);
    releaseFile(testFile, session2);
  });

  it("should track lock stats changes and emit events correctly", () => {
    let emitted = false;
    const absTestPath = path.resolve(testFile);
    const listener = (payload: any) => {
      if (payload.event === "lock_acquired" && path.resolve(payload.lock.filePath) === absTestPath) {
        emitted = true;
      }
    };
    lockEventEmitter.on("tline_bridge_sync", listener);

    const lockRes = lockFile(testFile, session1, "cli", 5000);
    expect(lockRes.success).toBe(true);

    const stats = getLockStats();
    expect(stats.totalActiveLocks).toBeGreaterThanOrEqual(1);

    expect(emitted).toBe(true);
    lockEventEmitter.off("tline_bridge_sync", listener);
  });

  it("should trigger edit tool correctly under normal conditions", async () => {
    const res = await editTool.execute(
      {
        filePath: testFile,
        oldString: "line 2",
        newString: "line 2 modified"
      },
      process.cwd(),
      new AbortController().signal
    );
    expect(res).toContain("File edited");
    const content = await fs.readFile(testFile, "utf-8");
    expect(content).toContain("line 2 modified");
  });
});
