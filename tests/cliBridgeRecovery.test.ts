import { describe, expect, it } from "vitest";
import type { DelegateJob } from "../src/core/tools/cliBridgeDelegateJobs.js";
import { classifyDelegateRecovery, observeProcessId } from "../src/core/tools/cliBridgeRecovery.js";

function stub(overrides: Partial<DelegateJob> = {}): DelegateJob {
  return {
    jobId: "clj_1792500000000_aabbccdd",
    cliAlias: "fixture", binary: process.execPath, cwd: process.cwd(),
    ownerPid: 3333, pid: 4444, status: "running",
    startedAt: Date.now(), updatedAt: Date.now(), exitCode: null,
    timedOut: false, timeoutMs: 3000,
    outputTail: "", outputBytes: 0, logPath: "test.log",
    ...overrides,
  };
}

describe("Hermes CLI Bridge owner/child recovery diagnostics", () => {
  it("never treats a live numeric PID as proof of the original process", () => {
    const result = classifyDelegateRecovery(stub(), {
      ownerPidObservation: "pid_present_unverified",
      childPidObservation: "pid_present_unverified",
    });
    expect(result.assessment).toBe("owner_pid_present_unverified");
    expect(result.requiresManualReview).toBe(true);
    expect(result.reason).toMatch(/reused|descendants/i);
    expect(result.persistedStatus).toBe("running");
  });

  it("treats missing parent with a possibly surviving child as manual review, not success or auto-kill", () => {
    const result = classifyDelegateRecovery(stub(), {
      ownerPidObservation: "pid_absent",
      childPidObservation: "pid_present_unverified",
    });
    expect(result.assessment).toBe("owner_pid_absent_manual_review");
    expect(result.requiresManualReview).toBe(true);
    expect(result.childPidObservation).toBe("pid_present_unverified");
    expect(result.reason).toMatch(/no automatic cancellation or lock removal/i);
  });

  it("handles legacy records without an owner identity as unknown", () => {
    const result = classifyDelegateRecovery(stub({ownerPid: undefined}), {
      childPidObservation: "pid_absent",
    });
    expect(result.ownerPid).toBeNull();
    expect(result.assessment).toBe("legacy_owner_unknown");
    expect(result.requiresManualReview).toBe(true);
  });

  it("does not confuse terminal status or a genuine current runtime handle with an orphan", () => {
    const terminal = classifyDelegateRecovery(stub({status: "succeeded", completionState: "unverified"}), {
      ownerPidObservation: "pid_absent",
      childPidObservation: "pid_absent",
    });
    expect(terminal.assessment).toBe("terminal");
    expect(terminal.requiresManualReview).toBe(false);
    const current = classifyDelegateRecovery(stub(), {ownedByCurrentRuntime: true});
    expect(current.assessment).toBe("owned_by_this_runtime");
    expect(current.requiresManualReview).toBe(false);
  });

  it("handles unknown and restricted PID probes without assuming absence", () => {
    expect(observeProcessId(undefined)).toBe("unknown");
    expect(observeProcessId(-1)).toBe("unknown");
    expect(observeProcessId(Number.NaN)).toBe("unknown");
    expect(observeProcessId(process.pid)).toBe("pid_present_unverified");
    const unknown = classifyDelegateRecovery(stub(), {
      ownerPidObservation: "unknown", childPidObservation: "unknown",
    });
    expect(unknown.assessment).toBe("owner_pid_unknown_manual_review");
    expect(unknown.requiresManualReview).toBe(true);
  });
});
