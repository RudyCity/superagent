import { describe, expect, it } from "vitest";
import { classifyDelegationReport, delegationReportFailed } from "../src/core/tools/delegationOutcome.js";

describe("Phase 4: delegated report outcome classification", () => {
  it.each([
    ["### SUPERAGENT TASK REPORT\n- Status: Completed\n- Tests: passed", "completed"],
    ["### SUBAGENT TASK REPORT\n- **Status**: blocked\n- **Verification**: ❌ failed", "blocked"],
    ["- Status: Partial\n- Tests: passed", "partial"],
    ["Status: Cancelled", "cancelled"],
    ["Status: Error", "failed"],
    ["Status: completed\nVerification: false", "failed"],
    ["Status: completed\nTests: failed", "failed"],
    ["### Report\nWe researched the case.", "unverified"],
    ["", "unverified"],
  ])("classifies %j as %s", (report, expected) => {
    expect(classifyDelegationReport(report)).toBe(expected);
  });

  it("never treats blocked, partial, failed, or cancelled reports as successful", () => {
    for (const value of ["blocked", "partial", "failed", "cancelled"] as const) {
      expect(delegationReportFailed(value)).toBe(true);
    }
    expect(delegationReportFailed("completed")).toBe(false);
    expect(delegationReportFailed("unverified")).toBe(false);
  });
});
