import { describe, expect, it } from "vitest";
import { inferSelectiveApproval, observeSelectiveApproval } from "../src/core/senopatiV2ApprovalSelective.js";

describe("Senopati V2 experimental selective approval", () => {
  it.each([
    ["silakan dilanjutkan", "PLANNING_PENDING", "affirm"],
    ["yes, approve", "PLANNING_PENDING", "affirm"],
    ["saya setujui rencana ini", "PLANNING_PENDING", "affirm"],
    ["saya menolak rencana yang diajukan", "PLANNING_PENDING", "deny"],
    ["approve after the deployment window", "PLANNING_PENDING", "conditional"],
    ["sure, but not now", "PLANNING_PENDING", "conditional"],
    ["Approved—only after backup", "PLANNING_PENDING", "conditional"],
    ["yes?", "PLANNING_PENDING", "none"],
    ["approved?", "PLANNING_PENDING", "none"],
    ["I approve this plan?", "PLANNING_PENDING", "none"],
    ["please approve this plan", "PLANNING_PENDING", "none"],
    ["yes", "IDLE", "none"],
    ["silakan dilanjutkan", "IDLE", "none"]
  ])("labels '%s' in %s as %s", (text, context, label) => {
    expect(inferSelectiveApproval(text, context)).toBe(label);
  });

  it("never grants execution authority even for explicit affirmative text", () => {
    const result = observeSelectiveApproval("yes, approve", "PLANNING_PENDING");
    expect(result.label).toBe("affirm");
    expect(result.authorizesExecution).toBe(false);
    expect(result.requiresIndependentToolAuthorization).toBe(true);
    expect(result.confidenceCalibrated).toBe(false);
  });
});
