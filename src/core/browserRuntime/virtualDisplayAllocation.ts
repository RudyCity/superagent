/**
 * Virtual Display Allocation & Session Lock Manager (Milestone M2)
 *
 * Implements deterministic per-runtime dynamic X11 display number allocation
 * with cross-process atomic file locks, collision prevention (eliminating hardcoded :99),
 * stale lock reclamation, and safe release semantics.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";

export interface DisplayLockMetadata {
  displayNumber: number;
  displayStr: string;
  pid: number;
  creationIdentity: string | null;
  allocatedAt: number;
  host: string;
}

export interface DisplayAllocation {
  displayNumber: number;
  displayStr: string;
  lockFilePath: string;
  xSocketPath: string;
  allocatedAt: number;
  release: () => Promise<void>;
}

export interface AllocateDisplayOptions {
  /** Explicit display number requested by user or test. If specified, acquires this exact display or fails. */
  explicitDisplay?: number;
  /** Start of the dynamic allocation search range (default: 99). */
  rangeStart?: number;
  /** End of the dynamic allocation search range (default: 199). */
  rangeEnd?: number;
  /** Base directory for SuperAgent display lock files (overridable for test isolation). */
  lockDir?: string;
  /** Directory containing system X11 locks (default: /tmp). */
  systemLockDir?: string;
  /** Directory containing X11 domain sockets (default: /tmp/.X11-unix). */
  x11SocketDir?: string;
}

/**
 * Returns the default directory for persistent display lock files:
 * ~/.superagent-r/display-locks
 */
export function getDisplayLockDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  if (process.env.SUPERAGENT_DISPLAY_LOCK_DIR) return process.env.SUPERAGENT_DISPLAY_LOCK_DIR;
  return path.join(os.homedir(), ".superagent-r", "display-locks");
}

/**
 * Probes whether a specific X11 display number is currently active on the host OS.
 * Checks system lock file, Unix domain socket, and SuperAgent runtime locks.
 */
export async function isDisplayActive(
  displayNumber: number,
  options: { systemLockDir?: string; x11SocketDir?: string; lockDir?: string } = {}
): Promise<{ inUse: boolean; reason?: string }> {
  const sysLockDir = options.systemLockDir ?? "/tmp";
  const x11SockDir = options.x11SocketDir ?? "/tmp/.X11-unix";
  const saLockDir = getDisplayLockDir(options.lockDir);

  // 1. System X11 lock check: /tmp/.X{N}-lock
  const sysLockPath = path.join(sysLockDir, `.X${displayNumber}-lock`);
  if (fs.existsSync(sysLockPath)) {
    return { inUse: true, reason: `System X11 lock file exists: ${sysLockPath}` };
  }

  // 2. System X11 domain socket check: /tmp/.X11-unix/X{N}
  const xSocketPath = path.join(x11SockDir, `X${displayNumber}`);
  if (fs.existsSync(xSocketPath)) {
    return { inUse: true, reason: `X11 domain socket exists: ${xSocketPath}` };
  }

  // 3. SuperAgent display lock check: display-${N}.lock
  const saLockPath = path.join(saLockDir, `display-${displayNumber}.lock`);
  if (fs.existsSync(saLockPath)) {
    try {
      const content = await fsp.readFile(saLockPath, "utf8");
      const meta = JSON.parse(content) as DisplayLockMetadata;

      // Verify owner process liveness
      let isAlive = false;
      try {
        process.kill(meta.pid, 0);
        isAlive = true;
      } catch (err: any) {
        // EPERM means process exists but we lack kill permissions -> treat as alive
        isAlive = err.code === "EPERM";
      }

      if (isAlive) {
        return { inUse: true, reason: `SuperAgent display lock active by PID ${meta.pid}` };
      }
      // Dead owner -> stale lock can be reclaimed
    } catch {
      // Corrupt lock file -> assume in use until cleaned
      return { inUse: true, reason: `Corrupt SuperAgent display lock: ${saLockPath}` };
    }
  }

  return { inUse: false };
}

/**
 * Dynamically allocates an available X11 display number within a safe range,
 * establishing an atomic cross-process session lock.
 */
export async function allocateVirtualDisplay(
  options: AllocateDisplayOptions = {}
): Promise<DisplayAllocation> {
  const lockDir = getDisplayLockDir(options.lockDir);
  await fsp.mkdir(lockDir, { recursive: true });

  const currentPid = process.pid;
  const creationIdentity = await readProcessStartIdentity(currentPid);

  // If explicit display number was requested
  if (options.explicitDisplay !== undefined) {
    const num = options.explicitDisplay;
    const probe = await isDisplayActive(num, options);
    if (probe.inUse) {
      throw new Error(`Explicitly requested display :${num} is unavailable: ${probe.reason}`);
    }
    return await acquireDisplayLock(num, lockDir, currentPid, creationIdentity, options);
  }

  const start = options.rangeStart ?? 99;
  const end = options.rangeEnd ?? 199;

  for (let num = start; num <= end; num++) {
    const probe = await isDisplayActive(num, options);
    if (probe.inUse) {
      continue;
    }

    try {
      return await acquireDisplayLock(num, lockDir, currentPid, creationIdentity, options);
    } catch (err: any) {
      if (err.code === "EEXIST") {
        // Race condition: another concurrent worker acquired this slot, try next
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `No available virtual display numbers in range :${start} to :${end}. ` +
    `All display slots are currently occupied or locked.`
  );
}

/**
 * Atomically creates the display lock file and returns the allocation handle.
 */
async function acquireDisplayLock(
  displayNumber: number,
  lockDir: string,
  pid: number,
  creationIdentity: string | null,
  options: AllocateDisplayOptions
): Promise<DisplayAllocation> {
  const lockFilePath = path.join(lockDir, `display-${displayNumber}.lock`);
  const x11SockDir = options.x11SocketDir ?? "/tmp/.X11-unix";
  const xSocketPath = path.join(x11SockDir, `X${displayNumber}`);

  // If stale lock file exists from a dead process, remove it first
  if (fs.existsSync(lockFilePath)) {
    try {
      const content = await fsp.readFile(lockFilePath, "utf8");
      const meta = JSON.parse(content) as DisplayLockMetadata;
      let alive = false;
      try {
        process.kill(meta.pid, 0);
        alive = true;
      } catch (e: any) {
        alive = e.code === "EPERM";
      }
      if (!alive) {
        await fsp.rm(lockFilePath, { force: true });
      }
    } catch {
      await fsp.rm(lockFilePath, { force: true }).catch(() => {});
    }
  }

  const metadata: DisplayLockMetadata = {
    displayNumber,
    displayStr: `:${displayNumber}`,
    pid,
    creationIdentity,
    allocatedAt: Date.now(),
    host: os.hostname(),
  };

  // Flag "wx" ensures atomic creation; fails with EEXIST if another process raced
  await fsp.writeFile(lockFilePath, JSON.stringify(metadata, null, 2), { flag: "wx" });

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    try {
      // Verify we still own this lock file before removing it
      const currentContent = await fsp.readFile(lockFilePath, "utf8");
      const currentMeta = JSON.parse(currentContent) as DisplayLockMetadata;
      if (currentMeta.pid === pid && currentMeta.allocatedAt === metadata.allocatedAt) {
        await fsp.rm(lockFilePath, { force: true });
      }
    } catch {
      // Best effort cleanup
    }
  };

  return {
    displayNumber,
    displayStr: `:${displayNumber}`,
    lockFilePath,
    xSocketPath,
    allocatedAt: metadata.allocatedAt,
    release,
  };
}
