/**
 * Guarded migration of a legacy SuperAgent Tray desktop application into
 * the managed Tray lifecycle.
 *
 * No arbitrary taskkill /F, no silent adoption. Requires proof of the legacy
 * process identity, trusted binary provenance, graceful native exit, and
 * attestation of the replacement managed Tray instance.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { getPackageRootDir, getRootConfigDir } from "../config/paths.js";
import { readProcessStartIdentity } from "../tools/cliBridgeProcessIdentity.js";
import {
  readManagedTrayOwner,
  legacyTrayProcessPids,
  inspectManagedTray,
} from "./managedTrayControl.js";
import {
  trustedTrayBuild,
  stageTrustedTrayRelease,
  readTrayReleaseState,
  fileSha256,
  releaseBinaryPath,
} from "./trayReleaseStore.js";
import { trayExecutableCandidates } from "./trayAutoLauncher.js";
import { ManagedSidecarLedger, sidecarOperationFingerprint } from "./managedSidecarLedger.js";
import { validateCoreOperationId } from "./coreLifecycleLedger.js";
import { recordLifecycleEvent, operationHashPrefix } from "./lifecycleTimeline.js";

export type LegacyTrayRecyclePlan = {
  service: "tray";
  action: "recycle";
  operationId: string;
  expectedOwnerPid: number;
  expectedProcessIdentity: string;
  expectedExecutablePath: string;
  expectedLegacyDigest: string;
  targetBuildDigest: string;
  noCoreShutdown: true;
  note: string;
};

type LegacyTrayDescriptor = {
  pid: number;
  executablePath: string;
  commandLine: string;
};

const validIdentity = (v: string) =>
  /^(?:win:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/.test(v);

function canonical(file: string): string {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

function permittedPaths(): string[] {
  const root = getPackageRootDir();
  const config = getRootConfigDir();
  return trayExecutableCandidates(root, config).map(canonical);
}

function assertTrustedExecutablePath(filePath: string): string {
  const canon = canonical(filePath);
  const candidates = permittedPaths();
  const isMatch = candidates.some((c) =>
    process.platform === "win32"
      ? c.toLowerCase() === canon.toLowerCase()
      : c === canon
  );
  if (!isMatch) {
    throw new Error("TRAY_RECYCLE_EXECUTABLE_OUTSIDE_TRUSTED_PATHS");
  }
  return canon;
}

function readWindowsDescriptor(pid: number): LegacyTrayDescriptor {
  const script =
    "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = " +
    pid +
    "' -ErrorAction Stop; if($null -eq $p){exit 3}; " +
    "$p | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
  const raw = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      timeout: 6000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    }
  );
  const value = JSON.parse(raw.trim()) as Record<string, unknown>;
  if (
    Number(value.ProcessId) !== pid ||
    typeof value.ExecutablePath !== "string" ||
    typeof value.CommandLine !== "string"
  ) {
    throw new Error("TRAY_RECYCLE_PROCESS_DESCRIPTOR_INVALID");
  }
  return {
    pid,
    executablePath: value.ExecutablePath,
    commandLine: value.CommandLine,
  };
}

export function readLegacyTrayDescriptor(pid: number): LegacyTrayDescriptor {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("TRAY_RECYCLE_INVALID_PID");
  }
  if (process.platform === "win32") {
    return readWindowsDescriptor(pid);
  }
  throw new Error("TRAY_RECYCLE_PLATFORM_UNSUPPORTED");
}

export async function captureLegacyTrayEvidence(specificPid?: number) {
  const managed = readManagedTrayOwner();
  const legacyPids = legacyTrayProcessPids(managed?.pid ?? null);
  if (!legacyPids.length && specificPid === undefined) {
    throw new Error("TRAY_RECYCLE_NO_LEGACY_PROCESS_FOUND");
  }

  const targetPid = specificPid ?? legacyPids[0];
  if (!legacyPids.includes(targetPid)) {
    throw new Error("TRAY_RECYCLE_PID_NOT_LEGACY_TRAY");
  }

  const descriptor = readLegacyTrayDescriptor(targetPid);
  const exeBase = path.basename(descriptor.executablePath).toLowerCase();
  if (exeBase !== "superagent-tray.exe") {
    throw new Error("TRAY_RECYCLE_NOT_SUPERAGENT_TRAY_BINARY");
  }

  const canonPath = assertTrustedExecutablePath(descriptor.executablePath);
  const legacyDigest = fileSha256(canonPath);
  const identity = await readProcessStartIdentity(targetPid);
  if (!identity || !validIdentity(identity)) {
    throw new Error("TRAY_RECYCLE_PROCESS_IDENTITY_UNAVAILABLE");
  }

  return {
    pid: targetPid,
    executablePath: canonPath,
    legacyDigest,
    processIdentity: identity,
  };
}

export async function planLegacyTrayRecycle(
  specificPid?: number
): Promise<LegacyTrayRecyclePlan> {
  const evidence = await captureLegacyTrayEvidence(specificPid);
  const target = trustedTrayBuild();

  return {
    service: "tray",
    action: "recycle",
    operationId: crypto.randomUUID(),
    expectedOwnerPid: evidence.pid,
    expectedProcessIdentity: evidence.processIdentity,
    expectedExecutablePath: evidence.executablePath,
    expectedLegacyDigest: evidence.legacyDigest,
    targetBuildDigest: target.digest,
    noCoreShutdown: true,
    note: "Guarded migration of legacy Tray desktop process into authenticated managed lifecycle. Re-verifies exact process birth identity, trusted executable path and digest. Sends native graceful close request and starts content-addressed managed Tray without restarting Core or MCP.",
  };
}

function assertPlan(plan: LegacyTrayRecyclePlan) {
  if (
    plan.service !== "tray" ||
    plan.action !== "recycle" ||
    !Number.isSafeInteger(plan.expectedOwnerPid) ||
    plan.expectedOwnerPid <= 0 ||
    !validIdentity(plan.expectedProcessIdentity) ||
    typeof plan.expectedExecutablePath !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.expectedLegacyDigest) ||
    !/^[a-f0-9]{64}$/.test(plan.targetBuildDigest) ||
    plan.noCoreShutdown !== true
  ) {
    throw new Error("TRAY_RECYCLE_INVALID_PLAN");
  }
  validateCoreOperationId(plan.operationId);
}

const ledgerPort = 45323; // Private journal namespace for tray recycle
function recycleFingerprint(plan: LegacyTrayRecyclePlan) {
  return sidecarOperationFingerprint({
    service: "tray",
    action: "recycle",
    expectedOwnerPid: plan.expectedOwnerPid,
    expectedProcessIdentity: plan.expectedProcessIdentity,
    expectedLegacyDigest: plan.expectedLegacyDigest,
    targetBuildDigest: plan.targetBuildDigest,
    noCoreShutdown: true,
  });
}

function requestNativeGracefulExit(pid: number): void {
  if (process.platform !== "win32") return;
  // Graceful Windows close request via CloseMainWindow and WM_CLOSE message
  const psScript = `
    $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
    if ($null -ne $p) {
      $closed = $p.CloseMainWindow()
      if (-not $closed) {
        Add-Type -TypeDefinition @"
          using System;
          using System.Runtime.InteropServices;
          public class Win32WindowCloser {
            [DllImport("user32.dll")]
            public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
            [DllImport("user32.dll")]
            public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
            [DllImport("user32.dll", SetLastError = true)]
            public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
            public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
            public static void ClosePidWindows(uint targetPid) {
              EnumWindows((hWnd, lParam) => {
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid == targetPid) {
                  PostMessage(hWnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
                }
                return true;
              }, IntPtr.Zero);
            }
          }
"@ -ErrorAction SilentlyContinue
        [Win32WindowCloser]::ClosePidWindows(${pid})
      }
    }
  `;
  try {
    execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", psScript],
      { timeout: 8000, windowsHide: true, stdio: "ignore" }
    );
  } catch {}
}

async function waitForPidExit(
  pid: number,
  expectedIdentity: string,
  timeoutMs = 15000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const identity = await readProcessStartIdentity(pid);
    if (identity === null) {
      return;
    }
    if (identity !== expectedIdentity) {
      throw new Error("TRAY_RECYCLE_PID_REUSED_ABORTED");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("TRAY_RECYCLE_USER_QUIT_REQUIRED: legacy Tray did not exit within timeout");
}

async function startManagedTrayBinary(executable: string) {
  const smoke =
    process.env.SUPERAGENT_TRAY_LIFECYCLE_TEST === "1" &&
    process.env.VITEST !== undefined;
  const child = spawn(
    executable,
    smoke ? ["--lifecycle-smoke"] : ["--background"],
    {
      cwd: path.dirname(executable),
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: {
        ...process.env,
        SUPERAGENT_TRAY_CHILD: "1",
        SUPERAGENT_TRAY_AUTOSTART: "0",
        ...(smoke ? { SUPERAGENT_TRAY_SMOKE_PARENT_PID: String(process.pid) } : {}),
      },
    }
  );
  child.on("error", () => {});
  child.unref();
  if (!child.pid) throw new Error("TRAY_RECYCLE_SPAWN_PID_MISSING");

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const record = readManagedTrayOwner();
    if (record) {
      if (record.pid !== child.pid) {
        throw new Error(
          "TRAY_RECYCLE_FOREIGN_OWNER: child did not own the new Tray"
        );
      }
      const inspect = await inspectManagedTray();
      if (inspect.verified && inspect.ownerPid === child.pid) {
        return { pid: child.pid, controlPort: record.controlPort };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "TRAY_RECYCLE_START_OUTCOME_UNCERTAIN: spawned PID " + child.pid
  );
}

export async function executeLegacyTrayRecycle(
  plan: LegacyTrayRecyclePlan,
  confirm: boolean
) {
  assertPlan(plan);
  if (confirm !== true) {
    throw new Error("TRAY_RECYCLE_EXPLICIT_CONFIRMATION_REQUIRED");
  }

  const prior = new ManagedSidecarLedger('tray', ledgerPort)
    .lookup(plan.operationId, recycleFingerprint(plan));
  if (prior?.replayed) {
    return {service:'tray' as const,action:'recycle' as const,changed:false,
      replayed:true,ownerPid:prior.afterPid??null};
  }

  // Pre-mutation revalidation
  const evidence = await captureLegacyTrayEvidence(plan.expectedOwnerPid);
  if (
    evidence.pid !== plan.expectedOwnerPid ||
    evidence.processIdentity !== plan.expectedProcessIdentity ||
    evidence.legacyDigest !== plan.expectedLegacyDigest
  ) {
    throw new Error("TRAY_RECYCLE_OWNER_CHANGED_SINCE_PLAN");
  }

  const target = trustedTrayBuild();
  if (target.digest !== plan.targetBuildDigest) {
    throw new Error("TRAY_RECYCLE_BUILD_CHANGED_SINCE_PLAN");
  }

  const ledger = new ManagedSidecarLedger("tray", ledgerPort);
  const signature = recycleFingerprint(plan);
  const replay = ledger.lookup(plan.operationId, signature);
  if (replay?.replayed) {
    return {
      service: "tray",
      action: "recycle",
      replayed: true,
      changed: false,
      ownerPid: replay.afterPid || null,
    };
  }

  const started = Date.now();
  ledger.begin(plan.operationId, signature);
  recordLifecycleEvent({
    at: started,
    service: "tray",
    action: "recycle",
    outcome: "planned",
    ownerPid: plan.expectedOwnerPid,
    operationHashPrefix: operationHashPrefix(plan.operationId),
    buildDigestPrefix: plan.targetBuildDigest.slice(0, 12),
  });

  try {
    // 1. Stage trusted release binary into immutable content-addressed store
    const stagedPath = stageTrustedTrayRelease(target.path, target.digest);

    // 2. Request graceful exit from the legacy process
    requestNativeGracefulExit(plan.expectedOwnerPid);

    // 3. Wait for legacy process disappearance
    await waitForPidExit(plan.expectedOwnerPid, plan.expectedProcessIdentity);

    // 4. Launch the staged managed Tray binary
    const created = await startManagedTrayBinary(stagedPath);
    ledger.complete(plan.operationId, created.pid);

    recordLifecycleEvent({
      at: Date.now(),
      service: "tray",
      action: "recycle",
      outcome: "succeeded",
      ownerPid: created.pid,
      operationHashPrefix: operationHashPrefix(plan.operationId),
      buildDigestPrefix: plan.targetBuildDigest.slice(0, 12),
      durationMs: Date.now() - started,
    });

    return {
      service: "tray",
      action: "recycle",
      changed: true,
      replayed: false,
      previousPid: plan.expectedOwnerPid,
      ownerPid: created.pid,
      controlPort: created.controlPort,
      coreUnaffected: true,
      note: "Legacy Tray gracefully exited and supervised managed Tray started.",
    };
  } catch (err) {
    try {
      recordLifecycleEvent({
        at: Date.now(),
        service: "tray",
        action: "recycle",
        outcome: "uncertain",
        operationHashPrefix: operationHashPrefix(plan.operationId),
        buildDigestPrefix: plan.targetBuildDigest.slice(0, 12),
        durationMs: Date.now() - started,
        errorCode:
          err instanceof Error
            ? err.message.match(/TRAY_RECYCLE_[A-Z0-9_]+/)?.[0] ??
              "TRAY_RECYCLE_FAILED"
            : "TRAY_RECYCLE_FAILED",
      });
    } catch {}
    throw err;
  }
}
