/**
 * Browser Process Manager (Milestones M0 + M1)
 *
 * Coordinates Chromium/Chrome lifecycle, process ownership tracking via ProcessSupervisor,
 * single-instance startup locks, health checks, graceful termination, and recovery.
 *
 * Hard Invariants:
 * 1. Explicit process registration before/upon spawn with PID and creation identity.
 * 2. Never kill external or unverified Chrome processes.
 * 3. Graceful termination with SIGTERM before bounded SIGKILL fallback.
 * 4. Loopback-only CDP binding; sandbox intact (no --no-sandbox).
 * 5. Displayless Linux servers auto-select headless mode; virtual-display fails fast.
 */

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  type BrowserRuntimeMode,
  type ResolvedBrowserMode,
  type BrowserLaunchConfig,
  type BrowserInstanceRecord,
  type BrowserRuntimeHealth,
  type BrowserStopResult,
  type VirtualDisplayInstance,
  type VirtualDisplayHealth,
} from "./types.js";
import {
  discoverBrowserExecutable,
  resolveEffectiveBrowserMode,
} from "./browserExecutableDiscovery.js";
import { buildBrowserLaunchFlags } from "./browserFlags.js";
import { isCdpPortListening } from "../tools/chromeCommon.js";
import { getProcessSupervisor } from "../process/processSupervisor.js";
import {
  readProcessStartIdentity,
  compareProcessStartIdentity,
} from "../tools/cliBridgeProcessIdentity.js";
import { applyProcessIntent } from "../process/processSpawnPolicy.js";
import {
  getVirtualDisplayWorker,
  resetVirtualDisplayWorkerForTest,
} from "./virtualDisplayWorker.js";

export class BrowserProcessManager {
  private activeInstances = new Map<number, BrowserInstanceRecord>();
  private inFlightLaunches = new Map<number, Promise<BrowserInstanceRecord>>();

  /**
   * Resolves the default isolated user-data-dir for Chrome automation.
   */
  public getDefaultUserDataDir(port = 9222): string {
    const baseDir = path.join(os.homedir(), ".superagent-r");
    return port === 9222
      ? path.join(baseDir, "chrome-debug-profile")
      : path.join(baseDir, `chrome-debug-profile-${port}`);
  }

  /**
   * Ensures the profile directory exists and has private POSIX permissions (0700).
   */
  public async prepareUserDataDir(dirPath: string): Promise<void> {
    try {
      await fsp.mkdir(dirPath, { recursive: true });
      if (os.platform() !== "win32") {
        try {
          await fsp.chmod(dirPath, 0o700);
        } catch {
          // Best effort on filesystem types that don't support chmod
        }
      }
    } catch (err: any) {
      throw new Error(`Failed to create isolated Chrome user-data-dir at ${dirPath}: ${err.message}`);
    }
  }

  /**
   * Launches a managed Chrome/Chromium instance with ownership tracking and health checks.
   */
  public async launchBrowser(config: BrowserLaunchConfig = {}): Promise<BrowserInstanceRecord> {
    const port = config.port ?? 9222;
    const host = config.host ?? "127.0.0.1";
    const requestedMode: BrowserRuntimeMode = config.mode ?? "auto";

    // Deduplicate concurrent launches for the same port
    const inFlight = this.inFlightLaunches.get(port);
    if (inFlight) {
      return inFlight;
    }

    const launchPromise = this.executeLaunch(config, port, host, requestedMode);
    this.inFlightLaunches.set(port, launchPromise);

    try {
      return await launchPromise;
    } finally {
      this.inFlightLaunches.delete(port);
    }
  }

