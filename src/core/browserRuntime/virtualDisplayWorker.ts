/**
 * Virtual Display Worker (Milestone M2)
 *
 * Supervises isolated, per-instance headless X11 virtual displays using Xvfb,
 * a lightweight window manager (e.g. openbox), and optional local-only loopback VNC/noVNC transports.
 *
 * Hard Invariants:
 * 1. Strict loopback binding: VNC and noVNC strictly bind to 127.0.0.1; 0.0.0.0 is prohibited.
 * 2. No automatic public tunnels or unauthenticated exposure before Milestone M3.
 * 3. Never terminate foreign or unverified PIDs (verifies process start identity before signaling).
 * 4. Xvfb runs with `-nolisten tcp` to prevent unauthorized X11 network connections.
 * 5. Dynamic display allocation avoids hardcoded :99 collisions.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  type VirtualDisplayConfig,
  type VirtualDisplayInstance,
  type VirtualDisplayProcessInfo,
  type VirtualDisplayHealth,
} from "./types.js";
import {
  allocateVirtualDisplay,
  type DisplayAllocation,
} from "./virtualDisplayAllocation.js";
import {
  assertVirtualDisplayPrerequisites,
  findSystemBinary,
} from "./virtualDisplayPackages.js";
import { getProcessSupervisor } from "../process/processSupervisor.js";
import {
  readProcessStartIdentity,
  compareProcessStartIdentity,
} from "../tools/cliBridgeProcessIdentity.js";
import { checkPortListening } from "../tools/chromeCommon.js";

/**
 * Checks whether an OS process is actively executing.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err: any) {
    return err.code === "EPERM";
  }
  if (os.platform() === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen !== -1 && lastParen + 2 < stat.length) {
        const state = stat.charAt(lastParen + 2);
        if (state === "Z" || state === "X") {
          return false; // Zombie or dead process
        }
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Safely terminates an owned child process after verifying that its
 * OS process start identity matches recorded launch identity.
 */
