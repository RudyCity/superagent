import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { compareProcessStartIdentity, readProcessStartIdentity } from "../src/core/tools/cliBridgeProcessIdentity.js";
import { classifyDelegateRecovery } from "../src/core/tools/cliBridgeRecovery.js";
import type { DelegateJob } from "../src/core/tools/cliBridgeDelegateJobs.js";

function record(overrides: Partial<DelegateJob> = {}): DelegateJob {
  return {
    jobId: "clj_1792500000000_abcdef12", cliAlias: "test",
    binary: process.execPath, cwd: process.cwd(), workspaceRoot: process.cwd(),
    ownerPid: 1234, pid: 5678, ownerProcessIdentity: "win:123456789012345678",
    childProcessIdentity: "win:123456789012345679",
    status: "running", startedAt: Date.now(), updatedAt: Date.now(),
    exitCode: null, timedOut: false, timeoutMs: 5000, outputTail: "",
    outputBytes: 0, logPath: "test.log", ...overrides,
  };
}

describe("Hermes Phase 4 read-only process creation identity", () => {
  it("compares fingerprint values only when both exist", () => {
    expect(compareProcessStartIdentity("win:111", "win:111")).toBe("matched_unverified");
    expect(compareProcessStartIdentity("win:111", "win:222")).toBe("mismatch");
    expect(compareProcessStartIdentity(undefined, "win:222")).toBe("unknown");
    expect(compareProcessStartIdentity("win:111", undefined)).toBe("unknown");
  });

  it("classifies a reused PID as a mismatch without claiming safe recovery", () => {
    const result = classifyDelegateRecovery(record(), {
      ownerPidObservation: "pid_present_unverified",
      childPidObservation: "pid_present_unverified",
      ownerIdentityObservation: "win:999999999999999999",
      childIdentityObservation: "win:123456789012345679",
    });
    expect(result.assessment).toBe("owner_identity_mismatch_manual_review");
    expect(result.ownerIdentityComparison).toBe("mismatch");
    expect(result.childIdentityComparison).toBe("matched_unverified");
    expect(result.requiresManualReview).toBe(true);
    expect(result.reason).toMatch(/PID reuse|do not signal/i);
    expect(result.persistedStatus).toBe("running");
  });

  it("marks matching owner process birth as a stronger hint, not descendant safety", () => {
    const result = classifyDelegateRecovery(record(), {
      ownerPidObservation: "pid_present_unverified",
      ownerIdentityObservation: "win:123456789012345678",
    });
    expect(result.assessment).toBe("owner_identity_matched_unverified");
    expect(result.ownerIdentityComparison).toBe("matched_unverified");
    expect(result.requiresManualReview).toBe(true);
    expect(result.reason).toMatch(/descendants.*unverified/i);
  });

  it("probes the actual owner process without shell interpolation or throwing", async () => {
    const id = await readProcessStartIdentity(process.pid);
    if (process.platform === "win32" || process.platform === "linux") {
      expect(id).toMatch(process.platform === "win32" ? /^win:\d{15,20}$/ : /^linux:[a-f0-9-]{36}:\d+$/);
    } else expect(id).toBeNull();
    expect(await readProcessStartIdentity(-5)).toBeNull();
    expect(await readProcessStartIdentity(undefined)).toBeNull();
    expect(await readProcessStartIdentity(2147483000)).toBeNull();
  }, 15_000);

  it("distinguishes two separate process starts on the same executable", async () => {
    async function childFingerprint() {
      const proc = spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], {stdio:"ignore"});
      try {
        const identity = await readProcessStartIdentity(proc.pid);
        return identity;
      } finally {
        proc.kill();
      }
    }
    const first = await childFingerprint();
    // Linux /proc starttime is quantized in clock ticks; separate processes
    // started within one tick can share the same timestamp component.
    if (process.platform === "linux") await new Promise(resolve => setTimeout(resolve, 30));
    const second = await childFingerprint();
    if (first && second) expect(first).not.toBe(second);
  }, 18_000);
});
