import { describe, expect, it } from "vitest";
import { formatCoreSupervisorStatus, requestCoreSupervisor } from "../src/core/runtime/coreSupervisor.js";

describe("opt-in core supervisor safety", () => {
  it("shows active and retained generations without exposing control secrets", () => {
    const result = formatCoreSupervisorStatus({
      publicPort: 7888,
      supervisorPid: 11,
      active: { pid: 12, port: 31234, since: 1000 },
      retained: [{ pid: 13, port: 31235, since: 900 }],
    });
    expect(result).toContain("Supervisor PID: 11");
    expect(result).toContain("Active worker: PID 12");
    expect(result).toContain("Retained previous workers: 1");
    expect(result).not.toContain("controlToken");
  });

  it("refuses invalid ports before contacting any supervisor", async () => {
    await expect(requestCoreSupervisor("restart", 0)).rejects.toThrow("No supervised core");
    await expect(requestCoreSupervisor("restart", 65536)).rejects.toThrow("No supervised core");
  });
});
