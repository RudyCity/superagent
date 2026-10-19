import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkspaceId } from "../src/core/config/paths.js";

const home = path.join(os.tmpdir(), "superagent-skill-tracker-" + process.pid);
const workspaceA = path.join(home, "workspace-a");
const workspaceB = path.join(home, "workspace-b");
const configDir = path.join(home, ".superagent-r");
const originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;

import {
  getSkillStats,
  getSkillVersionId,
  recordSkillExecution,
  recordSkillOutcome,
  recordSkillFeedback,
  recordSkillValidation,
  compareSkillVersionEffectiveness,
} from "../src/core/skills/skillTracker.js";

describe("skill invocation and effectiveness metrics", () => {
  beforeEach(() => {
    process.env.SUPERAGENT_CONFIG_DIR = configDir;
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });
  });
  afterEach(() => {
    if (originalConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("keeps invocation counts separate from measured outcomes and duration", () => {
    const name = "phase-two-metric-fixture";
    const context = { workspace: workspaceA };
    recordSkillExecution(name, context);
    const invokedOnly = getSkillStats(workspaceA).find(item => item.name === name);
    expect(invokedOnly?.executionCount).toBe(1);
    expect(invokedOnly?.successfulRuns).toBe(0);
    expect(invokedOnly?.failedRuns).toBe(0);

    recordSkillOutcome(name, "succeeded", 42, context);
    recordSkillOutcome(name, "failed", 21, context);
    const measured = getSkillStats(workspaceA).find(item => item.name === name);
    expect(measured).toMatchObject({
      executionCount: 1,
      successfulRuns: 1,
      failedRuns: 1,
      totalDurationMs: 63,
      lastOutcome: "failed",
    });
  });

  it("separates metrics by exact immutable skill version and tracks validations, retries and feedback", () => {
    const name = "phase-two-versioned-metric-fixture";
    const contentA = "# workflow A";
    const contentB = "# workflow B";
    const versionA = getSkillVersionId(contentA);
    const versionB = getSkillVersionId(contentB);
    expect(versionA).toMatch(/^[a-f0-9]{12}$/);
    expect(versionA).not.toBe(versionB);

    const contextA = { workspace: workspaceA, version: versionA, provider: "openrouter", model: "test-model", executionMode: "single" as const, taskId: "task-a", retryCount: 2 };
    recordSkillExecution(name, contextA);
    recordSkillOutcome(name, "succeeded", 100, contextA);
    recordSkillValidation(name, versionA, true, contextA);
    recordSkillFeedback(name, "positive", "The workflow worked as expected.", contextA);

    const contextB = { workspace: workspaceA, version: versionB, provider: "agy", executionMode: "multi" as const, taskId: "task-b" };
    recordSkillExecution(name, contextB);
    recordSkillOutcome(name, "failed", 300, contextB);
    recordSkillValidation(name, versionB, false, contextB);
    recordSkillFeedback(name, "negative", "Failed on the second step.", contextB);
    recordSkillFeedback(name, "neutral", "Needs more verification.", contextB);

    const stats = getSkillStats(workspaceA).find(item => item.name === name)!;
    expect(stats.executionCount).toBe(2);
    expect(stats.successfulRuns).toBe(1);
    expect(stats.failedRuns).toBe(1);
    expect(stats.versionMetrics).toHaveLength(2);
    expect(stats.versionMetrics?.find(item => item.version === versionA)).toMatchObject({
      executionCount: 1, successfulRuns: 1, failedRuns: 0, totalDurationMs: 100,
      retryCount: 2, validationRuns: 1, validationPassed: 1, validationFailed: 0,
      positiveFeedback: 1, negativeFeedback: 0, neutralFeedback: 0,
      lastProvider: "openrouter", lastModel: "test-model", lastExecutionMode: "single",
      taskIds: ["task-a"],
    });
    expect(stats.versionMetrics?.find(item => item.version === versionB)).toMatchObject({
      executionCount: 1, successfulRuns: 0, failedRuns: 1, totalDurationMs: 300,
      retryCount: 0, validationRuns: 1, validationPassed: 0, validationFailed: 1,
      positiveFeedback: 0, negativeFeedback: 1, neutralFeedback: 1,
      lastProvider: "agy", lastExecutionMode: "multi", taskIds: ["task-b"],
    });
  });

  it("isolates identically named skills across separate workspaces", () => {
    const name = "same-skill-name-different-project";
    const version = getSkillVersionId("# same content");
    recordSkillExecution(name, { version, workspace: workspaceA });
    recordSkillOutcome(name, "succeeded", 25, { version, workspace: workspaceA });
    recordSkillExecution(name, { version, workspace: workspaceB });
    recordSkillOutcome(name, "failed", 90, { version, workspace: workspaceB });

    expect(getSkillStats(workspaceA).find(item => item.name === name)).toMatchObject({
      executionCount: 1, successfulRuns: 1, failedRuns: 0, totalDurationMs: 25,
    });
    expect(getSkillStats(workspaceB).find(item => item.name === name)).toMatchObject({
      executionCount: 1, successfulRuns: 0, failedRuns: 1, totalDurationMs: 90,
    });
  });

  it("only reports version regressions when both versions have enough completed-run evidence", () => {
    const name = "phase-two-version-comparison-fixture";
    const versionA = "aaaaaaaaaaaa";
    const versionB = "bbbbbbbbbbbb";

    for (let index = 0; index < 4; index++) {
      const contextA = { workspace: workspaceA, version: versionA, taskId: "baseline-" + index, retryCount: 0 };
      const contextB = { workspace: workspaceA, version: versionB, taskId: "candidate-" + index, retryCount: 2 };
      recordSkillExecution(name, contextA);
      recordSkillOutcome(name, index < 3 ? "succeeded" : "failed", 100, contextA);
      recordSkillValidation(name, versionA, true, contextA);
      recordSkillExecution(name, contextB);
      recordSkillOutcome(name, "failed", 150, contextB);
      recordSkillValidation(name, versionB, false, contextB);
    }

    const comparison = compareSkillVersionEffectiveness(name, versionA, versionB, workspaceA);
    expect(comparison.confidence).toBe("comparable");
    expect(comparison.versionA?.completedRuns).toBe(4);
    expect(comparison.versionB?.completedRuns).toBe(4);
    expect(comparison.versionA?.successRate).toBe(0.75);
    expect(comparison.versionB?.successRate).toBe(0);
    expect(comparison.regressions).toContain("Success rate fell by at least 20 percentage points.");
    expect(comparison.regressions).toContain("Independent validation pass rate fell by at least 15 percentage points.");
    expect(comparison.regressions).toContain("Retries per invocation increased by at least 0.5 without a success-rate improvement.");

    const insufficient = compareSkillVersionEffectiveness(name, versionA, "cccccccccccc", workspaceA);
    expect(insufficient.confidence).toBe("insufficient-data");
  });

  it("redacts token-like strings and bounds saved feedback", () => {
    const version = getSkillVersionId("sensitive-fixture");
    recordSkillFeedback(
      "feedback-redaction-fixture",
      "negative",
      "API key: ghp_12345678901234567890 please fix this",
      { version, workspace: workspaceA },
    );
    const statsPath = path.join(configDir, "workspaces", getWorkspaceId(workspaceA), "skill-stats.json");
    const saved = fs.readFileSync(statsPath, "utf8");
    expect(saved).toContain("[REDACTED]");
    expect(saved).not.toContain("ghp_12345678901234567890");
  });
});
