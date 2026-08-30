import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  checkFileLock,
  lockFile,
  releaseFile,
  releaseAllSessionLocks,
} from "../src/core/storage/sharedMemory.js";
import { getRootConfigDir } from "../src/core/config/paths.js";
import { getNormalizedProjectPath } from "../src/core/tools/helpers.js";
import type { FileLockEntry } from "../src/core/storage/sharedMemory.js";

/**
 * Tests for the "False Locked-File Detection" fix.
 *
 * Before the fix, `checkFileLock` only looked at the TTL window:
 *   `now - l.lockedAt < l.ttlMs`
 *
 * That meant a session that crashed / was Ctrl+C'd / killed would leave
 * a lock on disk that blocked the very next session for up to 30 seconds,
 * even when no other live process was editing the same file. This is the
 * bug the user reported: "hanya satu sesi chat tapi file locked, harusnya
 * tidak locked" — only one chat session, yet the file still shows as
 * locked.
 *
 * After the fix, `checkFileLock` additionally checks:
 *   1. The lock-owner's PID must still be alive.
 *   2. The lock-owner's heartbeat must still be pinging (2x interval).
 *
 * Legacy lock entries (no `pid` / no `heartbeatPingAt`) keep their old
 * TTL-only behavior so the on-disk format remains backward compatible.
 */

