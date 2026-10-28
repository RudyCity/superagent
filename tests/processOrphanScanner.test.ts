import { describe, expect, it } from "vitest";
import { ProcessRegistry, getRuntimeGeneration, type ProcessRecord } from "../src/core/process/processRegistry.js";
import { scanManagedProcessOrphans, type ProcessScanDependencies } from "../src/core/process/processOrphanScanner.js";

const NOW = 1_000_000;
const WS = "D:/unit-owned-workspace";
function fixture(patch: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    recordId: "sp_proc_test_owned", pid: 65001, parentPid: 100,
    creationIdentity: "win:638000000000000000",
    parentCreationIdentity: "win:637000000000000000",
    executable: "node.exe", sanitizedArgs: ["test.js"],
    runtimeGeneration: getRuntimeGeneration(),
    ownership: { workspaceRoot: WS, jobId: "job_done" },
    component: "cli_bridge_session", launchIntent: "headless",
    state: "running", lifecycle: "job", cleanupPolicy: "terminate_with_owner",
    exitCode: null, signal: null, registeredAt: NOW - 100_000,
    startedAt: NOW - 90_000, updatedAt: NOW - 60_000,
    heartbeatAt: NOW - 60_000,
    ...patch,
  };
}
function setup(patch: Partial<ProcessRecord> = {}) {
  const registry = new ProcessRegistry({ storagePath: "test-only-not-written.json" });
  registry.addRecord(fixture(patch));
  return registry;
}
function deps(patch: Partial<ProcessScanDependencies> = {}): ProcessScanDependencies {
  return {
    now: () => NOW,
    observePid: () => "pid_present_unverified",
    readIdentity: async () => "win:638000000000000000",
    inspectOwner: async () => ({ state: "terminal", source: "verified_job_terminal" }),
    ...patch,
  };
}
const scan = (r: ProcessRegistry, d = deps()) =>
  scanManagedProcessOrphans(r, { callerWorkspaceRoot: WS, graceMs: 30_000 }, d);
const kind = async (r: ProcessRegistry, d = deps()) => (await scan(r, d)).entries[0]?.classification;

describe("M2 read-only ownership-aware scanner / fault injection", () => {
  it("requires confirmed dead owner and a live process with matching identity and stale lease", async () => {
    const r = setup();
    const report = await scan(r);
    expect(report.counts.orphan_candidate).toBe(1);
    expect(report.entries[0]?.recommendedSafeAction).toBe("review");
    expect(r.getRecord("sp_proc_test_owned")?.state).toBe("running"); // scanner is read-only
  });
  it("never treats dead parent PID alone as owner terminal proof", async () => {
    expect(await kind(setup(), deps({ inspectOwner: async () => ({ state: "unknown", source: "parent_pid_absent_only" }) }))).toBe("unknown");
  });
  it("rejects PID reuse and mismatched process birth identity", async () => {
    expect(await kind(setup(), deps({ readIdentity: async () => "win:99999999999999999" }))).toBe("identity_mismatch");
  });
  it("rejects PID present with unavailable creation identity", async () => {
    expect(await kind(setup(), deps({ readIdentity: async () => null }))).toBe("unknown");
  });
  it("reports dead PID without becoming orphan candidate", async () => {
    expect(await kind(setup(), deps({ observePid: () => "pid_absent" }))).toBe("unknown");
  });
  it("treats old runtime generations as historical and report-only", async () => {
    expect(await kind(setup({ runtimeGeneration: "gen_old" }))).toBe("historical");
  });
  it("fails closed on corrupt registry", async () => {
    const r = setup(); r.markCorruptForTest("malformed");
    const report = await scan(r);
    expect(report.isCorrupt).toBe(true);
    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.entries).toEqual([]);
  });
  it("never marks persistent or provider-managed records as orphans", async () => {
    expect(await kind(setup({ lifecycle: "persistent", cleanupPolicy: "keep_alive" }))).toBe("persistent_external");
    expect(await kind(setup({ lifecycle: "external", cleanupPolicy: "terminate_with_owner" }))).toBe("persistent_external");
  });
  it("refuses legacy automatic cleanup policy even with stale heartbeat", async () => {
    expect(await kind(setup({ cleanupPolicy: "automatic" }))).toBe("unknown");
  });
  it("refuses missing heartbeat rather than guessing lease staleness", async () => {
    expect(await kind(setup({ heartbeatAt: undefined }))).toBe("unknown");
  });
  it("refuses fresh leases", async () => {
    expect(await kind(setup({ heartbeatAt: NOW - 50 }))).toBe("unknown");
  });
  it("refuses a revived owner during final evidence pass", async () => {
    let n = 0;
    expect(await kind(setup(), deps({ inspectOwner: async () => ({
      state: ++n === 1 ? "terminal" : "live",
      source: "authoritative_owner_state",
    }) }))).toBe("unknown");
  });
  it("refuses a heartbeat renewed during the scan", async () => {
    const r = setup();
    let n = 0;
    expect(await kind(r, deps({ inspectOwner: async () => {
      if (++n === 1) r.updateRecord("sp_proc_test_owned", { heartbeatAt: NOW });
      return { state: "terminal", source: "verified_job_terminal" };
    } }))).toBe("unknown");
  });
  it("refuses a process disappearing during the final identity pass", async () => {
    let n = 0;
    expect(await kind(setup(), deps({ observePid: () => (++n === 1 ? "pid_present_unverified" : "pid_absent") }))).toBe("unknown");
  });
  it("never claims ownership for unregistered historical AGY processes", async () => {
    const report = await scan(new ProcessRegistry({ storagePath: "test-only-unwritten.json" }));
    expect(report.total).toBe(0);
    expect(report.counts.orphan_candidate).toBe(0);
  });
  it("does not disclose foreign workspace metadata or counts", async () => {
    const r = setup({ ownership: { workspaceRoot: "D:/foreign/private", jobId: "SECRET_JOB" }, sanitizedArgs: ["SECRET_PROMPT"] });
    const report = await scan(r);
    expect(report.total).toBe(0);
    expect(JSON.stringify(report)).not.toContain("SECRET");
    expect(report.entries).toHaveLength(0);
  });
  it("requires explicit cleanup eligibility; no arbitrary OS-process adoption", async () => {
    expect(await kind(setup({ cleanupPolicy: "caller_owned" }))).toBe("unknown");
    expect(await kind(setup({ state: "exited" }))).toBe("terminal");
  });
});
