import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { classifyRequest, classifyWithSenopatiONNX } from "../src/core/requestClassifier.js";
import { RequestProcessor } from "../src/core/agent/RequestProcessor.js";
import { Agent } from "../src/core/agent.js";
import { resolveExistingPlanPath } from "../src/components/plan-approval-dialog.js";

describe("Plan State and Destructive Classifier Guards", () => {
  it("does not flag benign questions or pricing queries as destructive", async () => {
    const res = await classifyRequest("an gglm 5.2 itu beneran free?");
    expect(res.isDestructive).toBe(false);
  });

  it("does flag actual destructive action words as destructive", async () => {
    const res = await classifyRequest("tolong hapus semua file konfigurasi");
    expect(res.isDestructive).toBe(true);
  });

  it("does not set agent.planState to PLANNING_PENDING in RequestProcessor when no plan file exists", async () => {
    const onEvent = vi.fn();
    const onPermission = vi.fn().mockResolvedValue(true);
    const onQuestion = vi.fn();

    const agent = new Agent(onEvent, onPermission, onQuestion);
    agent.tier = "single";
    agent.planState = "IDLE";

    // Ensure no plan file exists
    expect(agent.hasRealPlanContent()).toBe(false);

    // Process a user request that might have destructive flag
    await RequestProcessor.processRequest(agent, "an gglm 5.2 itu beneran free?");

    // planState must remain IDLE because no plan file was written!
    expect(agent.planState).toBe("IDLE");
  });

  it("hasRealPlanContent returns false when file is missing and true when valid plan is present", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-guard-test-"));
    try {
      const agent = new Agent(vi.fn(), vi.fn(), vi.fn());
      agent.workingDirectory = tmpDir;

      expect(agent.hasRealPlanContent()).toBe(false);

      const planPath = path.join(tmpDir, "implementation_plan.md");
      fs.writeFileSync(
        planPath,
        "# Test Implementation Plan\n\n## Proposed Changes\n- [ ] Task 1\n\n## Verification Plan\n### Automated Tests\n- npm test\n### Manual Verification\n- check\n",
        "utf-8"
      );

      expect(agent.hasRealPlanContent()).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolveExistingPlanPath correctly resolves existing files and fallbacks", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-plan-test-"));
    try {
      const nonexistent = path.join(tmpDir, "sess_123_implementation_plan.md");
      expect(resolveExistingPlanPath(nonexistent)).toBe(null);

      const realPlan = path.join(tmpDir, "sess_456_implementation_plan.md");
      fs.writeFileSync(realPlan, "# Plan", "utf-8");

      expect(resolveExistingPlanPath(realPlan)).toBe(realPlan);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
