import { describe, expect, it, vi } from "vitest";
import { DesktopAppManager } from "../../src/core/desktopApp/service.js";
import { DesktopHumanApprovalManager } from "../../src/core/desktopSecurity/approval.js";
import { createHostPackageApprovalPrompt } from "../../src/core/desktopSecurity/hostApproval.js";
import type { DesktopProcessRunner } from "../../src/core/desktopUi/processRunner.js";
import type { DesktopPackageProvider, PackageChangePlan } from "../../src/core/desktopApp/types.js";

const digest = "c".repeat(64);
const plan: PackageChangePlan = {
  action: "reinstall",
  manager: "winget",
  packageId: "Example.Package",
  source: "winget",
  currentVersion: "1.0",
  destructive: true,
  steps: [
    { manager: "winget", packageId: "Example.Package", operation: "uninstall" },
    { manager: "winget", packageId: "Example.Package", operation: "install" },
  ],
  sideEffects: ["The package may remain absent if reinstall fails."],
};
const presentation = {
  principalId: "test-principal", operationDigest: digest,
  expiresAt: Date.now() + 120_000, plan,
};

describe("host-native package approval", () => {
  it("shows plan details and defaults to Deny on Windows", async () => {
    const calls: any[] = [];
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (input) => {
        calls.push(input);
        return { stdout: '{"approved":true}', stderr: "", exitCode: 0 };
      }),
    };
    const prompt = createHostPackageApprovalPrompt({ platform: "win32", runner });
    expect(await prompt.confirm(presentation)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].executable.toLowerCase()).toContain("powershell.exe");
    const script = Buffer.from(calls[0].args.at(-1), "base64").toString("utf16le");
    expect(script).toContain("MessageBoxDefaultButton]::Button2");
    expect(script).toContain("MessageBoxButtons]::YesNo");
    expect(calls[0].env.SUPERAGENT_PACKAGE_APPROVAL_PAYLOAD).toContain(digest);
    expect(calls[0].env.SUPERAGENT_PACKAGE_APPROVAL_PAYLOAD).toContain("reinstall");
  });

  it("fail-closes denied/failed/expired approvals without trying package commands", async () => {
    const runner: DesktopProcessRunner = {
      run: vi.fn(async () => ({ stdout: '{"approved":false}', stderr: "", exitCode: 0 })),
    };
    const prompt = createHostPackageApprovalPrompt({ platform: "win32", runner });
    expect(await prompt.confirm(presentation)).toBe(false);
    await expect(prompt.confirm({ ...presentation, expiresAt: Date.now() - 1 }))
      .rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("approves exact plan only through injected host UI and consumes authorization once", async () => {
    const approvals = new DesktopHumanApprovalManager();
    let applied = 0;
    const packages: DesktopPackageProvider = {
      manager: "winget",
      listInstalled: async () => ({ packages: [], truncated: false }),
      apply: vi.fn(async (operation) => {
        applied++;
        return {
          manager: "winget", packageId: operation.packageId, action: operation.action,
          applied: true as const, stepsCompleted: operation.steps.length,
        };
      }),
    };
    const hostConfirm = vi.fn(async () => true);
    const manager = new DesktopAppManager({
      platform: "win32", packageProvider: packages, approvalManager: approvals,
      hostApprovalPrompt: { confirm: hostConfirm },
    });
    const approval = await manager.planPackageChange({
      principalId: "test-principal", packageAction: "install", packageId: "Example.Package",
    });
    const request = {
      principalId: "test-principal", operationDigest: approval.operationDigest,
      approvalRequestId: approval.approvalRequestId, invocationId: approval.invocationId,
    };
    await expect(manager.applyPackageChange({ ...request, principalId: "wrong-principal" }))
      .rejects.toMatchObject({ code: "INPUT_DISABLED" });
    expect(hostConfirm).not.toHaveBeenCalled();
    await expect(manager.applyPackageChange(request)).resolves.toMatchObject({ applied: true });
    expect(hostConfirm).toHaveBeenCalledTimes(1);
    expect(hostConfirm.mock.calls[0][0]).toMatchObject({ principalId: "test-principal", operationDigest: approval.operationDigest });
    expect(applied).toBe(1);
    await expect(manager.applyPackageChange(request)).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(applied).toBe(1);
  });

  it("denial invalidates a package plan and cannot be replayed to spam the operator", async () => {
    const confirmations = vi.fn(async () => false);
    const provider: DesktopPackageProvider = {
      manager: "winget",
      listInstalled: async () => ({ packages: [], truncated: false }),
      apply: vi.fn(async () => { throw new Error("Should not be called"); }),
    };
    const manager = new DesktopAppManager({
      platform: "win32", packageProvider: provider,
      approvalManager: new DesktopHumanApprovalManager(),
      hostApprovalPrompt: { confirm: confirmations },
    });
    const p = await manager.planPackageChange({
      principalId: "requester", packageAction: "install", packageId: "Example.Package",
    });
    const input = {
      principalId: "requester", operationDigest: p.operationDigest,
      approvalRequestId: p.approvalRequestId, invocationId: p.invocationId,
    };
    await expect(manager.applyPackageChange(input)).rejects.toMatchObject({ code: "INPUT_DISABLED" });
    await expect(manager.applyPackageChange(input)).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(confirmations).toHaveBeenCalledTimes(1);
    expect(provider.apply).not.toHaveBeenCalled();
  });

  it("uses OS-native dialogs with fixed executables on macOS and Linux", async () => {
    const calls: any[] = [];
    const macRunner: DesktopProcessRunner = {
      run: vi.fn(async (input) => {
        calls.push(input);
        return { stdout: '{"approved":true}', stderr: "", exitCode: 0 };
      }),
    };
    const mac = createHostPackageApprovalPrompt({ platform: "darwin", runner: macRunner });
    expect(await mac.confirm(presentation)).toBe(true);
    expect(calls[0].executable).toBe("/usr/bin/osascript");
    expect(calls[0].args).toContain("JavaScript");
    expect(calls[0].env.SUPERAGENT_PACKAGE_APPROVAL_MESSAGE).toContain("Example.Package");

    const linuxRunner: DesktopProcessRunner = {
      run: vi.fn(async (input) => {
        calls.push(input);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    };
    const linux = createHostPackageApprovalPrompt({ platform: "linux", runner: linuxRunner });
    expect(await linux.confirm(presentation)).toBe(true);
    expect(calls[1].executable).toBe("/usr/bin/zenity");
    expect(calls[1].args).toContain("--cancel-label=Deny");
    expect(calls[1].args).toContain("--ok-label=Approve");
  });
});
