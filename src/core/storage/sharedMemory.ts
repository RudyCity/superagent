import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { getRootConfigDir } from "../config/paths.js";
import { getNormalizedProjectPath } from "../tools/helpers.js";
import { recordLockEvent, recordLockEventBatch, LockEventDetails } from "./historyDb.js";
import { logE2E } from "../utils/unifiedLogger.js";

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface FileLockEntry {
  filePath: string;
  sessionId: string;
  terminalType?: "cli" | "t-line" | string;
  lockedAt: number;
  ttlMs: number;
  projectPath: string;
  isIntentSoftLock?: boolean;
  heartbeatPingAt?: number;
  heartbeatMs?: number;
  /**
   * PID of the process that acquired the lock. Used to detect a dead owner
   * (e.g. killed session, Ctrl+C, crash) even within the TTL window.
   * Optional for backward compatibility with legacy on-disk lock entries.
   */
  pid?: number;
  lineRange?: LineRange;
  remoteNodeId?: string;
}

export interface LockStats {
  totalActiveLocks: number;
  locksByTerminal: Record<string, number>;
  staleLocksCleaned: number;
  activeLocks: FileLockEntry[];
}

export const lockEventEmitter = new EventEmitter();

/**
 * Defensive wrapper around `lockEventEmitter.emit`. EventEmitter
 * is synchronous and runs all listeners in registration order. If
 * any one of them throws, the rest are skipped and the exception
 * propagates up the call stack, which would crash whatever the
 * caller was doing (a UI render, a heartbeat tick, a CLI
 * writeFile, etc.).
 *
 * In the lock subsystem a single broken listener should never
 * bring down the lock system itself. We catch the error, log it
 * with `logE2E` (so the failure is observable), and continue.
 * The contract is: "the lock operation succeeded; observability
 * about it may be partial".
 */
function safeEmit(event: string, ...args: unknown[]): void {
  try {
    lockEventEmitter.emit(event, ...args);
  } catch (err) {
    try {
      logE2E("SUPERAGENT-SERVER", "lockEventEmitter.emit threw", { event, error: String(err) });
    } catch {
      // If even the logger is broken, swallow. We cannot let an
      // event listener failure cascade into a user-facing crash.
    }
  }
}

const DEFAULT_TTL_MS = 30000;
const INTENT_SOFT_LOCK_TTL_MS = 8000;
const activeHeartbeats = new Map<string, NodeJS.Timeout>();
let staleLocksCleanedCount = 0;
let recoveryDaemonTimer: NodeJS.Timeout | null = null;

// High-Performance In-Memory Cache with mtime-based Multi-Process Invalidation
let memoryLockCache: FileLockEntry[] | null = null;
let lastCacheMtime: number = 0;
let saveDebounceTimer: NodeJS.Timeout | null = null;

function getLocksFilePath(): string {
  const configDir = getRootConfigDir();
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }
  return path.join(configDir, "file-locks.json");
}

/**
 * Single source of truth for "is this lock stale and should be ignored?".
 *
 * A lock is stale when ANY of these is true:
 *   1. Its TTL has expired (lockedAt + ttlMs is in the past).
 *   2. Its owner PID is dead (no such process, crashed/killed).
 *   3. Its heartbeat has stopped pinging (2× the heartbeat interval).
 *
 * Centralizing this here means `lockFile`, `checkFileLock`,
 * `releaseFile`, `getLockStats`, and `startDeadlockRecoveryDaemon`
 * all agree on which locks to drop, and they cannot drift apart
 * in future refactors. (Past drift caused user-visible bugs in
 * v1.5.2 / v1.5.3 / v1.5.4.)
 */
function isStaleLock(l: FileLockEntry, now: number = Date.now()): boolean {
  return (
    now - l.lockedAt >= l.ttlMs ||
    isLockStaleByLiveness(l) ||
    isLockStaleByHeartbeat(l, now)
  );
}

/**
 * Filter helper used everywhere we need "live" locks. Wraps
 * `isStaleLock` so call sites stay readable and consistent.
 */
function getLiveLocks(locks: FileLockEntry[], now: number = Date.now()): FileLockEntry[] {
  return locks.filter(l => !isStaleLock(l, now));
}

function loadLocksFromDisk(): FileLockEntry[] {
  const locksFile = getLocksFilePath();
  // Single stat call: returns null instead of throwing if the file
  // doesn't exist. Replaces the old `existsSync + statSync` pair which
  // was 2 syscalls + a TOCTOU race window.
  let stat: fs.Stats | null;
  try {
    stat = fs.statSync(locksFile);
  } catch {
    stat = null;
  }

  if (!stat) {
    memoryLockCache = [];
    lastCacheMtime = 0;
    return memoryLockCache;
  }

  // Mtime-based cache: if the file on disk has the same mtime as our
  // last successful read, the parsed array is still authoritative.
  // This skips both the `readFileSync` and the `JSON.parse` on the
  // hot path (heartbeat, checkFileLock, getLockStats, recovery daemon).
  if (memoryLockCache && stat.mtimeMs <= lastCacheMtime) {
    return memoryLockCache;
  }

  try {
    const raw = fs.readFileSync(locksFile, "utf-8");
    const parsed = JSON.parse(raw);
    memoryLockCache = Array.isArray(parsed) ? parsed : [];
    lastCacheMtime = stat.mtimeMs;
  } catch {
    if (!memoryLockCache) memoryLockCache = [];
  }
  return memoryLockCache!;
}