async function safelyTerminateChild(
  procInfo: VirtualDisplayProcessInfo,
  timeoutMs = 2500
): Promise<boolean> {
  const { pid, creationIdentity, recordId } = procInfo;
  if (!pid) return true;

  // 1. Verify start identity before touching
  const currentIdentity = await readProcessStartIdentity(pid);
  // Fail closed for absent/unverifiable PID identity, not merely mismatch.
  if (!creationIdentity || !currentIdentity ||
      compareProcessStartIdentity(creationIdentity, currentIdentity) !== "matched_unverified") {
    return false;
  }

  // 2. Signal SIGTERM (or default process.kill on Windows)
  try {
    if (os.platform() === "win32") {
      process.kill(pid);
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (err: any) {
    if (err.code === "ESRCH") {
      // Already exited
      return true;
    }
    return false;
  }

  // 3. Bounded polling for exit
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      exited = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // 4. Force SIGKILL if still running
  if (!exited) {
    // The PID may have been recycled during SIGTERM grace period.
    const liveBeforeKill = await readProcessStartIdentity(pid);
    if (!liveBeforeKill ||
        compareProcessStartIdentity(creationIdentity, liveBeforeKill) !== "matched_unverified") {
      return false;
    }
    try {
      if (os.platform() !== "win32") {
        process.kill(pid, "SIGKILL");
      } else {
        process.kill(pid);
      }
    } catch {}
  }

  if (recordId) {
    try {
      await getProcessSupervisor().recordProcessExit(recordId, {
        exitCode: exited ? 0 : 137,
        signal: exited ? "SIGTERM" : "SIGKILL",
        source: "VirtualDisplayWorker.stop",
      });
    } catch {}
  }

  return true;
}

export class VirtualDisplayWorker {
  private activeDisplays = new Map<number, VirtualDisplayInstance>();
  private displayAllocations = new Map<number, DisplayAllocation>();

  /**
   * Starts an isolated Xvfb virtual display with a minimal window manager,
   * returning the active display instance.
   */
  public async startVirtualDisplay(
    config: VirtualDisplayConfig = {},
    cdpPort = 9222
  ): Promise<VirtualDisplayInstance> {
    const width = config.width ?? 1280;
    const height = config.height ?? 800;
    const depth = config.depth ?? 24;
    const dpi = config.dpi ?? 96;
    const geometry = `${width}x${height}x${depth}`;

    // 1. Assert packages on Linux
    const packages = assertVirtualDisplayPrerequisites({
      requireVnc: config.enableLocalVnc,
      requireNoVnc: config.enableLocalNoVnc,
    });

    const xvfbBin = packages.xvfb.path || "Xvfb";
    const wmBin = packages.windowManager.path;
    const wmName = packages.windowManager.name;

    if (!wmBin) {
      throw new Error("No usable window manager found for virtual display.");
    }

    // 2. Allocate non-colliding dynamic display number
    const allocation = await allocateVirtualDisplay({
      explicitDisplay: config.displayNumber,
    });
    const displayNumber = allocation.displayNumber;
    const displayStr = allocation.displayStr;

    this.displayAllocations.set(displayNumber, allocation);

    const supervisor = getProcessSupervisor();

    // 3. Spawn Xvfb with -nolisten tcp for network isolation
    const xvfbArgs = [
      displayStr,
      "-screen",
      "0",
      geometry,
      "-dpi",
      String(dpi),
      "-nolisten",
      "tcp",
      "-noreset",
    ];

    const xvfbRecord = await supervisor.registerProcess({
      component: "virtual-display-xvfb",
      executable: xvfbBin,
      args: xvfbArgs,
      launchIntent: "headless",
      cleanupPolicy: "caller_owned",
    });

    let xvfbChild: ChildProcess;
    try {
      xvfbChild = spawn(xvfbBin, xvfbArgs, {
        detached: true,
        stdio: "ignore",
      });
    } catch (err: any) {
      await allocation.release();
      this.displayAllocations.delete(displayNumber);
      throw new Error(`Failed to spawn Xvfb on display ${displayStr}: ${err.message}`);
    }

    if (!xvfbChild.pid) {
      await allocation.release();
      this.displayAllocations.delete(displayNumber);
      throw new Error(`Xvfb spawned without an OS PID on display ${displayStr}.`);
    }

    const xvfbPid = xvfbChild.pid;
    xvfbChild.unref();

    await supervisor.recordProcessSpawn(xvfbRecord.recordId, xvfbPid);
    const xvfbIdentity = await readProcessStartIdentity(xvfbPid);
    if (xvfbIdentity) {
      await supervisor.recordProcessIdentity(xvfbRecord.recordId, xvfbIdentity);
    }

    const xvfbProcess: VirtualDisplayProcessInfo = {
      pid: xvfbPid,
      creationIdentity: xvfbIdentity,
      executable: xvfbBin,
      recordId: xvfbRecord.recordId,
    };

    // 4. Wait for X11 domain socket readiness (/tmp/.X11-unix/X{N})
    const socketDeadline = Date.now() + 10000;
    let socketReady = false;

    while (Date.now() < socketDeadline) {
      if (fs.existsSync(allocation.xSocketPath)) {
        socketReady = true;
        break;
      }
      if (!isPidAlive(xvfbPid)) {
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }

    if (!socketReady) {
      await safelyTerminateChild(xvfbProcess);
      await allocation.release();
      this.displayAllocations.delete(displayNumber);
      throw new Error(
        `Xvfb started (PID ${xvfbPid}) but X11 socket '${allocation.xSocketPath}' ` +
        `did not appear within 10000ms.`
      );
    }

    // 5. Spawn minimal Window Manager on DISPLAY=:N
    const wmRecord = await supervisor.registerProcess({
      component: "virtual-display-wm",
      executable: wmBin,
      args: [],
      launchIntent: "headless",
      cleanupPolicy: "caller_owned",
    });

    let wmProcess: VirtualDisplayProcessInfo | undefined;
    try {
      const wmChild = spawn(wmBin, [], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          DISPLAY: displayStr,
        },
      });

      if (wmChild.pid) {
        wmChild.unref();
        await supervisor.recordProcessSpawn(wmRecord.recordId, wmChild.pid);
        const wmIdentity = await readProcessStartIdentity(wmChild.pid);
        if (wmIdentity) {
          await supervisor.recordProcessIdentity(wmRecord.recordId, wmIdentity);
        }
        wmProcess = {
          pid: wmChild.pid,
          creationIdentity: wmIdentity,
          executable: wmBin,
          recordId: wmRecord.recordId,
        };
      }
    } catch {
      // WM failure is non-fatal to Xvfb, but recorded in diagnostics
    }

    // 6. Optional local-only VNC (strictly bound to 127.0.0.1)
    let vncProcess: VirtualDisplayProcessInfo | undefined;
    let vncPort: number | undefined;
    let vncPassword: string | undefined;
    let vncPasswordFile: string | undefined;

    if (config.enableLocalVnc) {
      vncPort = config.vncPort ?? (5900 + displayNumber);
      const x11vncBin = packages.x11vnc.path || "x11vnc";
      vncPassword = crypto.randomBytes(16).toString("hex");
      vncPasswordFile = path.join(os.tmpdir(), `.x11vnc-${displayNumber}-${crypto.randomBytes(6).toString("hex")}.pass`);
      await fsp.writeFile(vncPasswordFile, vncPassword, { mode: 0o600 });

      const vncArgs = [
        "-display",
        displayStr,
        "-localhost", // STRICT: Loopback only
        "-rfbport",
        String(vncPort),
        "-passwdfile",
        vncPasswordFile,
        "-shared",
        "-forever",
        "-quiet",
      ];

      const vncRecord = await supervisor.registerProcess({
        component: "virtual-display-vnc",
        executable: x11vncBin,
        args: vncArgs,
        launchIntent: "headless",
        cleanupPolicy: "caller_owned",
      });

      try {
        const vncChild = spawn(x11vncBin, vncArgs, {
          detached: true,
          stdio: "ignore",
        });

        if (vncChild.pid) {
          vncChild.unref();
          await supervisor.recordProcessSpawn(vncRecord.recordId, vncChild.pid);
          const vncIdentity = await readProcessStartIdentity(vncChild.pid);
          if (vncIdentity) {
            await supervisor.recordProcessIdentity(vncRecord.recordId, vncIdentity);
          }
          vncProcess = {
            pid: vncChild.pid,
            creationIdentity: vncIdentity,
            executable: x11vncBin,
            recordId: vncRecord.recordId,
          };
        }
      } catch (err: any) {
        // VNC failure reported in health
      }
    }

    // 7. Optional local-only noVNC websockify (strictly bound to 127.0.0.1)
    let noVncProcess: VirtualDisplayProcessInfo | undefined;
    let noVncPort: number | undefined;

    if (config.enableLocalNoVnc && vncPort) {
      noVncPort = config.noVncPort ?? (6080 + displayNumber - 99);
      const websockifyBin = packages.websockify.path || "websockify";
      const novncWebDir = packages.novncWebDir.path || "/usr/share/novnc";

      // websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5999
      const noVncArgs = [
        "--web",
        novncWebDir,
        `127.0.0.1:${noVncPort}`, // STRICT: Loopback only
        `127.0.0.1:${vncPort}`,
      ];

      const noVncRecord = await supervisor.registerProcess({
        component: "virtual-display-novnc",
        executable: websockifyBin,
        args: noVncArgs,
        launchIntent: "headless",
        cleanupPolicy: "caller_owned",
      });

      try {
        const noVncChild = spawn(websockifyBin, noVncArgs, {
          detached: true,
          stdio: "ignore",
        });

        if (noVncChild.pid) {
          noVncChild.unref();
          await supervisor.recordProcessSpawn(noVncRecord.recordId, noVncChild.pid);
          const noVncIdentity = await readProcessStartIdentity(noVncChild.pid);
          if (noVncIdentity) {
            await supervisor.recordProcessIdentity(noVncRecord.recordId, noVncIdentity);
          }
          noVncProcess = {
            pid: noVncChild.pid,
            creationIdentity: noVncIdentity,
            executable: websockifyBin,
            recordId: noVncRecord.recordId,
          };
        }
      } catch {
        // noVNC failure reported in health
      }
    }

    const instance: VirtualDisplayInstance = {
      displayNumber,
      displayStr,
      lockFilePath: allocation.lockFilePath,
      xSocketPath: allocation.xSocketPath,
      xvfbProcess,
      wmProcess,
      vncProcess,
      noVncProcess,
      geometry,
      allocatedAt: allocation.allocatedAt,
      vncPort,
      vncPassword,
      vncPasswordFile,
      noVncPort,
      vncLocalOnly: true,
    };

    this.activeDisplays.set(displayNumber, instance);
    return instance;
  }

  /**
   * Gracefully shuts down a virtual display instance and terminates all owned subprocesses.
   */
  public async stopVirtualDisplay(instanceOrDisplay: VirtualDisplayInstance | number): Promise<boolean> {
    const displayNumber = typeof instanceOrDisplay === "number"
      ? instanceOrDisplay
      : instanceOrDisplay.displayNumber;

    const instance = typeof instanceOrDisplay === "number"
      ? this.activeDisplays.get(displayNumber)
      : instanceOrDisplay;

    if (!instance) {
      // Nothing to stop
      return true;
    }

    // 1. Terminate noVNC
    if (instance.noVncProcess) {
      await safelyTerminateChild(instance.noVncProcess);
    }

    // 2. Terminate VNC
    if (instance.vncProcess) {
      await safelyTerminateChild(instance.vncProcess);
    }

    // 3. Terminate Window Manager
    if (instance.wmProcess) {
      await safelyTerminateChild(instance.wmProcess);
    }

    // 4. Terminate Xvfb
    await safelyTerminateChild(instance.xvfbProcess);

    if (instance.vncPasswordFile) {
      try {
        await fsp.unlink(instance.vncPasswordFile);
      } catch {}
    }

    // 5. Release session lock
    const allocation = this.displayAllocations.get(displayNumber);
    if (allocation) {
      await allocation.release();
      this.displayAllocations.delete(displayNumber);
    }

    this.activeDisplays.delete(displayNumber);
    return true;
  }

  /**
   * Evaluates the active health status of a virtual display instance.
   */
  public async checkVirtualDisplayHealth(
    instance: VirtualDisplayInstance
  ): Promise<VirtualDisplayHealth> {
    const xSocketActive = fs.existsSync(instance.xSocketPath);
    const xvfbRunning = isPidAlive(instance.xvfbProcess.pid);
    const wmRunning = instance.wmProcess ? isPidAlive(instance.wmProcess.pid) : false;

    let vncRunning = false;
    if (instance.vncPort) {
      vncRunning = await checkPortListening("127.0.0.1", instance.vncPort, 200);
    }

    let noVncRunning = false;
    if (instance.noVncPort) {
      noVncRunning = await checkPortListening("127.0.0.1", instance.noVncPort, 200);
    }

    return {
      display: instance.displayStr,
      displayNumber: instance.displayNumber,
      xSocketActive,
      xvfbRunning,
      wmRunning,
      vncRunning,
      vncPort: instance.vncPort,
      noVncRunning,
      noVncPort: instance.noVncPort,
      boundToLoopbackOnly: true,
    };
  }

  public getActiveDisplay(displayNumber: number): VirtualDisplayInstance | undefined {
    return this.activeDisplays.get(displayNumber);
  }

  public resetForTest(): void {
    this.activeDisplays.clear();
    this.displayAllocations.clear();
  }
}

// Global virtual display worker singleton
let globalVirtualDisplayWorker: VirtualDisplayWorker | null = null;

export function getVirtualDisplayWorker(): VirtualDisplayWorker {
  if (!globalVirtualDisplayWorker) {
    globalVirtualDisplayWorker = new VirtualDisplayWorker();
  }
  return globalVirtualDisplayWorker;
}

export function resetVirtualDisplayWorkerForTest(): void {
  if (globalVirtualDisplayWorker) {
    globalVirtualDisplayWorker.resetForTest();
  }
  globalVirtualDisplayWorker = null;
}
