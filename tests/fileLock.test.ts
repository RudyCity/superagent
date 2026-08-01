import { describe, it, expect, beforeEach } from "vitest";
import { lockFile, releaseFile, checkFileLock, releaseAllSessionLocks } from "../src/core/storage/sharedMemory.js";

describe("Cross-Session File Locking System", () => {
  const testFile = "src/test-lock-target.ts";
  const sessionCLI = "sess_cli_123";
  const sessionTline = "sess_tline_456";

  beforeEach(() => {
    releaseFile(testFile, sessionCLI);
    releaseFile(testFile, sessionTline);
  });

  it("should acquire file lock successfully for a session", () => {
    const lockRes = lockFile(testFile, sessionCLI, "cli", 5000);
    expect(lockRes.success).toBe(true);
    expect(lockRes.owner?.sessionId).toBe(sessionCLI);
  });

  it("should reject lock acquisition from another session when active", () => {
    lockFile(testFile, sessionCLI, "cli", 5000);
    const lockRes2 = lockFile(testFile, sessionTline, "t-line", 5000);
    expect(lockRes2.success).toBe(false);
    expect(lockRes2.owner?.sessionId).toBe(sessionCLI);
    expect(lockRes2.message).toContain("locked");
  });

  it("should detect locked status correctly via checkFileLock", () => {
    lockFile(testFile, sessionCLI, "cli", 5000);

    const checkOther = checkFileLock(testFile, sessionTline);
    expect(checkOther.locked).toBe(true);
    expect(checkOther.owner?.sessionId).toBe(sessionCLI);

    const checkSelf = checkFileLock(testFile, sessionCLI);
    expect(checkSelf.locked).toBe(false);
  });

  it("should release file lock properly", () => {
    lockFile(testFile, sessionCLI, "cli", 5000);
    releaseFile(testFile, sessionCLI);

    const checkAfterRelease = checkFileLock(testFile, sessionTline);
    expect(checkAfterRelease.locked).toBe(false);
  });

  it("should release all session locks via releaseAllSessionLocks", () => {
    lockFile("src/file1.ts", sessionCLI, "cli", 5000);
    lockFile("src/file2.ts", sessionCLI, "cli", 5000);

    const released = releaseAllSessionLocks(sessionCLI);
    expect(released).toBeGreaterThanOrEqual(2);

    expect(checkFileLock("src/file1.ts", sessionTline).locked).toBe(false);
    expect(checkFileLock("src/file2.ts", sessionTline).locked).toBe(false);
  });
});
