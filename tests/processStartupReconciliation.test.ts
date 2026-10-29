import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ProcessRegistry,
  getRuntimeGeneration,
  type ProcessRecord,
} from "../src/core/process/processRegistry.js";
import {
  reconcileStartupProcesses,
  type ProcessReconciliationDependencies,
} from "../src/core/process/processReconciliation.js";
import { getProcessSupervisor, resetProcessSupervisorForTest } from "../src/core/process/processSupervisor.js";
import type { JobCheckpoint } from "../src/core/tools/cliBridgeReconciliation.js";

const NOW = 2_000_000;
const WS = "D:/superagent-workspace";
const FOREIGN_WS = "D:/foreign-private-workspace";

function makeRecord(patch: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    recordId: "sp_proc_test_rec",
    pid: 77001,
    parentPid: 1000,
    creationIdentity: "win:638111111111111111",
    parentCreationIdentity: "win:638000000000000000",
    executable: "node.exe",
    sanitizedArgs: ["worker.js"],
    runtimeGeneration: getRuntimeGeneration(),
    ownership: { workspaceRoot: WS, jobId: "job_alpha" },
    component: "cli_bridge_delegate",
    launchIntent: "headless",
    state: "running",
    lifecycle: "job",
    cleanupPolicy: "terminate_with_owner",
    exitCode: null,
    signal: null,
    registeredAt: NOW - 120_000,
    startedAt: NOW - 100_000,
    updatedAt: NOW - 60_000,
    heartbeatAt: NOW - 60_000,
    ...patch,
  };
}

function makeDeps(patch: Partial<ProcessReconciliationDependencies> = {}): ProcessReconciliationDependencies {
  return {
    now: () => NOW,
    observePid: () => "pid_present_unverified",
    readIdentity: async () => "win:638111111111111111",
    inspectOwner: async () => ({ state: "terminal", source: "verified_job_terminal" }),
    readJobCheckpoint: async () => null,
    ...patch,
  };
}

