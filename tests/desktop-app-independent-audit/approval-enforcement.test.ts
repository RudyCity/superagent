import { describe, expect, it } from "vitest";
import { DesktopAppManager } from "../../src/core/desktopApp/service.js";
import { DesktopHumanApprovalManager } from "../../src/core/desktopSecurity/approval.js";
import type { DesktopPackageProvider, PackageChangePlan } from "../../src/core/desktopApp/types.js";

function makeHarness() {
  let mutations = 0;
  const approvals = new DesktopHumanApprovalManager();
  const provider: DesktopPackageProvider = {
    manager: "winget",
    async listInstalled() {
      return {
        packages: [{ id: "Example.App", name: "Example", version: "1.0.0", manager: "winget" as const }],
        truncated: false,
      };
    },
    async apply(plan: PackageChangePlan) {
      mutations += 1;
      return {
        manager: "winget" as const,
        packageId: plan.packageId,
        action: plan.action,
        applied: true as const,
        stepsCompleted: plan.steps.length,
      };
    },
  };
  const manager = new DesktopAppManager({
    platform: "win32",
    packageProvider: provider,
    approvalManager: approvals,
    hostApprovalPrompt: { confirm: async () => false },
  });
  return { manager, approvals, count: () => mutations };
}

describe("package changes require out-of-band, exact human consent", () => {
  it("cannot apply with a fabricated model approval flag", async () => {
    const { manager, count } = makeHarness();
    const plan = await manager.planPackageChange({
      principalId: "agent-a",
      packageAction: "install",
      packageId: "Example.App",
    });
    expect(plan.approvalRequired).toBe(true);
    await expect(manager.applyPackageChange({
      principalId: "agent-a",
      operationDigest: plan.operationDigest,
      approvalRequestId: plan.approvalRequestId,
      invocationId: plan.invocationId,
      approved: true,
    } as any)).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(count()).toBe(0);
  });

  it("binds approval to one principal, digest, and invocation, and consumes it once", async () => {
    const { manager, approvals, count } = makeHarness();
    const plan = await manager.planPackageChange({
      principalId: "agent-a",
      packageAction: "uninstall",
      packageId: "Example.App",
    });
    approvals.approveHostRequest({
      requestId: plan.approvalRequestId,
      operationDigest: plan.operationDigest,
      operatorId: "host-operator",
    });
    const fields = {
      operationDigest: plan.operationDigest,
      approvalRequestId: plan.approvalRequestId,
      invocationId: plan.invocationId,
    };
    await expect(manager.applyPackageChange({ ...fields, principalId: "agent-b" }))
      .rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(count()).toBe(0);
    const applied = await manager.applyPackageChange({ ...fields, principalId: "agent-a" });
    expect(applied.applied).toBe(true);
    expect(count()).toBe(1);
    await expect(manager.applyPackageChange({ ...fields, principalId: "agent-a" }))
      .rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(count()).toBe(1);
  });

  it("rejects shell strings and paths when planning packages", async () => {
    const { manager, count } = makeHarness();
    for (const value of [";powershell -enc ...", "C:/installer.exe", "../unsafe", "https://evil.example/pkg"]) {
      await expect(manager.planPackageChange({
        principalId: "agent-a",
        packageAction: "install",
        packageId: value,
      })).rejects.toMatchObject({ code: "INVALID_ACTION" });
    }
    expect(count()).toBe(0);
  });
});
