import { afterEach, describe, expect, it } from "vitest";
import { awaitSuperagentsTool } from "../src/core/tools/superagentTools.js";
import { superagentInstances } from "../src/core/tools/state.js";
import type { SuperagentInstance } from "../src/core/tools/types.js";

function agent(id: string, role: string, status: SuperagentInstance["status"], report: string): SuperagentInstance {
  return {
    id, role, task: "Parallel verification", branch: "feat/" + id,
    worktreePath: process.cwd(), agent: undefined, status, logs: [],
    result: report,
  };
}

afterEach(() => {
  superagentInstances.clear();
});

describe("Phase 4: parent quorum and peer termination truthfulness", () => {
  it.each([
    ["Status: Partial\nTests: passed", "partial"],
    ["Status: Blocked\nTests: passed", "blocked"],
    ["Status: Completed\nTests: failed", "failed"],
    ["No terminal status\nTests: passed", "unverified"],
  ])("does not terminate peers from incomplete report %j", async (report) => {
    const winner = agent("first", "coder-first", "completed", report);
    const runner = agent("second", "coder-second", "running", "");
    runner.allowEarlyTermination = true;
    superagentInstances.set(winner.id, winner);
    superagentInstances.set(runner.id, runner);
    const controller = new AbortController();
    controller.abort();
    const result = await awaitSuperagentsTool.execute({ earlyTermination: true }, process.cwd(), controller.signal);
    expect(String(result)).toContain("Aborted while waiting");
    expect(runner.status).toBe("running");
  });

  it("reports unverified completion with a warning instead of a success mark", async () => {
    const active = agent("active", "coder-active", "running", "Report without any terminal evidence");
    superagentInstances.set(active.id, active);
    const pending = awaitSuperagentsTool.execute({ timeoutSeconds: 5 }, process.cwd());
    queueMicrotask(() => { active.status = "completed"; });
    const result = await pending;
    expect(String(result)).toContain("⚠️");
    expect(String(result)).toContain("reported: unverified");
    expect(String(result)).not.toContain("✅");
  });
});