describe("P0 M3 Crash-Safe Read-Only Startup Reconciliation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-rec-test-"));
    resetProcessSupervisorForTest();
  });

  afterEach(async () => {
    resetProcessSupervisorForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("1. Corrupt registry fails closed without adoption, crash, or save mutation", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "corrupt-reg.json") });
    reg.markCorruptForTest("Malformed JSON syntax");

    const report = await reconcileStartupProcesses(reg, { callerWorkspaceRoot: WS });
    expect(report.isCorrupt).toBe(true);
    expect(report.corruptionReason).toContain("Malformed JSON");
    expect(report.totalRecords).toBe(0);
    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.counts.currently_owned_live).toBe(0);
    expect(report.entries).toHaveLength(0);
  });

  it("2. Legacy registry records without lifecycle are safely handled as report-only unknown", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "legacy-reg.json") });
    // Simulate pre-M2 legacy record loaded with lifecycle: "unknown"
    const legacyRec = makeRecord({
      lifecycle: "unknown" as any,
      cleanupPolicy: "caller_owned",
    });
    reg.addRecord(legacyRec);

    const report = await reconcileStartupProcesses(reg, { callerWorkspaceRoot: WS }, makeDeps());
    expect(report.counts.unknown).toBe(1);
    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.entries[0]?.recommendedSafeAction).toBe("review");
  });

  it("3. Detects PID reuse and classifies as identity_mismatch", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "reuse-reg.json") });
    reg.addRecord(makeRecord());

    // Live OS has PID, but creation identity differs
    const report = await reconcileStartupProcesses(
      reg,
      { callerWorkspaceRoot: WS },
      makeDeps({ readIdentity: async () => "win:999999999999999999" })
    );

    expect(report.counts.identity_mismatch).toBe(1);
    expect(report.entries[0]?.classification).toBe("identity_mismatch");
    expect(report.entries[0]?.recommendedSafeAction).toBe("investigate_identity");
    expect(report.entries[0]?.reason).toContain("PID reuse suspected");
  });

  it("4. Classifies as unknown when creation identity is unavailable (PID alone never proves ownership)", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "unknown-id.json") });
    reg.addRecord(makeRecord());

    const report = await reconcileStartupProcesses(
      reg,
      { callerWorkspaceRoot: WS },
      makeDeps({ readIdentity: async () => null })
    );

    expect(report.counts.unknown).toBe(1);
    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.counts.currently_owned_live).toBe(0);
    expect(report.entries[0]?.classification).toBe("unknown");
  });

  it("5. Qualifies dead owner + live child with matching identity and stale lease as orphan_candidate", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "orphan-cand.json") });
    reg.addRecord(makeRecord());

    const report = await reconcileStartupProcesses(reg, { callerWorkspaceRoot: WS }, makeDeps());

    expect(report.counts.orphan_candidate).toBe(1);
    expect(report.entries[0]?.classification).toBe("orphan_candidate");
    expect(report.entries[0]?.recommendedSafeAction).toBe("review");
    expect(reg.getRecord("sp_proc_test_rec")?.state).toBe("running"); // Purely read-only, NO process killing!
  });

  it("6. Re-verifies in second pass and fails closed if owner revives during scan", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "owner-revived.json") });
    reg.addRecord(makeRecord());

    let pass = 0;
    const report = await reconcileStartupProcesses(
      reg,
      { callerWorkspaceRoot: WS },
      makeDeps({
        inspectOwner: async () => ({
          state: ++pass === 1 ? "terminal" : "live",
          source: "owner_probe",
        }),
      })
    );

    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.counts.unknown).toBe(1);
  });

  it("7. Fails closed if heartbeat is renewed during scan race", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "heartbeat-race.json") });
    reg.addRecord(makeRecord());

    let pass = 0;
    const report = await reconcileStartupProcesses(
      reg,
      { callerWorkspaceRoot: WS },
      makeDeps({
        inspectOwner: async () => {
          if (++pass === 1) {
            reg.updateRecord("sp_proc_test_rec", { heartbeatAt: NOW });
          }
          return { state: "terminal", source: "owner_probe" };
        },
      })
    );

    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.counts.unknown).toBe(1);
  });

  it("8. Fails closed if child process disappears during identity verification pass", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "disappeared.json") });
    reg.addRecord(makeRecord());

    let pass = 0;
    const report = await reconcileStartupProcesses(
      reg,
      { callerWorkspaceRoot: WS },
      makeDeps({
        observePid: () => (++pass === 1 ? "pid_present_unverified" : "pid_absent"),
      })
    );

    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.counts.unknown).toBe(1);
  });

  it("9. Persistent and external processes are never marked as orphan candidates", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "persistent.json") });
    reg.addRecord(
      makeRecord({
        recordId: "proc_cf_tunnel",
        component: "cloudflare_tunnel",
        lifecycle: "persistent",
        cleanupPolicy: "keep_alive",
      })
    );
    reg.addRecord(
      makeRecord({
        recordId: "proc_ext",
        component: "provider_daemon",
        lifecycle: "external",
        cleanupPolicy: "manual_only",
      })
    );

    const report = await reconcileStartupProcesses(reg, { callerWorkspaceRoot: WS }, makeDeps());

    expect(report.counts.persistent_external).toBe(2);
    expect(report.counts.orphan_candidate).toBe(0);
    for (const entry of report.entries) {
      expect(entry.classification).toBe("persistent_external");
      expect(entry.recommendedSafeAction).toBe("observe");
    }
  });

  it("10. Historical processes from prior runtime generations are report-only and never adopted", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "historical.json") });
    reg.addRecord(
      makeRecord({
        recordId: "proc_prior_gen",
        runtimeGeneration: "gen_old_12345_abc",
        component: "cli_bridge_historical",
      })
    );

    const report = await reconcileStartupProcesses(reg, { callerWorkspaceRoot: WS }, makeDeps());

    expect(report.counts.historical).toBe(1);
    expect(report.counts.orphan_candidate).toBe(0);
    expect(report.counts.currently_owned_live).toBe(0);
    expect(report.entries[0]?.classification).toBe("historical");
    expect(report.entries[0]?.isCurrentRuntime).toBe(false);
  });

  it("11. Foreign workspace privacy boundary is strictly maintained", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "privacy.json") });
    reg.addRecord(
      makeRecord({
        recordId: "local_proc",
        ownership: { workspaceRoot: WS, jobId: "local_job" },
        sanitizedArgs: ["local.js"],
      })
    );
    reg.addRecord(
      makeRecord({
        recordId: "secret_foreign_proc",
        ownership: { workspaceRoot: FOREIGN_WS, jobId: "TOP_SECRET_JOB_NAME" },
        sanitizedArgs: ["--secret-key", "REDACTED_OR_PRIVATE"],
      })
    );

    // Scoped scan for local workspace
    const report = await reconcileStartupProcesses(reg, { callerWorkspaceRoot: WS }, makeDeps());

    expect(report.totalRecords).toBe(1);
    expect(JSON.stringify(report)).not.toContain("TOP_SECRET_JOB_NAME");
    expect(JSON.stringify(report)).not.toContain(FOREIGN_WS);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]?.recordId).toBe("local_proc");
  });

  it("12. Interrupted mutating jobs return exactly 'unknown_outcome_review_required'", async () => {
    const reg = new ProcessRegistry({ storagePath: path.join(tmpDir, "mutating-check.json") });
    reg.addRecord(
      makeRecord({
        recordId: "proc_mutating",
        ownership: { workspaceRoot: WS, jobId: "job_mutating_123" },
      })
    );

    const checkpoint: JobCheckpoint = {
      checkpointId: "chk_123",
      jobId: "job_mutating_123",
      timestamp: Date.now() - 50_000,
      lastEvent: "tool_execution",
      resourceClaims: [],
      verificationState: "verifying",
      hasMutatingWrite: true,
    };

    let persistedLastEvent = "";
    const report = await reconcileStartupProcesses(
      reg,
      { callerWorkspaceRoot: WS, persistInterruptedMutations: true },
      makeDeps({
        readJobCheckpoint: async (id) => (id === "job_mutating_123" ? checkpoint : null),
        persistCheckpoint: async (chk) => {
          persistedLastEvent = chk.lastEvent;
          return "saved";
        },
      })
    );

    expect(report.mutatingJobsRequiringReview).toBe(1);
    expect(report.jobAssessments).toHaveLength(1);
    const assessment = report.jobAssessments[0];
    expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
    expect(assessment?.requiresReview).toBe(true);
    expect(assessment?.eligibleForRetry).toBe(false);
    expect(persistedLastEvent).toBe("reconciled_unknown_outcome_review_required");
  });

  it("13. ProcessSupervisor.reconcileOnStartup caches report and provides read-only inspection", async () => {
    const sup = getProcessSupervisor({ storagePath: path.join(tmpDir, "sup-reg.json") });
    await sup.initialize();

    sup.getRegistry().addRecord(makeRecord());

    const report = await sup.reconcileOnStartup(
      { callerWorkspaceRoot: WS },
      makeDeps()
    );

    expect(report.totalRecords).toBe(1);
    expect(sup.getLastReconciliationReport()).toBe(report);
  });
});
