import { describe, expect, it, vi } from "vitest";
import { DesktopHumanApprovalManager } from "../../src/core/desktopSecurity/approval.js";
import { inspectSecurityPrompts } from "../../src/core/desktopSecurity/prompts.js";
import type { DesktopProcessRunner, SafeProcessRequest } from "../../src/core/desktopUi/processRunner.js";

describe("desktop security approvals", () => {
  it("requires host approval of the exact digest and never accepts an approval boolean", () => {
    const approvals = new DesktopHumanApprovalManager();
    const request = approvals.createRequest({
      operationDigest: "a".repeat(64),
      principalId: "principal-a",
      target: "winget:Git.Git:install",
    });

    expect(() => approvals.consumeApprovedRequest({
      requestId: request.requestId,
      invocationId: request.invocationId,
      operationDigest: request.operationDigest,
      principalId: request.principalId,
      target: request.target,
    })).toThrow(/separate host-operator approval/);

    expect(() => approvals.approveHostRequest({
      requestId: request.requestId,
      operationDigest: "b".repeat(64),
      operatorId: "human-console",
    })).toThrow(/digest/);

    approvals.approveHostRequest({
      requestId: request.requestId,
      operationDigest: request.operationDigest,
      operatorId: "human-console",
    });
    expect(approvals.consumeApprovedRequest({
      requestId: request.requestId,
      invocationId: request.invocationId,
      operationDigest: request.operationDigest,
      principalId: request.principalId,
      target: request.target,
    }).approvedBy).toBe("human-console");
  });

  it("reports Windows UAC evidence read-only without inspecting or clicking secure-desktop contents", async () => {
    let request: SafeProcessRequest | undefined;
    const runner: DesktopProcessRunner = {
      run: vi.fn(async (value) => {
        request = value;
        return {
          stdout: JSON.stringify({
            observations: [{
              kind: "uac",
              detected: true,
              humanApprovalRequired: true,
              processId: 123,
              publisher: "CN=Microsoft Windows",
              target: null,
              scope: "Windows secure desktop consent process",
            }],
          }),
          stderr: "",
          exitCode: 0,
        };
      }),
    };

    const report = await inspectSecurityPrompts({ platform: "win32", runner });
    expect(report.supported).toBe(true);
    expect(report.observations[0]).toMatchObject({
      kind: "uac",
      detected: true,
      humanApprovalRequired: true,
      processId: 123,
    });
    expect(report.limitations.join(" ")).toMatch(/cannot be read or clicked/i);
    expect(report.limitations.join(" ")).toMatch(/firewall.*never auto-approved/i);
    expect(request?.executable.toLowerCase()).toMatch(/powershell\.exe$/);
    expect(request?.args.join(" ")).not.toMatch(/UIAutomation|GetWindowText|SendInput|PostMessage/i);
  });

  it("states macOS and Linux prompt detection limitations instead of claiming universal support", async () => {
    const runner: DesktopProcessRunner = {
      run: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    };
    const mac = await inspectSecurityPrompts({ platform: "darwin", runner });
    const linux = await inspectSecurityPrompts({ platform: "linux", runner });

    expect(mac).toMatchObject({ platform: "darwin", supported: false, observations: [] });
    expect(mac.limitations.join(" ")).toMatch(/never submits administrator credentials/i);
    expect(linux).toMatchObject({ platform: "linux", supported: false, observations: [] });
    expect(linux.limitations.join(" ")).toMatch(/sudo\/pkexec/i);
    expect(runner.run).not.toHaveBeenCalled();
  });
});
