import { describe, expect, it } from "vitest";
import { evaluateCoreDrain, legacyRetainedCoreMayDrain, type CoreDrainMetrics } from "../src/core/runtime/coreDrainInspection.js";
const empty: CoreDrainMetrics = {
  sessions: 0, sseClients: 0, browserClients: 0, pendingPrompts: 0,
  backgroundTasks: 0, agents: 0, cliBridgeSessions: 0,
  detachedCliBridgeSessions: 0, scheduledJobs: 0,
  remoteTasks: 0, daemonRunning: 0, museWatcher: 0,
};
describe("core worker drain inspection", () => {
  it("allows only completely quiescent isolated non-vision workers", () => {
    expect(evaluateCoreDrain(12, "generation-12", { transportIsolated: true, visionOwner: false, metrics: empty }).safe).toBe(true);
  });
  it("blocks any live agent, SSE, subprocess, background job or unknown count", () => {
    for (const key of Object.keys(empty) as (keyof CoreDrainMetrics)[]) {
      const result = evaluateCoreDrain(13, "generation-13", {
        transportIsolated: true, visionOwner: false, metrics: { ...empty, [key]: 1 },
      });
      expect(result.safe).toBe(false);
      expect(result.blockers.some(item => item.startsWith(key + ":"))).toBe(true);
    }
    expect(evaluateCoreDrain(13, "generation-13", {
      transportIsolated: true, visionOwner: false, metrics: { ...empty, sessions: -1 },
    }).safe).toBe(false);
  });
  it("allows only a fully quiescent pre-isolation Vision owner through the legacy compatibility gate", () => {
    const legacy = evaluateCoreDrain(15, "generation-15", {
      transportIsolated: false, visionOwner: true, metrics: empty,
    });
    expect(legacy.safe).toBe(false);
    expect(legacyRetainedCoreMayDrain(legacy)).toBe(true);

    const active = evaluateCoreDrain(15, "generation-15", {
      transportIsolated: false, visionOwner: true,
      metrics: { ...empty, backgroundTasks: 1 },
    });
    expect(legacyRetainedCoreMayDrain(active)).toBe(false);

    expect(legacyRetainedCoreMayDrain({
      ...legacy,
      blockers: [...legacy.blockers, "unexpected ownership blocker"],
    })).toBe(false);
  });

  it("never retires transport owners or fixed-port vision owners", () => {
    expect(evaluateCoreDrain(14, "generation-14", { transportIsolated: false, visionOwner: false, metrics: empty }).safe).toBe(false);
    expect(evaluateCoreDrain(14, "generation-14", { transportIsolated: true, visionOwner: true, metrics: empty }).safe).toBe(false);
  });
});
