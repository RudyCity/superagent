import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = path.join(os.tmpdir(), "superagent-skill-tracker-" + process.pid);
vi.spyOn(os, "homedir").mockReturnValue(home);

import { getSkillStats, recordSkillExecution, recordSkillOutcome } from "../src/core/skills/skillTracker.js";

describe("skill invocation and effectiveness metrics", () => {
  beforeEach(() => fs.mkdirSync(home, { recursive: true }));
  afterEach(() => {
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  });

  it("keeps invocation counts separate from measured outcomes and duration", () => {
    const name = "phase-two-metric-fixture";
    recordSkillExecution(name);
    const invokedOnly = getSkillStats(path.join(home, "workspace")).find(item => item.name === name);
    expect(invokedOnly?.executionCount).toBe(1);
    expect(invokedOnly?.successfulRuns).toBe(0);
    expect(invokedOnly?.failedRuns).toBe(0);

    recordSkillOutcome(name, "succeeded", 42);
    recordSkillOutcome(name, "failed", 21);
    const measured = getSkillStats(path.join(home, "workspace")).find(item => item.name === name);
    expect(measured).toMatchObject({
      executionCount: 1,
      successfulRuns: 1,
      failedRuns: 1,
      totalDurationMs: 63,
      lastOutcome: "failed",
    });
  });
});
