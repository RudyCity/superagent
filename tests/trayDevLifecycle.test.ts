import { describe, expect, it, vi } from "vitest";
import {
  stopRunningTrayBeforeDev,
  type TrayDevLifecycleDependencies,
} from "../src/core/runtime/trayDevLifecycle.js";

const owner = {
  version: 1 as const,
  pid: 4180,
  instanceId: "a".repeat(32),
  token: "b".repeat(64),
  controlPort: 45321,
  executablePath: "C:\\Users\\tester\\.superagent-r\\bin\\superagent-tray.exe",
};

const stopPlan = {
  service: "tray" as const,
  action: "stop" as const,
  operationId: "c".repeat(36),
  expectedOwnerPid: owner.pid,
  expectedInstanceId: owner.instanceId,
  expectedBuildDigest: "d".repeat(64),
  port: owner.controlPort,
  noCoreShutdown: true as const,
  note: "verified test plan",
};

const stoppedResult = {
  service: "tray",
  action: "stop",
  changed: true,
  replayed: false,
  previousPid: owner.pid,
  ownerPid: null,
  coreUnaffected: true as const,
};

function dependencies(
  overrides: Partial<TrayDevLifecycleDependencies> = {},
): TrayDevLifecycleDependencies {
  return {
    platform: "win32",
    readOwner: vi.fn(() => owner),
    findLegacyPids: vi.fn(() => []),
    planStop: vi.fn(async () => stopPlan),
    executeStop: vi.fn(async () => stoppedResult),
    ...overrides,
  } as TrayDevLifecycleDependencies;
}

describe("tray:dev existing Tray lifecycle", () => {
  it("gracefully stops only the authenticated managed Tray owner", async () => {
    const deps = dependencies();

    await expect(stopRunningTrayBeforeDev(deps)).resolves.toEqual({
      stopped: true,
      skipped: false,
      pid: owner.pid,
    });
    expect(deps.findLegacyPids).toHaveBeenNthCalledWith(1, owner.pid);
    expect(deps.findLegacyPids).toHaveBeenNthCalledWith(2, owner.pid);
    expect(deps.planStop).toHaveBeenCalledOnce();
    expect(deps.executeStop).toHaveBeenCalledWith({
      ...stopPlan,
      confirm: true,
    });
  });

  it("continues when no managed or legacy Tray process is running", async () => {
    const deps = dependencies({
      readOwner: vi.fn(() => null),
    });

    await expect(stopRunningTrayBeforeDev(deps)).resolves.toEqual({
      stopped: false,
      skipped: false,
    });
    expect(deps.findLegacyPids).toHaveBeenCalledWith(null);
    expect(deps.planStop).not.toHaveBeenCalled();
    expect(deps.executeStop).not.toHaveBeenCalled();
  });

  it("blocks startup when an unverified Tray process exists", async () => {
    const deps = dependencies({
      findLegacyPids: vi.fn(() => [9021]),
    });

    await expect(stopRunningTrayBeforeDev(deps)).rejects.toThrow(
      "TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT",
    );
    expect(deps.planStop).not.toHaveBeenCalled();
    expect(deps.executeStop).not.toHaveBeenCalled();
  });

  it("rechecks for foreign Tray processes after preparing the owner-bound plan", async () => {
    const deps = dependencies({
      findLegacyPids: vi.fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([9021]),
    });

    await expect(stopRunningTrayBeforeDev(deps)).rejects.toThrow(
      "TRAY_LEGACY_PROCESS_REQUIRES_USER_QUIT",
    );
    expect(deps.planStop).toHaveBeenCalledOnce();
    expect(deps.executeStop).not.toHaveBeenCalled();
  });

  it("blocks if the owner changes between inspection and stop planning", async () => {
    const deps = dependencies({
      planStop: vi.fn(async () => ({
        ...stopPlan,
        expectedOwnerPid: owner.pid + 1,
      })),
    });

    await expect(stopRunningTrayBeforeDev(deps)).rejects.toThrow(
      "TRAY_OWNER_CHANGED_BEFORE_DEV_STOP",
    );
    expect(deps.executeStop).not.toHaveBeenCalled();
  });

  it("blocks when the native stop receipt does not prove Tray-only shutdown", async () => {
    const deps = dependencies({
      executeStop: vi.fn(async () => ({
        ...stoppedResult,
        coreUnaffected: false as never,
      })),
    });

    await expect(stopRunningTrayBeforeDev(deps)).rejects.toThrow(
      "TRAY_DEV_STOP_NOT_VERIFIED",
    );
  });

  it("does not run Windows process discovery on other platforms", async () => {
    const deps = dependencies({
      platform: "linux",
    });

    await expect(stopRunningTrayBeforeDev(deps)).resolves.toEqual({
      stopped: false,
      skipped: true,
    });
    expect(deps.readOwner).not.toHaveBeenCalled();
    expect(deps.findLegacyPids).not.toHaveBeenCalled();
  });
});