  private async executeLaunch(
    config: BrowserLaunchConfig,
    port: number,
    host: string,
    requestedMode: BrowserRuntimeMode
  ): Promise<BrowserInstanceRecord> {
    // 1. Resolve mode (fails fast if virtual-display on non-Linux or headed without display)
    const { mode: resolvedMode } = resolveEffectiveBrowserMode(
      requestedMode,
      os.platform(),
      process.env,
      { preferVirtualDisplay: config.preferVirtualDisplay }
    );

    // A foreign Chrome on this CDP port must never be mistaken for our launch.
    if (await isCdpPortListening(port, 300)) {
      throw new Error("CDP port is already listening; refusing to claim an unowned browser.");
    }
    // Validate Chrome binary, profile and flags before allocating child displays.
    const discovery = discoverBrowserExecutable(config.executablePath, os.platform());
    const executable = discovery.executable;
    const userDataDir = config.userDataDir ?? this.getDefaultUserDataDir(port);
    await this.prepareUserDataDir(userDataDir);
    let virtualDisplay: VirtualDisplayInstance | undefined;

    // 4. Build safe flags
    const flags = buildBrowserLaunchFlags({
      mode: resolvedMode,
      port,
      host,
      userDataDir,
      profileName: config.profileName,
      url: config.url,
      autoSelectDesktopCaptureSource: config.autoSelectDesktopCaptureSource,
      useFakeMediaUi: config.useFakeMediaUi,
      additionalFlags: config.additionalFlags,
    });

    if (resolvedMode === "virtual-display") {
      virtualDisplay = await getVirtualDisplayWorker().startVirtualDisplay(config.virtualDisplay, port);
    }

    // 5. Register with ProcessSupervisor before spawn
    const supervisor = getProcessSupervisor();
    const record = await supervisor.registerProcess({
      component: "browser-runtime",
      executable,
      args: flags,
      launchIntent: resolvedMode === "headless" ? "headless" : "capturedInteractive",
      cleanupPolicy: "caller_owned",
    });

    // 6. Spawn child process
    let child: ChildProcess;
    try {
      const baseSpawnOptions: SpawnOptions = {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          ...(virtualDisplay ? { DISPLAY: virtualDisplay.displayStr } : {}),
        },
      };
      if (os.platform() === "win32") {
        child = spawn(
          executable,
          flags,
          applyProcessIntent(
            baseSpawnOptions,
            resolvedMode === "headless" ? "headless" : "capturedInteractive",
            { caller: "BrowserProcessManager.launchBrowser", executable }
          )
        );
      } else {
        child = spawn(executable, flags, baseSpawnOptions);
      }
    } catch (err: any) {
      if (virtualDisplay) {
        await getVirtualDisplayWorker().stopVirtualDisplay(virtualDisplay).catch(() => {});
      }
      await supervisor.recordProcessExit(record.recordId, {
        exitCode: 1,
        source: "spawn_error",
      });
      throw new Error(`Failed to spawn browser process '${executable}': ${err.message || String(err)}`);
    }

    if (!child.pid) {
      if (virtualDisplay) {
        await getVirtualDisplayWorker().stopVirtualDisplay(virtualDisplay).catch(() => {});
      }
      await supervisor.recordProcessExit(record.recordId, {
        exitCode: 1,
        source: "missing_pid",
      });
      throw new Error(`Browser process spawned without an OS PID.`);
    }

    const pid = child.pid;
    child.unref();

    // 7. Record PID and observe process start identity
    await supervisor.recordProcessSpawn(record.recordId, pid);
    const creationIdentity = await readProcessStartIdentity(pid);
    if (creationIdentity) {
      await supervisor.recordProcessIdentity(record.recordId, creationIdentity);
    }

    // 8. Poll for port readiness
    const timeoutMs = config.timeoutMs ?? 15000;
    const deadline = Date.now() + timeoutMs;
    let ready = false;

