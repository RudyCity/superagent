import { describe, expect, it, vi } from "vitest";
import { DesktopAppManager } from "../../src/core/desktopApp/service.js";
import type {
  DesktopAppLifecycleProvider,
  DesktopPackageProvider,
  PackageChangePlan,
} from "../../src/core/desktopApp/types.js";
import { DesktopHumanApprovalManager } from "../../src/core/desktopSecurity/approval.js";
import { DesktopUiError } from "../../src/core/desktopUi/errors.js";

function appProvider(overrides: Partial<DesktopAppLifecycleProvider> = {}): DesktopAppLifecycleProvider {
  return {
    listApplications: vi.fn(async () => ({ applications: [], truncated: false })),
    launchVerified: vi.fn(async (appId) => ({ launched: true as const, appId })),
    focusExact: vi.fn(async () => ({ focused: true as const })),
    closeExact: vi.fn(async () => ({ closeRequested: true as const })),
    waitUntilClosed: vi.fn(async () => true),
    ...overrides,
  };
}

function packageProvider(): DesktopPackageProvider {
  return {
    manager: "winget",
    listInstalled: vi.fn(async () => ({
      packages: [{ id: "Git.Git", name: "Git", version: "2.51.0", manager: "winget" as const }],
      truncated: false,
    })),
    apply: vi.fn(async (plan: PackageChangePlan) => ({
      manager: "winget" as const,
      packageId: plan.packageId,
      action: plan.action,
      applied: true as const,
      stepsCompleted: plan.steps.length,
    })),
  };
}

describe("DesktopAppManager security", () => {
  it("requires exact host consent for focus/close/restart and never force-kills on failed graceful close", async () => {
    const provider = appProvider({ waitUntilClosed: vi.fn(async () => false) });
    const denied = new DesktopAppManager({
      platform: "win32",
      appProvider: provider,
      packageProvider: packageProvider(),
      consentVerifier: () => false,
    });
    await expect(denied.closeApp({ pid: 10, nativeId: "20" })).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(provider.closeExact).not.toHaveBeenCalled();

    const allowed = new DesktopAppManager({
      platform: "win32",
      appProvider: provider,
      packageProvider: packageProvider(),
      consentVerifier: (target) => target.pid === 10 && target.nativeId === "20",
    });
    await expect(allowed.restartApp("Contoso.App_abc!App", { pid: 10, nativeId: "20" })).rejects.toThrow(
      /Graceful close did not complete/,
    );
    expect(provider.closeExact).toHaveBeenCalledTimes(1);
    expect(provider.launchVerified).not.toHaveBeenCalled();
  });

  it("binds package approval to digest, principal, target and invocation and consumes it once", async () => {
    const approvals = new DesktopHumanApprovalManager();
    const packages = packageProvider();
    const manager = new DesktopAppManager({
      platform: "win32",
      appProvider: appProvider(),
      packageProvider: packages,
      approvalManager: approvals,
      hostApprovalPrompt: { confirm: vi.fn(async () => false) },
    });

    const planned = await manager.planPackageChange({
      principalId: "principal-a",
      packageAction: "reinstall",
      packageId: "Git.Git",
    });
    expect(planned.plan.destructive).toBe(true);
    expect(planned.plan.steps.map((step) => step.operation)).toEqual(["uninstall", "install"]);
    expect(planned.operationDigest).toMatch(/^[a-f0-9]{64}$/);

    await expect(manager.applyPackageChange({
      principalId: "principal-a",
      approvalRequestId: planned.approvalRequestId,
      operationDigest: planned.operationDigest,
      invocationId: planned.invocationId,
    })).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(packages.apply).not.toHaveBeenCalled();

    const rePlanned = await manager.planPackageChange({
      principalId: "principal-a", packageAction: "reinstall", packageId: "Git.Git",
    });
    approvals.approveHostRequest({
      requestId: rePlanned.approvalRequestId,
      operationDigest: rePlanned.operationDigest,
      operatorId: "human-console",
    });
    await expect(manager.applyPackageChange({
      principalId: "principal-b",
      approvalRequestId: rePlanned.approvalRequestId,
      operationDigest: rePlanned.operationDigest,
      invocationId: rePlanned.invocationId,
    })).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(packages.apply).not.toHaveBeenCalled();

    await expect(manager.applyPackageChange({
      principalId: "principal-a",
      approvalRequestId: rePlanned.approvalRequestId,
      operationDigest: rePlanned.operationDigest,
      invocationId: rePlanned.invocationId,
    })).resolves.toMatchObject({ applied: true, stepsCompleted: 2 });
    expect(packages.apply).toHaveBeenCalledTimes(1);

    await expect(manager.applyPackageChange({
      principalId: "principal-a",
      approvalRequestId: rePlanned.approvalRequestId,
      operationDigest: rePlanned.operationDigest,
      invocationId: rePlanned.invocationId,
    })).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });

  it("keeps Windows app discovery useful while strict-offline package inventory fails closed", async () => {
    const applications = appProvider({
      listApplications: vi.fn(async () => ({
        applications: [{
          id: "Contoso.App_abc!App",
          name: "Contoso",
          platform: "win32" as const,
          launchKind: "windows-apps-folder" as const,
        }],
        truncated: false,
      })),
    });
    const offlinePackages: DesktopPackageProvider = {
      manager: "winget",
      listInstalled: vi.fn(async () => {
        throw new DesktopUiError("DEPENDENCY_REQUIRED", "strict offline");
      }),
      apply: vi.fn(async (plan) => ({
        manager: "winget",
        packageId: plan.packageId,
        action: plan.action,
        applied: true as const,
        stepsCompleted: plan.steps.length,
      })),
    };
    const manager = new DesktopAppManager({
      platform: "win32",
      appProvider: applications,
      packageProvider: offlinePackages,
      approvalManager: new DesktopHumanApprovalManager(),
    });

    const inventory = await manager.listInstalledApps(10);
    expect(inventory.applications.map((app) => app.id)).toEqual(["Contoso.App_abc!App"]);
    expect(inventory.packages).toEqual([]);
    expect(inventory.limitations.join(" ")).toMatch(/strict-offline/i);

    const plan = await manager.planPackageChange({
      principalId: "principal-a",
      packageAction: "uninstall",
      packageId: "Git.Git",
    });
    expect(plan.plan.currentVersion).toBeUndefined();
    expect(plan.plan.sideEffects.join(" ")).toMatch(/could not verify/i);
    expect(offlinePackages.apply).not.toHaveBeenCalled();
  });

  it("rejects package command/path injection and does not pretend app lifecycle exists on unsupported platforms", async () => {
    const packages = packageProvider();
    const manager = new DesktopAppManager({
      platform: "darwin",
      packageProvider: packages,
    });

    await expect(manager.planPackageChange({
      principalId: "principal-a",
      packageAction: "install",
      packageId: "Git.Git;rm",
    })).rejects.toMatchObject({ code: "INVALID_ACTION" });
    expect(packages.apply).not.toHaveBeenCalled();

    await expect(manager.launchApp("com.example.App")).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
  });
});
