import fs from "fs";
import path from "path";
import { EventEmitter } from "events";
import { getRootConfigDir } from "../config/paths.js";
import { getNormalizedProjectPath } from "../tools/helpers.js";
import { recordLockEvent } from "./historyDb.js";

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

function loadLocksFromDisk(): FileLockEntry[] {
  const locksFile = getLocksFilePath();
  if (!fs.existsSync(locksFile)) {
    memoryLockCache = [];
    lastCacheMtime = 0;
    return memoryLockCache;
  }

  try {
    const stat = fs.statSync(locksFile);
    if (memoryLockCache && stat.mtimeMs <= lastCacheMtime) {
      return memoryLockCache;
    }

    const raw = fs.readFileSync(locksFile, "utf-8");
    memoryLockCache = JSON.parse(raw);
    if (!Array.isArray(memoryLockCache)) memoryLockCache = [];
    lastCacheMtime = stat.mtimeMs;
  } catch {
    if (!memoryLockCache) memoryLockCache = [];
  }
  return memoryLockCache!;
}

function persistLocksToDisk(locks: FileLockEntry[], immediate: boolean = false) {
  memoryLockCache = locks;
  const locksFile = getLocksFilePath();

  if (immediate) {
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = null;
    }
    try {
      fs.writeFileSync(locksFile, JSON.stringify(locks, null, 2), "utf-8");
      if (fs.existsSync(locksFile)) {
        lastCacheMtime = fs.statSync(locksFile).mtimeMs;
      }
    } catch {}
    return;
  }

  if (saveDebounceTimer) return;

  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    try {
      if (memoryLockCache) {
        fs.writeFileSync(locksFile, JSON.stringify(memoryLockCache, null, 2), "utf-8");
        if (fs.existsSync(locksFile)) {
          lastCacheMtime = fs.statSync(locksFile).mtimeMs;
        }
      }
    } catch {}
  }, 100);
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
    }
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
  remoteNodeId?: string
): { success: boolean; owner?: FileLockEntry; message?: string } {
  const projectPath = getNormalizedProjectPath(cwd || process.cwd());
  const absPath = path.resolve(cwd || process.cwd(), filePath);
  const now = Date.now();

  return withLock(() => {
    let locks = loadLocksFromDisk();
    locks = locks.filter(l => now - l.lockedAt < l.ttlMs);

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
        conflicting.isIntentSoftLock = !!isIntentSoftLock;
        if (lineRange) conflicting.lineRange = lineRange;
        persistLocksToDisk(locks);
        lockEventEmitter.emit("lock_updated", conflicting);
        recordLockEvent(absPath, sessionId, terminalType, isIntentSoftLock ? "soft_locked" : "acquired");
        return { success: true, owner: conflicting };
      }
      recordLockEvent(absPath, sessionId, terminalType, "conflict_blocked");
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
      lineRange,
      remoteNodeId,
    };

    locks.push(newLock);
    persistLocksToDisk(locks, true);
    recordLockEvent(absPath, sessionId, terminalType, isIntentSoftLock ? "soft_locked" : "acquired");
    lockEventEmitter.emit("lock_acquired", newLock);
    lockEventEmitter.emit("tline_bridge_sync", { event: "lock_acquired", lock: newLock });
    if (remoteNodeId) {
      lockEventEmitter.emit("remote_node_lock_propagated", { remoteNodeId, lock: newLock });
    }

    return { success: true, owner: newLock };
  });
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
  const key = `${absPath}::${sessionId}::${lineRange ? `${lineRange.startLine}-${lineRange.endLine}` : "full"}`;
  if (activeHeartbeats.has(key)) return;

  const timer = setInterval(() => {
    lockFile(filePath, sessionId, terminalType, DEFAULT_TTL_MS, cwd, false, lineRange);
  }, intervalMs);

  activeHeartbeats.set(key, timer);
}

export function stopLockHeartbeat(filePath: string, sessionId?: string, cwd?: string, lineRange?: LineRange) {
  const absPath = path.resolve(cwd || process.cwd(), filePath);

  for (const [key, timer] of activeHeartbeats.entries()) {
    const isMatchingFile = key.startsWith(`${absPath}::`);
    const isMatchingSession = !sessionId || key.includes(`::${sessionId}::`);

    if (isMatchingFile && isMatchingSession) {
      clearInterval(timer);
      activeHeartbeats.delete(key);
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
    let locks = loadLocksFromDisk();
    const targetLock = locks.find(
      l =>
        path.resolve(l.filePath) === absPath &&
        l.projectPath === projectPath &&
        isOverlappingRange(l.lineRange, lineRange)
    );

    if (!targetLock) return { success: true };

    if (!forceUnlock && sessionId && targetLock.sessionId !== sessionId) {
      return {
        success: false,
        message: `Cannot unlock file locked by session ${targetLock.sessionId} without forceUnlock flag.`,
      };
    }

    const filtered = locks.filter(
      l =>
        !(
          path.resolve(l.filePath) === absPath &&
          l.projectPath === projectPath &&
          isOverlappingRange(l.lineRange, lineRange)
        )
    );
    persistLocksToDisk(filtered, true);
    recordLockEvent(absPath, sessionId || targetLock.sessionId, targetLock.terminalType || "cli", "released");
    lockEventEmitter.emit("lock_released", targetLock);
    lockEventEmitter.emit("tline_bridge_sync", { event: "lock_released", lock: targetLock });
    lockEventEmitter.emit("os_notification_toast", {
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
      recordLockEvent(r.filePath, sessionId, r.terminalType || "cli", "released");
      lockEventEmitter.emit("lock_released", r);
      lockEventEmitter.emit("tline_bridge_sync", { event: "lock_released", lock: r });
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
    const valid = locks.find(
      l =>
        path.resolve(l.filePath) === absPath &&
        l.projectPath === projectPath &&
        now - l.lockedAt < l.ttlMs &&
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
    const now = Date.now();
    withLock(() => {
      let locks = loadLocksFromDisk();
      const active = locks.filter(l => now - l.lockedAt < l.ttlMs);
      const staleCount = locks.length - active.length;
      if (staleCount > 0) {
        staleLocksCleanedCount += staleCount;
        persistLocksToDisk(active, true);
        lockEventEmitter.emit("deadlock_recovered", { count: staleCount });
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
  const activeLocks = locks.filter(l => l.projectPath === projectPath && now - l.lockedAt < l.ttlMs);

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

startDeadlockRecoveryDaemon(5000);
