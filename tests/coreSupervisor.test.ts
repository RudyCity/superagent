import { describe, expect, it } from "vitest";
import { formatCoreSupervisorStatus, requestCoreSupervisor } from "../src/core/runtime/coreSupervisor.js";

describe("opt-in core supervisor safety", () => {
  it("shows active and retained generations without exposing control secrets", () => {
    const result = formatCoreSupervisorStatus({
      publicPort: 7888,
      supervisorPid: 11,
      active: { pid: 12, port: 31234, since: 1000 },
      retained: [{ pid: 13, port: 31235, since: 900 }],
      maxRetainedWorkers: 4,
      affinitySessions: 2,
      lastRollback: { reason: "operator-requested", fromPid: 13, toPid: 12, at: 1200 },
      lastDrain: { checked: 2, retiredPids: [14], blocked: ["PID 13: pinned sessions remain"], at: 1400 },
    });
    expect(result).toContain("Supervisor PID: 11");
    expect(result).toContain("Active worker: PID 12");
    expect(result).toContain("Retained previous workers: 1");
    expect(result).toContain("Retained-worker safety limit: 4");
    expect(result).toContain("Session IDs pinned to origin workers: 2");
    expect(result).toContain("Last rollback: operator-requested");
    expect(result).toContain("Last drain: inspected 2, retired 1");
    expect(result).toContain("blocked: PID 13: pinned sessions remain");
    expect(result).not.toContain("controlToken");
  });

  it("refuses invalid ports before contacting any supervisor", async () => {
    await expect(requestCoreSupervisor("restart", 0)).rejects.toThrow("No supervised core");
    await expect(requestCoreSupervisor("restart", 65536)).rejects.toThrow("No supervised core");
  });
});
