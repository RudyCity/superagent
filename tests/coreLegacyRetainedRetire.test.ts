import { describe, expect, it } from "vitest";
import {
  legacyRetainedCoreMayDrain,
  type CoreDrainMetrics,
} from "../src/core/runtime/coreDrainInspection.js";

const empty: CoreDrainMetrics = {
  sessions: 0, sseClients: 0, browserClients: 0, pendingPrompts: 0,
  backgroundTasks: 0, agents: 0, cliBridgeSessions: 0,
  detachedCliBridgeSessions: 0, scheduledJobs: 0, remoteTasks: 0,
  daemonRunning: 0, museWatcher: 0,
};

describe("legacy retained Core retirement precondition", () => {
  it("requires exactly the historical helper blockers with no live work", () => {
    expect(legacyRetainedCoreMayDrain({
      pid: 101,
      workerGenerationId: "a".repeat(32),
      transportIsolated: false,
      visionOwner: true,
      safe: false,
      blockers: ["transport isolation not verified", "owns fixed-port vision helper"],
      metrics: empty,
    })).toBe(true);

    expect(legacyRetainedCoreMayDrain({
      pid: 101,
      workerGenerationId: "a".repeat(32),
      transportIsolated: false,
      visionOwner: true,
      safe: false,
      blockers: ["transport isolation not verified", "owns fixed-port vision helper", "sessions: 1"],
      metrics: { ...empty, sessions: 1 },
    })).toBe(false);
  });
});