    while (Date.now() < deadline) {
      if (await isCdpPortListening(port, 250)) {
        ready = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!ready) {
      // Never leave an owned Chrome child stranded on startup failure.
      // A missing or changed process birth identity forbids signalling.
      const liveIdentity = await readProcessStartIdentity(pid);
      if (creationIdentity && liveIdentity &&
          compareProcessStartIdentity(creationIdentity, liveIdentity) === "matched_unverified") {
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
      if (virtualDisplay) {
        await getVirtualDisplayWorker().stopVirtualDisplay(virtualDisplay).catch(() => {});
      }
      // Check if child exited prematurely
      let exitInfo = "";
      if (child.exitCode !== null) {
        exitInfo = ` (process exited with code ${child.exitCode})`;
      }
      throw new Error(
        `Browser launched (PID ${pid}) but CDP port ${port} did not become active within ${timeoutMs}ms${exitInfo}.`
      );
    }

    // 9. Verify /json/version endpoint
    let browserFingerprint: string | null = null;
    try {
      const versionRes = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (versionRes.ok) {
        const json = (await versionRes.json()) as { webSocketDebuggerUrl?: string };
        if (json.webSocketDebuggerUrl) {
          const wsUrl = new URL(json.webSocketDebuggerUrl);
          browserFingerprint = crypto.createHash("sha256").update(wsUrl.pathname).digest("hex");
        }
      }
    } catch {
      // Non-fatal if version check encounters brief lag
    }

    const instanceRecord: BrowserInstanceRecord = {
      recordId: record.recordId,
      pid,
      creationIdentity,
      port,
      host,
      mode: requestedMode,
      resolvedMode,
      executable,
      userDataDir,
      profileName: config.profileName ?? "Default",
      browserFingerprint,
      launchedAt: Date.now(),
      generation: record.runtimeGeneration,
      virtualDisplay,
    };

    this.activeInstances.set(port, instanceRecord);
    return instanceRecord;
  }

  /**
   * Inspects runtime health and connectivity for a given CDP port.
   */
  public async checkHealth(port = 9222, host = "127.0.0.1"): Promise<BrowserRuntimeHealth> {
    const listening = (await isCdpPortListening(port, 300)) !== null;
    const tracked = this.activeInstances.get(port);

    if (!listening) {
      return {
        status: "stopped",
        listening: false,
        port,
        host,
        mode: tracked?.mode,
        resolvedMode: tracked?.resolvedMode,
        pid: tracked?.pid ?? null,
        recordId: tracked?.recordId ?? null,
        executable: tracked?.executable ?? null,
      };
    }

    try {
      const versionRes = await fetch(`http://${host}:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });

      if (!versionRes.ok) {
        return {
          status: "unhealthy",
          listening: true,
          port,
          host,
          pid: tracked?.pid ?? null,
          error: `HTTP ${versionRes.status} from /json/version`,
        };
      }

      const versionData = (await versionRes.json()) as {
        Browser?: string;
        "Protocol-Version"?: string;
        "User-Agent"?: string;
        webSocketDebuggerUrl?: string;
      };

      let browserFingerprint: string | undefined;
      if (versionData.webSocketDebuggerUrl) {
        const wsUrl = new URL(versionData.webSocketDebuggerUrl);
        browserFingerprint = crypto.createHash("sha256").update(wsUrl.pathname).digest("hex");
      }

      // Query targets count
      let targetCount = 0;
      try {
        const listRes = await fetch(`http://${host}:${port}/json/list`, {
          signal: AbortSignal.timeout(2000),
        });
        if (listRes.ok) {
          const listData = await listRes.json();
          if (Array.isArray(listData)) {
            targetCount = listData.length;
          }
        }
      } catch {
        // Target list failure is non-fatal
      }

      const uptimeMs = tracked ? Date.now() - tracked.launchedAt : undefined;

      let virtualDisplayHealth: VirtualDisplayHealth | undefined;
      if (tracked?.virtualDisplay) {
        try {
          virtualDisplayHealth = await getVirtualDisplayWorker().checkVirtualDisplayHealth(tracked.virtualDisplay);
        } catch {}
      }

      return {
        status: "healthy",
        listening: true,
        port,
        host,
        mode: tracked?.mode,
        resolvedMode: tracked?.resolvedMode,
        pid: tracked?.pid ?? null,
        recordId: tracked?.recordId ?? null,
        executable: tracked?.executable ?? null,
        browserVersion: versionData.Browser,
        protocolVersion: versionData["Protocol-Version"],
        userAgent: versionData["User-Agent"],
        targetCount,
        browserFingerprint,
        uptimeMs,
        virtualDisplay: virtualDisplayHealth,
      };
    } catch (err: any) {
      return {
        status: "unhealthy",
        listening: true,
        port,
        host,
        pid: tracked?.pid ?? null,
        error: `Failed to query CDP endpoints: ${err.message || String(err)}`,
      };
    }
  }

  /**
   * Gracefully terminates an owned browser instance after verifying process ownership.
   * Strictly refuses to terminate foreign or unverified PIDs.
   */
  public async stopBrowser(options: {
    port?: number;
    pid?: number;
    recordId?: string;
    timeoutMs?: number;
  } = {}): Promise<BrowserStopResult> {
    const port = options.port ?? 9222;
    const tracked = this.activeInstances.get(port);
    const targetPid = options.pid ?? tracked?.pid;
    const recordId = options.recordId ?? tracked?.recordId;
    const timeoutMs = options.timeoutMs ?? 3000;

    if (!targetPid) {
      return {
        success: false,
        pid: null,
        reason: `No tracked browser instance found on port ${port}. Refusing to kill unverified processes.`,
        graceful: false,
      };
    }

    // POSITIVE ownership verification mandatory even if a record ID was supplied.
    const currentIdentity = await readProcessStartIdentity(targetPid);
    if (!tracked || tracked.pid !== targetPid ||
        (recordId && recordId !== tracked.recordId) ||
        !tracked.creationIdentity || !currentIdentity) {
      return {
        success: false,
        pid: targetPid,
        reason: `No verifiable owned process identity for PID ${targetPid}; refusing termination.`,
        graceful: false,
      };
    }

    if (compareProcessStartIdentity(tracked.creationIdentity, currentIdentity) !== "matched_unverified") {
      return {
        success: false,
        pid: targetPid,
        reason: `Process start identity mismatch for PID ${targetPid}. Process may have been recycled; aborting termination.`,
        graceful: false,
      };
    }

    // Attempt graceful termination
    try {
      if (os.platform() === "win32") {
        // On Windows, send SIGTERM / taskkill to verified PID
        process.kill(targetPid);
      } else {
        process.kill(targetPid, "SIGTERM");
      }
    } catch (err: any) {
      if (err.code === "ESRCH") {
        // Process already exited
        this.activeInstances.delete(port);
        if (recordId) {
          await getProcessSupervisor().recordProcessExit(recordId, {
            exitCode: 0,
            signal: "SIGTERM",
            source: "already_exited",
          });
        }
        return {
          success: true,
          pid: targetPid,
          reason: "Process already terminated.",
          graceful: true,
        };
      }
      return {
        success: false,
        pid: targetPid,
        reason: `Failed to signal process PID ${targetPid}: ${err.message}`,
        graceful: false,
      };
    }

    // Wait for exit
    const deadline = Date.now() + timeoutMs;
    let exited = false;

    while (Date.now() < deadline) {
      try {
        process.kill(targetPid, 0); // Check liveness
        await new Promise((r) => setTimeout(r, 150));
      } catch {
        exited = true;
        break;
      }
    }

    // If still alive after timeout, send SIGKILL
    if (!exited) {
      const identityBeforeKill = await readProcessStartIdentity(targetPid);
      if (!identityBeforeKill || !tracked.creationIdentity ||
          compareProcessStartIdentity(tracked.creationIdentity, identityBeforeKill) !== "matched_unverified") {
        return { success: false, pid: targetPid,
          reason: "PID identity unverified after grace period; refusing force kill.",
          graceful: false };
      }
      try {
        if (os.platform() !== "win32") {
          process.kill(targetPid, "SIGKILL");
        } else {
          process.kill(targetPid);
        }
      } catch {}
    }

    // Safely terminate virtual display subprocesses and release display allocation if active
    let virtualDisplayStopped = false;
    if (tracked?.virtualDisplay) {
      try {
        await getVirtualDisplayWorker().stopVirtualDisplay(tracked.virtualDisplay);
        virtualDisplayStopped = true;
      } catch {}
    }

    this.activeInstances.delete(port);

    if (recordId) {
      await getProcessSupervisor().recordProcessExit(recordId, {
        exitCode: exited ? 0 : 137,
        signal: exited ? "SIGTERM" : "SIGKILL",
        source: "BrowserProcessManager.stopBrowser",
      });
    }

    return {
      success: true,
      pid: targetPid,
      reason: exited
        ? `Browser process (PID ${targetPid}) terminated gracefully.`
        : `Browser process (PID ${targetPid}) force-terminated after ${timeoutMs}ms.`,
      graceful: exited,
      virtualDisplayStopped,
    };
  }

  /**
   * Ensures Chrome is running and listening on the designated CDP port.
   * Replaces legacy ad-hoc ensureCdpRunning logic with unified runtime supervision.
   */
  public async ensureBrowserRunning(config: BrowserLaunchConfig = {}): Promise<boolean> {
    const port = config.port ?? 9222;

    // Respect test bypass unless explicitly enabled
    if (
      (process.env.NODE_ENV === "test" || process.env.VITEST === "true") &&
      process.env.SUPERAGENT_ALLOW_TEST_BROWSER_LAUNCH !== "1"
    ) {
      return false;
    }

    if (process.env.SUPERAGENT_CDP_AUTO_LAUNCH === "0") {
      return false;
    }

    // If port is already listening and responsive, return true
    if (await isCdpPortListening(port, 250)) {
      return true;
    }

    try {
      await this.launchBrowser(config);
      return true;
    } catch {
      return false;
    }
  }

  public getActiveInstance(port = 9222): BrowserInstanceRecord | undefined {
    return this.activeInstances.get(port);
  }

  public resetForTest(): void {
    this.activeInstances.clear();
    this.inFlightLaunches.clear();
    resetVirtualDisplayWorkerForTest();
  }
}

// Global browser process manager singleton
let globalBrowserProcessManager: BrowserProcessManager | null = null;

export function getBrowserProcessManager(): BrowserProcessManager {
  if (!globalBrowserProcessManager) {
    globalBrowserProcessManager = new BrowserProcessManager();
  }
  return globalBrowserProcessManager;
}

export function resetBrowserProcessManagerForTest(): void {
  if (globalBrowserProcessManager) {
    globalBrowserProcessManager.resetForTest();
  }
  globalBrowserProcessManager = null;
}