function getLocksFilePath(): string {
  return path.join(getRootConfigDir(), "file-locks.json");
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeRawLocks(locks: FileLockEntry[]): Promise<void> {
  const file = getLocksFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Wait long enough for any pending 100ms debounce from
  // `persistLocksToDisk` (used by the renewal path of `lockFile`)
  // to fire, otherwise it could overwrite our test data after we
  // return. Then bump the mtime with a non-empty write to ensure
  // the `lastCacheMtime` check in `loadLocksFromDisk` will reload
  // on the next read.
  await sleep(150);
  fs.writeFileSync(file, JSON.stringify(locks, null, 2), "utf-8");
  // Bump mtime explicitly so subsequent `loadLocksFromDisk` calls
  // are guaranteed to see a newer mtime than the previous read.
  const future = new Date();
  fs.utimesSync(file, future, future);
}

function readRawLocks(): FileLockEntry[] {
  const file = getLocksFilePath();
  if (!fs.existsSync(file)) return [];
  return JSON.parse(fs.readFileSync(file, "utf-8")) as FileLockEntry[];
}

describe("False Locked-File Detection (liveness-aware locks)", () => {
  // Use the same project path that `lockFile`/`checkFileLock` will
  // resolve to under the test runner. Using a relative path keeps
  // it consistent across platforms.
  const projectPath = getNormalizedProjectPath(process.cwd());
  const testFile = "src/liveness-test-target.ts";
  const otherFile = "src/liveness-other-target.ts";
  const sessionA = "sess_live_A";
  const sessionB = "sess_live_B";

  beforeEach(async () => {
    // Clear any state from prior tests.
    await writeRawLocks([]);
    releaseAllSessionLocks(sessionA);
    releaseAllSessionLocks(sessionB);
  });

  // ───────────────────────────────────────────────────────────────────
  // 1. Self-lock from a live process: still considered locked for peers
  // ───────────────────────────────────────────────────────────────────
  it("keeps a lock held by a live PID visible to peer sessions", () => {
    lockFile(testFile, sessionA, "cli", 30_000);

    const peerCheck = checkFileLock(testFile, sessionB);
    expect(peerCheck.locked).toBe(true);
    expect(peerCheck.owner?.sessionId).toBe(sessionA);
    expect(peerCheck.owner?.pid).toBe(process.pid);
  });

  it("treats a self-lock as not-locked for the owner itself", () => {
    lockFile(testFile, sessionA, "cli", 30_000);
    const selfCheck = checkFileLock(testFile, sessionA);
    expect(selfCheck.locked).toBe(false);
    expect(selfCheck.owner?.sessionId).toBe(sessionA);
  });

  // ───────────────────────────────────────────────────────────────────
  // 2. THE PRIMARY BUG FIX
  //    A lock whose owning PID is dead must NOT block a new session.
  // ───────────────────────────────────────────────────────────────────
  it("treats a lock with a dead owner PID as NOT locked (false-positive fix)", async () => {
    // Simulate the exact bug scenario: a previous session acquired a
    // lock, then crashed / was killed. The lock entry is still on
    // disk with a TTL that has not yet expired, but the owning PID is
    // no longer alive.
    const now = Date.now();
    const deadLock: FileLockEntry = {
      filePath: path.resolve(process.cwd(), testFile),
      sessionId: "sess_crashed_previous",
      terminalType: "cli",
      lockedAt: now - 5_000, // 5s ago, well within the 30s TTL
      ttlMs: 30_000,
      projectPath,
      heartbeatPingAt: now - 5_000,
      heartbeatMs: 10_000,
      // 0x7fffffff is a fake "dead" PID; on every platform this PID
      // is not running in this test process.
      pid: 2_147_483_647,
    };
    await writeRawLocks([deadLock]);

    // The new (single) session should NOT see the file as locked.
    const check = checkFileLock(testFile, sessionA);
    expect(check.locked).toBe(false);
  });

  it("treats a lock with a stopped heartbeat as NOT locked", async () => {
    // Even when the PID happens to be the live one (e.g. same process
    // re-acquired, then silently died), a heartbeat that hasn't pinged
    // for more than 2x the interval means the holder is gone.
    const now = Date.now();
    const staleHeartbeatLock: FileLockEntry = {
      filePath: path.resolve(process.cwd(), testFile),
      sessionId: "sess_heartbeat_dead",
      terminalType: "cli",
      lockedAt: now - 5_000,
      ttlMs: 60_000, // TTL is generous; only heartbeat should save us
      projectPath,
      heartbeatPingAt: now - 60_000, // 60s ago, way past 2x interval
      heartbeatMs: 10_000,
      pid: process.pid, // alive, but heartbeat is the truth here
    };
    await writeRawLocks([staleHeartbeatLock]);

    const check = checkFileLock(testFile, sessionA);
    expect(check.locked).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 3. Backward compatibility: legacy lock entries (no pid) keep working
  // ───────────────────────────────────────────────────────────────────
  it("still respects TTL for legacy lock entries (no pid field)", async () => {
    const now = Date.now();
    const legacyLock: FileLockEntry = {
      filePath: path.resolve(process.cwd(), testFile),
      sessionId: "sess_legacy",
      terminalType: "cli",
      lockedAt: now - 1_000,
      ttlMs: 30_000,
      projectPath,
      // intentionally no `pid`, no `heartbeatPingAt`
    };
    await writeRawLocks([legacyLock]);

    const check = checkFileLock(testFile, sessionA);
    expect(check.locked).toBe(true);
    expect(check.owner?.sessionId).toBe("sess_legacy");
  });

  // ───────────────────────────────────────────────────────────────────
  // 4. The new lockFile() populates pid/heartbeatMs on the disk entry
  // ───────────────────────────────────────────────────────────────────
  it("records pid and heartbeatMs on newly acquired locks", () => {
    lockFile(testFile, sessionA, "cli", 30_000);

    const onDisk = readRawLocks().find(
      l => path.resolve(l.filePath) === path.resolve(process.cwd(), testFile)
    );
    expect(onDisk).toBeDefined();
    expect(onDisk?.pid).toBe(process.pid);
    expect(onDisk?.heartbeatMs).toBeGreaterThan(0);
    expect(onDisk?.heartbeatPingAt).toBeDefined();
  });

  // ───────────────────────────────────────────────────────────────────
  // 5. After a previous session's lock is dropped (dead PID), the new
  //    session can lockFile() the same path without conflict.
  // ───────────────────────────────────────────────────────────────────
  it("allows the new session to acquire a lock that the dead session left behind", async () => {
    const now = Date.now();
    await writeRawLocks([
      {
        filePath: path.resolve(process.cwd(), testFile),
        sessionId: "sess_crashed_previous",
        terminalType: "cli",
        lockedAt: now - 2_000,
        ttlMs: 30_000,
        projectPath,
        heartbeatPingAt: now - 2_000,
        heartbeatMs: 10_000,
        pid: 2_147_483_647, // dead
      },
    ]);

    const result = lockFile(testFile, sessionA, "cli", 30_000);
    expect(result.success).toBe(true);
    expect(result.owner?.sessionId).toBe(sessionA);
  });

  // ───────────────────────────────────────────────────────────────────
  // 5b. Consistency between lockFile() and checkFileLock().
  //    The previous version of lockFile() only checked liveness (PID
  //    alive), not heartbeat freshness. This caused a confusing UX
  //    where checkFileLock() would say "not locked" but lockFile()
  //    would then refuse to acquire with `LOCK_CONFLICT` — because the
  //    on-disk lock had a live PID but a stale heartbeat.
  //
  //    This test pins the contract: the two functions MUST agree.
  // ───────────────────────────────────────────────────────────────────
  it("lockFile() and checkFileLock() agree on a lock with stale heartbeat (consistency)", async () => {
    const now = Date.now();
    // Lock with a *live* PID (this very test process) but a heartbeat
    // that hasn't pinged in 60s — way past 2x the 10s interval.
    await writeRawLocks([
      {
        filePath: path.resolve(process.cwd(), testFile),
        sessionId: "sess_heartbeat_stale_previous",
        terminalType: "cli",
        lockedAt: now - 5_000, // 5s ago, well within 60s TTL
        ttlMs: 60_000,
        projectPath,
        heartbeatPingAt: now - 60_000, // 60s ago -> stale
        heartbeatMs: 10_000,
        pid: process.pid, // alive! but heartbeat is the truth
      },
    ]);

    // (a) checkFileLock() should see no conflict.
    const check = checkFileLock(testFile, sessionA);
    expect(check.locked).toBe(false);

    // (b) lockFile() must also accept the acquisition (the bug was
    //     that it refused because the heartbeat check was missing
    //     from its filter).
    const result = lockFile(testFile, sessionA, "cli", 30_000);
    expect(result.success).toBe(true);
    expect(result.owner?.sessionId).toBe(sessionA);
  });

  // ───────────────────────────────────────────────────────────────────
  // 6. A truly live peer session is still respected (no over-eager
  //    cleanup that would corrupt multi-session behavior).
  // ───────────────────────────────────────────────────────────────────
  it("still blocks concurrent edits from a live peer (multi-session safety)", async () => {
    // Use child_process so we have a *real* live PID distinct from
    // this vitest process. The child is a long-lived Node sleep.
    const { spawn } = require("child_process") as typeof import("child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
    });

    try {
      const now = Date.now();
      const childLock: FileLockEntry = {
        filePath: path.resolve(process.cwd(), otherFile),
        sessionId: "sess_child_peer",
        terminalType: "cli",
        lockedAt: now,
        ttlMs: 30_000,
        projectPath,
        heartbeatPingAt: now,
        heartbeatMs: 10_000,
        pid: child.pid, // live child
      };
      await writeRawLocks([childLock]);

      const peerCheck = checkFileLock(otherFile, sessionA);
      expect(peerCheck.locked).toBe(true);
      expect(peerCheck.owner?.sessionId).toBe("sess_child_peer");
    } finally {
      try { child.kill(); } catch {}
    }
  });

  // ───────────────────────────────────────────────────────────────────
  // 7. After releasing a lock, checkFileLock returns locked: false
  //    (sanity check that releaseFile still works).
  // ───────────────────────────────────────────────────────────────────
  it("releases a lock correctly via releaseFile", () => {
    lockFile(testFile, sessionA, "cli", 30_000);
    releaseFile(testFile, sessionA);

    const check = checkFileLock(testFile, sessionB);
    expect(check.locked).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 8. releaseFile() consistency: a different session MUST be able to
  //    release a lock whose owner is provably dead. The previous version
  //    of `releaseFile` would refuse with "Cannot unlock file locked by
  //    session X" even when session X was a dead PID — which left the
  //    phantom lock on disk for up to 5s until the recovery daemon
  //    swept it. This test pins the fix: dead locks are ownerless, so
  //    anyone (including a different session) can release them.
  // ───────────────────────────────────────────────────────────────────
  it("allows a different session to release a lock whose owner is dead", async () => {
    const now = Date.now();
    await writeRawLocks([
      {
        filePath: path.resolve(process.cwd(), testFile),
        sessionId: "sess_crashed_owner",
        terminalType: "cli",
        lockedAt: now - 5_000,
        ttlMs: 60_000,
        projectPath,
        heartbeatPingAt: now - 5_000,
        heartbeatMs: 10_000,
        pid: 2_147_483_647, // dead PID (Windows reserved sentinel)
      },
    ]);

    // sessionA (different from the dead owner) tries to release.
    const result = releaseFile(testFile, sessionA);
    expect(result.success).toBe(true);

    // The dead lock must be gone from disk.
    const check = checkFileLock(testFile, sessionB);
    expect(check.locked).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 9. releaseFile() consistency: a different session MUST be able to
  //    release a lock whose owner has a live PID but a stale heartbeat.
  //    Same root cause as test 8 but for the heartbeat path.
  // ───────────────────────────────────────────────────────────────────
  it("allows a different session to release a lock with a stale heartbeat", async () => {
    const now = Date.now();
    await writeRawLocks([
      {
        filePath: path.resolve(process.cwd(), testFile),
        sessionId: "sess_heartbeat_lost_owner",
        terminalType: "cli",
        lockedAt: now - 5_000,
        ttlMs: 60_000,
        projectPath,
        heartbeatPingAt: now - 60_000, // stale
        heartbeatMs: 10_000,
        pid: process.pid, // live (current process), but heartbeat is dead
      },
    ]);

    const result = releaseFile(testFile, sessionA);
    expect(result.success).toBe(true);

    const check = checkFileLock(testFile, sessionB);
    expect(check.locked).toBe(false);
  });

  // ───────────────────────────────────────────────────────────────────
  // 10. releaseFile() guard: a different session MUST still NOT be
  //     able to release a lock whose owner is genuinely alive and
  //     actively heartbeating — we only relax the cross-session
  //     release for dead / stale locks, not live ones.
  // ───────────────────────────────────────────────────────────────────
  it("still refuses a cross-session release of a live lock (no over-relaxation)", async () => {
    const now = Date.now();
    await writeRawLocks([
      {
        filePath: path.resolve(process.cwd(), testFile),
        sessionId: "sess_live_owner",
        terminalType: "cli",
        lockedAt: now,
        ttlMs: 30_000,
        projectPath,
        heartbeatPingAt: now, // fresh
        heartbeatMs: 10_000,
        pid: process.pid, // live
      },
    ]);

    const result = releaseFile(testFile, sessionA);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Cannot unlock/i);

    // The live lock must remain.
    const check = checkFileLock(testFile, sessionB);
    expect(check.locked).toBe(true);
    expect(check.owner?.sessionId).toBe("sess_live_owner");
  });
});
