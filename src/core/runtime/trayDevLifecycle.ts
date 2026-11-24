import {
  executeManagedTray,
  legacyTrayProcessPids,
  planManagedTray,
  readManagedTrayOwner,
} from "./managedTrayControl.js";

type TrayStopPlan = Awaited<ReturnType<typeof planManagedTray>>;
type TrayStopResult = Awaited<ReturnType<typeof executeManagedTray>>;

export type TrayDevLifecycleDependencies = {
  platform: NodeJS.Platform;
  readOwner: typeof readManagedTrayOwner;
  findLegacyPids: typeof legacyTrayProcessPids;
  planStop: () => Promise<TrayStopPlan>;
  executeStop: (plan: TrayStopPlan & { confirm: true }) => Promise<TrayStopResult>;
};

const defaultDependencies: TrayDevLifecycleDependencies = {
  platform: process.platform,
  readOwner: readManagedTrayOwner,
  findLegacyPids: legacyTrayProcessPids,
  planStop: () => planManagedTray("stop"),
  executeStop: plan => executeManagedTray(plan),
};

/**
 * Stop only the authenticated, managed Tray owner before starting Tauri dev.
 * Unverified/legacy instances are never killed; they block startup instead.
 */
export async function stopRunningTrayBeforeDev(
  dependencies: TrayDevLifecycleDependencies = defaultDependencies,
): Promise<{ stopped: boolean; skipped: boolean; pid?: number }> {
  if (dependencies.platform !== "win32") {
    return { stopped: false, skipped: true };
  }

  const owner = dependencies.readOwner();
  const assertNoForeignTray = (pids: number[]) => {
    if (pids.length > 0) {
      throw new Error(
        "TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT: refusing to terminate unverified Tray PID(s) " +
          pids.join(", ") +
          ". Close those instances from their own Quit menu, then retry.",
      );
    }
  };

  assertNoForeignTray(dependencies.findLegacyPids(owner?.pid ?? null));
  if (!owner) {
    return { stopped: false, skipped: false };
  }

  const plan = await dependencies.planStop();
  if (
    plan.action !== "stop" ||
    plan.expectedOwnerPid !== owner.pid ||
    plan.expectedInstanceId !== owner.instanceId
  ) {
    throw new Error("TRAY_OWNER_CHANGED_BEFORE_DEV_STOP: refusing to stop a different instance");
  }

  // Re-scan immediately before the authenticated stop to catch a second,
  // unowned instance appearing after the initial preflight.
  assertNoForeignTray(dependencies.findLegacyPids(owner.pid));

  const result = await dependencies.executeStop({ ...plan, confirm: true });
  if (
    result.action !== "stop" ||
    result.changed !== true ||
    result.ownerPid !== null ||
    !("coreUnaffected" in result) ||
    result.coreUnaffected !== true
  ) {
    throw new Error("TRAY_DEV_STOP_NOT_VERIFIED: refusing to launch a second Tray instance");
  }

  return { stopped: true, skipped: false, pid: owner.pid };
}