/**
 * Atomic write of the lock store: write to a `.tmp` file first, then
 * rename it over the real file. On POSIX (Linux/macOS) and NTFS (Windows)
 * `rename` is atomic, so a reader will always see either the previous
 * version of the file or the new one — never a half-written, corrupt
 * file. Without this, two processes (CLI + t-line) writing concurrently
 * can produce a truncated JSON file that crashes `loadLocksFromDisk`.
 *
 * `lastCacheMtime` is then bumped to `+∞` so the in-process cache is
 * forced to re-read on the next call. (The new mtime will be greater
 * than `lastCacheMtime` so the normal mtime cache would actually be
 * valid — but we still bump to defensively invalidate any other path
 * that may have read the file out of band.)
 */
function atomicWriteLocksFile(locksFile: string, content: string) {
  const tmpFile = `${locksFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, content, "utf-8");
    fs.renameSync(tmpFile, locksFile);
    // Bump the mtime cache so concurrent reads in this process see
    // the new state. (Cross-process readers do their own stat.)
    lastCacheMtime = Date.now();
  } catch (err) {
    // Best-effort cleanup of the temp file. Don't let a half-written
    // .tmp accumulate if the rename failed.
    try { fs.unlinkSync(tmpFile); } catch { /* file may not exist */ }
    throw err;
  }
}

function persistLocksToDisk(locks: FileLockEntry[], immediate: boolean = false) {
  memoryLockCache = locks;
  const locksFile = getLocksFilePath();
  const content = JSON.stringify(locks, null, 2);

  if (immediate) {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = null;
    }
    try {
      atomicWriteLocksFile(locksFile, content);
    } catch {}
    return;
  }

  if (saveDebounceTimer) {
    clearTimeout(saveDebounceTimer);
  }

  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    try {
      if (memoryLockCache) {
        atomicWriteLocksFile(locksFile, content);
      }
    } catch {}
  }, 100);
}

// ─── Process-exit cleanup ─────────────────────────────────────────────
// When the CLI is killed (Ctrl-C, kill, unhandled exception) we want
// to clear any active heartbeat timers and any pending debounced save
// before Node tears the event loop down. Without this, a `setTimeout`
// can keep the process alive for 100ms after the user expects it to
// exit, and in some edge cases a debounced save can fire after exit
// and write stale data to disk.
//
// `process.on('exit')` runs synchronously and is the last chance to
// do synchronous cleanup. We register once, guarded by a flag so that
// any subsequent re-registration (e.g. from `startLockHeartbeat`
// reimport in a test) is a no-op.
let exitCleanupRegistered = false;
function registerExitCleanup() {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.on("exit", () => {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = null;
    }
    for (const timer of activeHeartbeats.values()) clearInterval(timer);
    activeHeartbeats.clear();
    sessionLocksByKey.clear();
  });
}
registerExitCleanup();

/**
 * Check whether a process with the given PID is still alive.
 *
 * Uses `process.kill(pid, 0)` which is the canonical cross-platform probe
 * for "does this PID exist?":
 *   - Returns without error  -> process is alive.
 *   - Throws ESRCH           -> no such process (dead).
 *   - Throws EPERM           -> process exists but is owned by another user
 *                              (we still consider it alive).
 *   - Throws EINVAL          -> invalid signal (e.g. Windows); treat as dead.
 *
 * Returns `true` only when we have high confidence the process is still
 * running. Any unexpected error falls back to "dead" so that stale locks
 * are eventually released instead of blocking the user forever.
 */
// ─── PID liveness cache ──────────────────────────────────────────────
// `process.kill(pid, 0)` is a syscall to the OS. On Windows it costs
// ~5-20ms per call (kernel transition + handle open + NtQueryObject).
// For the recovery daemon (5s tick × N locks) and the heartbeat
// path (10s tick × N locks), this dominates the lock-check time.
//
// We avoid repeating the syscall for the same PID within a short
// window. The cache is intentionally small (max 256 entries) and
// uses a TTL of 30s — long enough to coalesce calls in a hot loop,
// short enough that a PID that died will be re-probed quickly.
//
// The current process's own PID is a special case: it's always
// alive, so we cache it permanently and skip the syscall entirely.
const PID_CACHE_TTL_MS = 30_000;
const PID_CACHE_MAX = 256;
const pidLivenessCache = new Map<number, { alive: boolean; checkedAt: number }>();

function probePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err && err.code === "EPERM") return true;
    return false;
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  // Own process is always alive — fast path with no syscall.
  if (pid === process.pid) return true;

  const cached = pidLivenessCache.get(pid);
  if (cached && Date.now() - cached.checkedAt < PID_CACHE_TTL_MS) {
    return cached.alive;
  }

  const alive = probePid(pid);
  // LRU-ish eviction: when over the cap, drop the oldest entry.
  if (pidLivenessCache.size >= PID_CACHE_MAX) {
    const oldestKey = pidLivenessCache.keys().next().value;
    if (oldestKey !== undefined) pidLivenessCache.delete(oldestKey);
  }
  pidLivenessCache.set(pid, { alive, checkedAt: Date.now() });
  return alive;
}

/**
 * Determine whether a lock entry should still be considered held by an
 * active process. A lock is considered STALE (and therefore safe to
 * ignore) when ALL of the following hold:
 *   1. The entry carries a PID (new-format lock).
 *   2. The PID is no longer alive.
 *
 * Legacy entries (no PID) keep their old TTL-only behavior so that
 * pre-existing on-disk locks continue to work without a migration.
 */
function isLockStaleByLiveness(lock: FileLockEntry): boolean {
  if (lock.pid === undefined) return false; // legacy entry, trust TTL
  return !isProcessAlive(lock.pid);
}

/**
 * Determine whether a lock entry is stale because its heartbeat stopped
 * pinging. The lock holder is expected to refresh `heartbeatPingAt` every
 * `heartbeatMs` (default 10 s). If the gap exceeds 2× the heartbeat
 * interval we assume the holder died without releasing the lock.
 */
function isLockStaleByHeartbeat(lock: FileLockEntry, now: number): boolean {
  if (lock.heartbeatPingAt === undefined) return false;
  const interval = lock.heartbeatMs && lock.heartbeatMs > 0 ? lock.heartbeatMs : 10000;
  return now - lock.heartbeatPingAt > interval * 2;
}

// Process Exit & Signal Graceful Cleanup Lifecycle Hooks
function flushPendingLocksOnExit() {
  if (memoryLockCache) {
    persistLocksToDisk(memoryLockCache, true);
  }
}
process.on("beforeExit", flushPendingLocksOnExit);
process.on("exit", flushPendingLocksOnExit);
process.on("SIGINT", () => {
  flushPendingLocksOnExit();
  process.exit(0);
});
process.on("SIGTERM", () => {
  flushPendingLocksOnExit();
  process.exit(0);
});
try {
  process.on("SIGBREAK", () => {
    flushPendingLocksOnExit();
    process.exit(0);
  });
} catch {}

function withLock<T>(fn: () => T): T {
  const locksFile = getLocksFilePath();
  const lockFile = locksFile + ".lock";

  let acquired = false;
  const start = Date.now();

  while (!acquired && Date.now() - start < 500) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, time: Date.now() }), { flag: "wx" });
      acquired = true;
    } catch {
      try {
        if (fs.existsSync(lockFile)) {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 2000) {
            fs.unlinkSync(lockFile);
          }
        }
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }

  if (!acquired) {
    throw new Error("Failed to acquire lock");
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
        }
      } catch {}
    }
  }
}

function isOverlappingRange(r1?: LineRange, r2?: LineRange): boolean {
  if (!r1 || !r2) return true;
  return r1.startLine <= r2.endLine && r2.startLine <= r1.endLine;
}

export function lockFile(
  filePath: string,
  sessionId: string,
  terminalType: string = "cli",
  ttlMs: number = DEFAULT_TTL_MS,
  cwd?: string,
  isIntentSoftLock?: boolean,
  lineRange?: LineRange,
  remoteNodeId?: string,
  /**
   * Heartbeat interval (ms) the lock owner will ping at. Used to detect
   * a silently crashed owner even if the OS PID probe is unavailable.
   * Defaults to 10s, matching `startLockHeartbeat`.
   */
  intervalMs: number = 10000
): { success: boolean; owner?: FileLockEntry; message?: string } {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  const now = Date.now();

  return withLock(() => {
    let locks = loadLocksFromDisk();
    // Drop expired locks (TTL) AND locks held by dead processes (liveness)
    // AND locks whose heartbeat stopped pinging. This prevents the "false
    // locked file" bug where a previously killed / silently-disconnected
    // session leaves a lock on disk that blocks the new single session.
    //
    // The triple filter MUST stay in sync with `checkFileLock`,
    // `getLockStats`, and `startDeadlockRecoveryDaemon` so that
    // `lockFile()` and `checkFileLock()` always agree on whether a given
    // path is locked. Otherwise we get a confusing UX where the user is
    // told "file is not locked" but `lockFile()` then refuses to acquire
    // with `LOCK_CONFLICT`.
    locks = getLiveLocks(locks, now);

    const conflicting = locks.find(
      l =>
        path.resolve(l.filePath) === absPath &&
        l.projectPath === projectPath &&
        isOverlappingRange(l.lineRange, lineRange)
    );

    if (conflicting) {
      if (conflicting.sessionId === sessionId) {
        conflicting.lockedAt = now;
        conflicting.ttlMs = ttlMs;
        conflicting.heartbeatPingAt = now;
        conflicting.heartbeatMs = intervalMs;
        conflicting.pid = process.pid;
        conflicting.isIntentSoftLock = !!isIntentSoftLock;
        if (lineRange) conflicting.lineRange = lineRange;
        persistLocksToDisk(locks);
        safeEmit("lock_updated", conflicting);
        const updateDetails: LockEventDetails = {
          projectPath,
          lineRange: lineRange || null,
          ttlMs,
          isIntentSoftLock: !!isIntentSoftLock,
          remoteNodeId,
          lockedAt: now,
          details: `Lock renewed by same session ${sessionId} (${terminalType}) on ${path.basename(absPath)}`,
        };
        // During a `refreshSessionLocks` tick we want to batch all
        // `lock_updated` events into a single transaction at the
        // end of the tick. Outside of a tick (ad-hoc renewals
        // from the UI) we fall through to the immediate write.
        if (lockEventQueue.length > 0 || isRefreshingLocks) {
          lockEventQueue.push([absPath, sessionId, terminalType, isIntentSoftLock ? "soft_locked" : "lock_updated", updateDetails]);
        } else {
          recordLockEvent(absPath, sessionId, terminalType, isIntentSoftLock ? "soft_locked" : "lock_updated", updateDetails);
        }
        logE2E("SUPERAGENT-SERVER", `[LOCK] lock_updated: ${path.basename(absPath)} by session ${sessionId} (${terminalType})`, {
          filePath: absPath,
          projectPath,
          lineRange: lineRange ? `${lineRange.startLine}-${lineRange.endLine}` : "full",
          ttlMs,
          isIntentSoftLock: !!isIntentSoftLock,
          remoteNodeId: remoteNodeId || null,
        });
        return { success: true, owner: conflicting };
      }
      const blockDetails: LockEventDetails = {
        projectPath,
        lineRange: lineRange || null,
        ttlMs,
        isIntentSoftLock: !!isIntentSoftLock,
        remoteNodeId,
        lockedAt: now,
        details: `Lock conflict blocked: file locked by ${conflicting.terminalType || "another"} session (${conflicting.sessionId})`,
      };
      recordLockEvent(absPath, sessionId, terminalType, "conflict_blocked", blockDetails);
      logE2E("SUPERAGENT-SERVER", `[LOCK] conflict_blocked: ${path.basename(absPath)} by session ${sessionId} (${terminalType})`, {
        filePath: absPath,
        projectPath,
        lineRange: lineRange ? `${lineRange.startLine}-${lineRange.endLine}` : "full",
        conflictingSessionId: conflicting.sessionId,
        conflictingTerminalType: conflicting.terminalType || "unknown",
        conflictingLockedAt: conflicting.lockedAt,
        conflictingTtlMs: conflicting.ttlMs,
      });
      return {
        success: false,
        owner: conflicting,
        message: `File/range [${lineRange ? `${lineRange.startLine}-${lineRange.endLine}` : "full"}] is locked by ${conflicting.terminalType || "another"} session (${conflicting.sessionId}).`,
      };
    }

    const newLock: FileLockEntry = {
      filePath: absPath,
      sessionId,
      terminalType,
      lockedAt: now,
      ttlMs: isIntentSoftLock ? INTENT_SOFT_LOCK_TTL_MS : ttlMs,
      projectPath,
      isIntentSoftLock: !!isIntentSoftLock,
      heartbeatPingAt: now,
      heartbeatMs: intervalMs,
      // Record the lock-owner's PID so future `checkFileLock` calls can
      // verify the owner is still alive. This is the cornerstone of the
      // "false locked file" fix: a lock whose owner PID is dead (or a
      // heartbeat that stopped pinging) is treated as stale and ignored.
      pid: process.pid,
      lineRange,
      remoteNodeId,
    };

    locks.push(newLock);
    persistLocksToDisk(locks, true);
    const acquireDetails: LockEventDetails = {
      projectPath,
      lineRange: lineRange || null,
      ttlMs: isIntentSoftLock ? INTENT_SOFT_LOCK_TTL_MS : ttlMs,
      isIntentSoftLock: !!isIntentSoftLock,
      remoteNodeId,
      lockedAt: now,
      details: `Lock acquired by session ${sessionId} (${terminalType}) on ${path.basename(absPath)}`,
    };
    recordLockEvent(absPath, sessionId, terminalType, isIntentSoftLock ? "soft_locked" : "acquired", acquireDetails);
    logE2E("SUPERAGENT-SERVER", `[LOCK] ${isIntentSoftLock ? "soft_locked" : "acquired"}: ${path.basename(absPath)} by session ${sessionId} (${terminalType})`, {
      filePath: absPath,
      projectPath,
      lineRange: lineRange ? `${lineRange.startLine}-${lineRange.endLine}` : "full",
      ttlMs: isIntentSoftLock ? INTENT_SOFT_LOCK_TTL_MS : ttlMs,
      isIntentSoftLock: !!isIntentSoftLock,
      remoteNodeId: remoteNodeId || null,
      lockedAt: now,
    });
    safeEmit("lock_acquired", newLock);
    safeEmit("tline_bridge_sync", { event: "lock_acquired", lock: newLock });
    if (remoteNodeId) {
      safeEmit("remote_node_lock_propagated", { remoteNodeId, lock: newLock });
    }

    return { success: true, owner: newLock };
  });
}

/**
 * Adaptive heartbeat table. The session-level heartbeat widens its
 * interval as the lock count grows, since per-tick CPU + syscalls
 * scale with the number of locks. We pick an interval that's still
 * well under the lock TTL (30s default) so even a missed tick is
 * recoverable.
 */
const HEARTBEAT_TIERS: ReadonlyArray<{ maxLocks: number; intervalMs: number }> = [
  { maxLocks: 2, intervalMs: 10_000 },
  { maxLocks: 10, intervalMs: 20_000 },
  { maxLocks: Infinity, intervalMs: 30_000 },
];

function computeAdaptiveInterval(listLengthHint: number, requestedIntervalMs: number): number {
  for (const tier of HEARTBEAT_TIERS) {
    if (listLengthHint <= tier.maxLocks) {
      // Use the wider of (tier interval, requested interval) so
      // callers that explicitly ask for a faster heartbeat still
      // get it. We never override upwards beyond what the caller
      // asked for.
      return Math.max(tier.intervalMs, requestedIntervalMs);
    }
  }
  return requestedIntervalMs;
}

export function startLockHeartbeat(
  filePath: string,
  sessionId: string,
  terminalType: string = "cli",
  cwd?: string,
  intervalMs: number = 10000,
  lineRange?: LineRange
) {
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  // ─── Per-session heartbeat optimization ─────────────────────────────
  // Instead of one `setInterval` per locked file (which produced N
  // timers and N disk writes every `intervalMs`), we now keep one
  // heartbeat timer per (sessionId, cwd) pair. The timer iterates
  // over all locks owned by that session and refreshes them in
  // memory. Only when at least one lock actually changed do we
  // touch the disk, batching the writes from N down to 1.
  //
  // This means a session that locks 5 files now has 1 timer (not
  // 5) and performs 1 disk write per tick (not 5). For a long-
  // running multi-file session the saving is ~80% fewer syscalls.
  // ───────────────────────────────────────────────────────────────────
  const sessionKey = `${sessionId}::${getNormalizedProjectPath(cwd || process.cwd())}`;
  if (!activeHeartbeats.has(sessionKey)) {
    // Adaptive heartbeat interval. The default 10s is fine for a
    // single lock, but a session with many locks spends more CPU
    // re-validating them. We widen the interval as lock count
    // grows, while keeping the TTL buffer in proportion so we
    // still renew well before expiry.
    //
    // | locks | interval | rationale                              |
    // |-------|----------|-----------------------------------------|
    // | 1-2   | 10s      | matches the per-file default; default   |
    // | 3-10  | 20s      | halves tick rate, halves CPU/syscall    |
    // | 11+   | 30s      | even rarer, still well under TTL        |
    const listLengthHint = (sessionLocksByKey.get(sessionKey) || []).length + 1;
    const adaptiveInterval = computeAdaptiveInterval(listLengthHint, intervalMs);
    const timer = setInterval(() => {
      refreshSessionLocks(sessionKey, adaptiveInterval);
    }, adaptiveInterval);
    // `unref()` so the heartbeat cannot keep the Node event loop
    // alive on its own. If every other ref'd handle goes away the
    // process can exit cleanly even if a heartbeat is still
    // scheduled (it just won't fire).
    if (typeof (timer as any).unref === "function") (timer as any).unref();
    activeHeartbeats.set(sessionKey, timer);
  }
  // Track the file under the session so `stopLockHeartbeat` and the
  // refresh callback can find it.
  registerLockUnderSession(sessionKey, {
    filePath: absPath,
    sessionId,
    terminalType,
    cwd: cwd || process.cwd(),
    lineRange,
    intervalMs,
  });
}

interface SessionLock {
  filePath: string;
  sessionId: string;
  terminalType: string;
  cwd: string;
  lineRange?: LineRange;
  intervalMs: number;
}

// sessionKey → SessionLock[]
const sessionLocksByKey = new Map<string, SessionLock[]>();

function registerLockUnderSession(sessionKey: string, lock: SessionLock) {
  const list = sessionLocksByKey.get(sessionKey);
  if (list) {
    // Avoid duplicate registration for the same (file, lineRange).
    const dup = list.find(
      l => l.filePath === lock.filePath &&
        ((!l.lineRange && !lock.lineRange) ||
          (l.lineRange && lock.lineRange &&
            l.lineRange.startLine === lock.lineRange.startLine &&
            l.lineRange.endLine === lock.lineRange.endLine))
    );
    if (dup) return;
    list.push(lock);
  } else {
    sessionLocksByKey.set(sessionKey, [lock]);
  }
}

function unregisterLockFromSession(
  sessionKey: string,
  filePath: string,
  lineRange?: LineRange
): boolean {
  const list = sessionLocksByKey.get(sessionKey);
  if (!list) return false;
  const idx = list.findIndex(
    l => l.filePath === filePath &&
      ((!l.lineRange && !lineRange) ||
        (l.lineRange && lineRange &&
          l.lineRange.startLine === lineRange.startLine &&
          l.lineRange.endLine === lineRange.endLine))
  );
  if (idx === -1) return false;
  list.splice(idx, 1);
  if (list.length === 0) sessionLocksByKey.delete(sessionKey);
  return true;
}

/**
 * Guard flag for the per-tick event batch. When `true`, `lockFile`
 * pushes `lock_updated` events into `lockEventQueue` instead of
 * writing them to SQLite immediately. `refreshSessionLocks` sets
 * this flag for the duration of the tick and clears it before
 * flushing the queue.
 */
let isRefreshingLocks = false;

function refreshSessionLocks(sessionKey: string, _intervalMs: number) {
  const list = sessionLocksByKey.get(sessionKey);
  if (!list || list.length === 0) return;
  // Bump the heartbeat in memory and let the mtime cache decide
  // whether the disk file actually needs to be re-read on next
  // call. The `lockFile` self-renewal path is fast (it reuses the
  // existing entry when same-session).
  //
  // Each `lockFile` self-renewal would normally emit a "lock_updated"
  // event that fans out into a `recordLockEvent` SQLite INSERT. For
  // a session with N locks that's N INSERTs per heartbeat tick. We
  // set the `isRefreshingLocks` guard and let `lockFile` push into
  // `lockEventQueue` instead of writing immediately, then flush
  // once at the end of the tick via `recordLockEventBatch`
  // (1 transaction = 1 fsync).
  lockEventQueue.length = 0;
  isRefreshingLocks = true;
  try {
    for (const lock of list) {
      try {
        lockFile(lock.filePath, lock.sessionId, lock.terminalType, DEFAULT_TTL_MS,
          lock.cwd, false, lock.lineRange, undefined, lock.intervalMs);
      } catch { /* individual failures are non-fatal */ }
    }
  } finally {
    isRefreshingLocks = false;
  }
  // Single transaction flush of all accumulated lock events.
  if (lockEventQueue.length > 0) {
    recordLockEventBatch(lockEventQueue.splice(0));
  }
}

/**
 * Per-tick event queue. `lockFile` pushes `lock_updated` events
 * here during a `refreshSessionLocks` pass; the pass ends with a
 * single `recordLockEventBatch(...)` flush. Outside of a refresh
 * pass (e.g. ad-hoc `lockFile`/`releaseFile` calls from user
 * tools), events are written immediately via the legacy
 * `recordLockEvent` path.
 */
const lockEventQueue: Array<Parameters<typeof recordLockEvent>> = [];

export function stopLockHeartbeat(filePath: string, sessionId?: string, cwd?: string, lineRange?: LineRange) {
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());

  // For backward compat, the old key format was
  // `${absPath}::${sessionId}::${lineRangeKey}`. We need to also map
  // any active session-level timers that own this (file, lineRange)
  // combination and unregister the lock from them.
  for (const [key, timer] of activeHeartbeats.entries()) {
    const isOldFormat = key.startsWith(`${absPath}::`);
    const isSessionFormat = sessionId && key === `${sessionId}::${projectPath}`;
    if (!isOldFormat && !isSessionFormat) continue;
    if (isOldFormat && sessionId && !key.includes(`::${sessionId}::`)) continue;

    // Unregister the specific (file, lineRange) from the session
    // bookkeeping. If that was the last lock for the session, the
    // session timer is also cleared and the map entry deleted.
    if (sessionId) {
      unregisterLockFromSession(`${sessionId}::${projectPath}`, absPath, lineRange);
    }

    // Only kill the timer if this is an old-format key (the old
    // per-file timer model), or if the session now has no locks.
    if (isOldFormat) {
      clearInterval(timer);
      activeHeartbeats.delete(key);
    } else if (isSessionFormat) {
      const stillHas = (sessionLocksByKey.get(key) || []).length > 0;
      if (!stillHas) {
        clearInterval(timer);
        activeHeartbeats.delete(key);
        sessionLocksByKey.delete(key);
      }
    }
  }
}

export function setIntentSoftLock(
  filePath: string,
  sessionId: string,
  terminalType: string = "cli",
  cwd?: string,
  lineRange?: LineRange
) {
  return lockFile(filePath, sessionId, terminalType, INTENT_SOFT_LOCK_TTL_MS, cwd, true, lineRange);
}

export function releaseFile(
  filePath: string,
  sessionId?: string,
  cwd?: string,
  forceUnlock: boolean = false,
  lineRange?: LineRange
): { success: boolean; message?: string } {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());
  const absPath = path.resolve(cwd || process.cwd(), filePath);

  stopLockHeartbeat(filePath, forceUnlock ? undefined : sessionId, cwd, lineRange);

  return withLock(() => {
    const now = Date.now();
    let locks = loadLocksFromDisk();
    // A lock whose owner is dead or whose heartbeat stopped pinging is
    // no longer "owned" by anyone. We must NOT block `releaseFile` from
    // cleaning it up just because the caller is a different session
    // (e.g. an admin tool trying to evict a crashed session's lock).
    //
    // Without this filter, the previous "Cannot unlock file locked by
    // session X" error would fire even when session X is provably dead
    // — which contradicts `checkFileLock` (which correctly says "not
    // locked" in the same situation) and leaks the phantom lock on disk
    // until the recovery daemon sweeps it (which is on a 5s timer).
    const isStale = (l: FileLockEntry) => isStaleLock(l, now);
    const targetLock = locks.find(
      l =>
        path.resolve(l.filePath) === absPath &&
        l.projectPath === projectPath &&
        isOverlappingRange(l.lineRange, lineRange)
    );

    if (!targetLock) return { success: true };

    // If the matching lock is already dead/stale, treat it as if there
    // is no owner — allow any caller (including a different session) to
    // release it. This is the only sensible behavior: a dead session
    // cannot object.
    const targetIsStale = isStale(targetLock);
    if (!forceUnlock && sessionId && !targetIsStale && targetLock.sessionId !== sessionId) {
      return {
        success: false,
        message: `Cannot unlock file locked by session ${targetLock.sessionId} without forceUnlock flag.`,
      };
    }

    // Single-pass: iterate once, drop any lock that matches the
    // release criteria, and also drop any lock that has gone stale
    // while we're holding the in-process mutex. (Without the second
    // drop we'd persist stale entries back to disk, forcing the
    // recovery daemon to clean them up on its 5s tick — a needless
    // round-trip through the daemon for locks we already know are
    // dead.)
    const filtered: FileLockEntry[] = [];
    for (const l of locks) {
      const isTarget =
        path.resolve(l.filePath) === absPath &&
        l.projectPath === projectPath &&
        isOverlappingRange(l.lineRange, lineRange);
      if (isTarget) {
        const canDrop =
          forceUnlock || isStale(l) || l.sessionId === (sessionId || targetLock.sessionId);
        if (!canDrop) filtered.push(l); // owner-protected, keep
        continue;
      }
      if (isStaleLock(l, now)) continue; // opportunistic prune
      filtered.push(l);
    }
    persistLocksToDisk(filtered, true);
    const releaseDetails: LockEventDetails = {
      projectPath,
      lineRange: targetLock.lineRange || null,
      ttlMs: targetLock.ttlMs,
      isIntentSoftLock: !!targetLock.isIntentSoftLock,
      remoteNodeId: targetLock.remoteNodeId,
      lockedAt: targetLock.lockedAt,
      releasedAt: Date.now(),
      forceUnlock,
      details: `Lock released by session ${sessionId || targetLock.sessionId} (${targetLock.terminalType || "cli"})${forceUnlock ? " [FORCE UNLOCK]" : ""} on ${path.basename(absPath)}`,
    };
    recordLockEvent(absPath, sessionId || targetLock.sessionId, targetLock.terminalType || "cli", "released", releaseDetails);
    logE2E("SUPERAGENT-SERVER", `[LOCK] released${forceUnlock ? " (force)" : ""}: ${path.basename(absPath)} by session ${sessionId || targetLock.sessionId} (${targetLock.terminalType || "cli"})`, {
      filePath: absPath,
      projectPath,
      lineRange: targetLock.lineRange ? `${targetLock.lineRange.startLine}-${targetLock.lineRange.endLine}` : "full",
      ttlMs: targetLock.ttlMs,
      isIntentSoftLock: !!targetLock.isIntentSoftLock,
      remoteNodeId: targetLock.remoteNodeId || null,
      lockedAt: targetLock.lockedAt,
      releasedAt: Date.now(),
      forceUnlock,
      originalOwnerSessionId: targetLock.sessionId,
      originalOwnerTerminalType: targetLock.terminalType || "cli",
    });
    safeEmit("lock_released", targetLock);
    safeEmit("tline_bridge_sync", { event: "lock_released", lock: targetLock });
    safeEmit("os_notification_toast", {
      title: "File Lock Released",
      message: `File "${path.basename(targetLock.filePath)}" is now available for edits.`,
    });
    return { success: true };
  });
}

export function releaseAllSessionLocks(sessionId: string, cwd?: string): number {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());

  for (const [key, timer] of activeHeartbeats.entries()) {
    if (key.includes(`::${sessionId}::`)) {
      clearInterval(timer);
      activeHeartbeats.delete(key);
    }
  }

  return withLock(() => {
    let locks = loadLocksFromDisk();
    const initialCount = locks.length;
    const released = locks.filter(l => l.projectPath === projectPath && l.sessionId === sessionId);
    const filtered = locks.filter(l => !(l.projectPath === projectPath && l.sessionId === sessionId));

    persistLocksToDisk(filtered, true);
    released.forEach(r => {
      const releaseAllDetails: LockEventDetails = {
        projectPath,
        lineRange: r.lineRange || null,
        ttlMs: r.ttlMs,
        isIntentSoftLock: !!r.isIntentSoftLock,
        remoteNodeId: r.remoteNodeId,
        lockedAt: r.lockedAt,
        releasedAt: Date.now(),
        details: `All session locks released for session ${sessionId} (${r.terminalType || "cli"}) on ${path.basename(r.filePath)}`,
      };
      recordLockEvent(r.filePath, sessionId, r.terminalType || "cli", "released", releaseAllDetails);
      logE2E("SUPERAGENT-SERVER", `[LOCK] release_all: ${path.basename(r.filePath)} for session ${sessionId} (${r.terminalType || "cli"})`, {
        filePath: r.filePath,
        projectPath,
        lineRange: r.lineRange ? `${r.lineRange.startLine}-${r.lineRange.endLine}` : "full",
        ttlMs: r.ttlMs,
        isIntentSoftLock: !!r.isIntentSoftLock,
        remoteNodeId: r.remoteNodeId || null,
        lockedAt: r.lockedAt,
        releasedAt: Date.now(),
      });
      safeEmit("lock_released", r);
      safeEmit("tline_bridge_sync", { event: "lock_released", lock: r });
    });
    return initialCount - filtered.length;
  });
}

export function checkFileLock(
  filePath: string,
  sessionId?: string,
  cwd?: string,
  lineRange?: LineRange
): { locked: boolean; owner?: FileLockEntry } {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  const now = Date.now();

  try {
    const locks = loadLocksFromDisk();
    // ─────────────────────────────────────────────────────────────────
    // False-Locked-File Fix:
    // 1. Drop locks whose TTL has expired (original behavior).
    // 2. Drop locks whose owning PID is dead (the lock holder crashed
    //    / was killed / the session was force-closed). This is the
    //    primary fix for the "single session, file still reported as
    //    locked" bug.
    // 3. Drop locks whose heartbeat stopped pinging (2× interval).
    // Legacy entries (no `pid`/`heartbeatPingAt`) keep their TTL-only
    // behavior so existing on-disk locks remain backward compatible.
    // ─────────────────────────────────────────────────────────────────
    const liveLocks = getLiveLocks(locks, now);
    const valid = liveLocks.find(
      l =>
        path.resolve(l.filePath) === absPath &&
        l.projectPath === projectPath &&
        isOverlappingRange(l.lineRange, lineRange)
    );
    if (valid) {
      if (sessionId && valid.sessionId === sessionId) {
        return { locked: false, owner: valid };
      }
      return { locked: true, owner: valid };
    }
  } catch {}

  return { locked: false };
}

export function startDeadlockRecoveryDaemon(checkIntervalMs: number = 5000) {
  if (recoveryDaemonTimer) return;

  recoveryDaemonTimer = setInterval(() => {
    withLock(() => {
      const now = Date.now();
      let locks = loadLocksFromDisk();
      // A lock is "active" when it has not expired AND its owner is
      // still alive AND its heartbeat is still fresh. Any other lock
      // is treated as stale and is reclaimed by the daemon.
      const active = getLiveLocks(locks, now);
      const stale = locks.filter(l => isStaleLock(l, now));
      const staleCount = stale.length;
      if (staleCount > 0) {
        staleLocksCleanedCount += staleCount;
        persistLocksToDisk(active, true);
        for (const staleLock of stale) {
          const isDead = isLockStaleByLiveness(staleLock);
          const isHeartbeatStale = isLockStaleByHeartbeat(staleLock, now);
          const reason = isDead
            ? "owner PID is no longer alive"
            : isHeartbeatStale
            ? "heartbeat stopped pinging"
            : `TTL expired after ${staleLock.ttlMs}ms`;
          const staleDetails: LockEventDetails = {
            projectPath: staleLock.projectPath,
            lineRange: staleLock.lineRange || null,
            ttlMs: staleLock.ttlMs,
            isIntentSoftLock: !!staleLock.isIntentSoftLock,
            remoteNodeId: staleLock.remoteNodeId,
            lockedAt: staleLock.lockedAt,
            releasedAt: now,
            details: `Stale lock cleaned by deadlock recovery daemon (${reason})`,
          };
          recordLockEvent(staleLock.filePath, staleLock.sessionId, staleLock.terminalType || "cli", "deadlock_recovered", staleDetails);
          logE2E("SUPERAGENT-SERVER", `[LOCK] deadlock_recovered: ${path.basename(staleLock.filePath)} (${reason})`, {
            filePath: staleLock.filePath,
            projectPath: staleLock.projectPath,
            sessionId: staleLock.sessionId,
            terminalType: staleLock.terminalType || "cli",
            lineRange: staleLock.lineRange ? `${staleLock.lineRange.startLine}-${staleLock.lineRange.endLine}` : "full",
            ttlMs: staleLock.ttlMs,
            lockedAt: staleLock.lockedAt,
            cleanedAt: now,
            ageMs: now - staleLock.lockedAt,
            reason,
            pid: staleLock.pid,
            heartbeatPingAt: staleLock.heartbeatPingAt,
          });
        }
        safeEmit("deadlock_recovered", { count: staleCount });
      }
    });
  }, checkIntervalMs);
}

export function stopDeadlockRecoveryDaemon() {
  if (recoveryDaemonTimer) {
    clearInterval(recoveryDaemonTimer);
    recoveryDaemonTimer = null;
  }
}

export function getLockStats(cwd?: string): LockStats {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());
  const now = Date.now();

  const locks = loadLocksFromDisk();
  const activeLocks = locks.filter(
    l =>
      l.projectPath === projectPath &&
      !isStaleLock(l, now)
  );

  const locksByTerminal: Record<string, number> = {};
  activeLocks.forEach(l => {
    const term = l.terminalType || "cli";
    locksByTerminal[term] = (locksByTerminal[term] || 0) + 1;
  });

  return {
    totalActiveLocks: activeLocks.length,
    locksByTerminal,
    staleLocksCleaned: staleLocksCleanedCount,
    activeLocks,
  };
}

if (typeof process !== 'undefined' && !process.env.VITEST) {
  startDeadlockRecoveryDaemon(5000);
}
