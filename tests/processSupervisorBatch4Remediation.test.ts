import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import {
  ProcessRegistry,
  getRuntimeGeneration,
  type ProcessRecord,
} from "../src/core/process/processRegistry.js";
import {
  ProcessSupervisor,
  getProcessSupervisor,
  resetProcessSupervisorForTest,
  resetSupervisorBootstrapForTest,
  bootstrapProcessSupervisorOnStartup,
} from "../src/core/process/processSupervisor.js";
import {
  reconcileStartupProcesses,
  type ProcessReconciliationDependencies,
} from "../src/core/process/processReconciliation.js";
import {
  writeJobCheckpoint,
  readJobCheckpoint,
  isValidJobId,
  type JobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";

const WS_A = "D:/superagent/project-a";
const WS_B = "D:/superagent/project-b";

describe("SuperAgent Runtime Supervisor Batch 4 Audit Remediation", () => {
  let tmpDir: string;
  let registryFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "sp-batch4-test-"));
    registryFile = path.join(tmpDir, "process-registry.json");
    resetSupervisorBootstrapForTest();
  });

  afterEach(async () => {
    resetSupervisorBootstrapForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // =========================================================================
  // P0-1: Safe, Once-Per-Owner Startup Bootstrap Wiring
  // =========================================================================
  describe("P0-1: Runtime Startup Reconciliation Bootstrap", () => {
    it("wires bootstrap reconciliation to startup and caches report without manual /status call", async () => {
      const supervisor = getProcessSupervisor({ storagePath: registryFile });
      await supervisor.initialize();

      // Pre-seed an interrupted mutating job in the registry & checkpoint
      const regRec = await supervisor.registerProcess({
        component: "cli_bridge_delegate",
        executable: process.execPath,
        workspaceRoot: WS_A,
        jobId: "interrupted_job_001",
      });

      // Write checkpoint with verifying state
      const checkpointsDir = path.join(tmpDir, "checkpoints");
      const origEnv = process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
      process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = checkpointsDir;

      try {
        await writeJobCheckpoint({
          checkpointId: "chk_001",
          jobId: "interrupted_job_001",
          timestamp: Date.now() - 60_000,
          lastEvent: "tool_execution",
          resourceClaims: [],
          verificationState: "verifying",
          hasMutatingWrite: true,
        });

        // Simulate CLI boot: call bootstrapProcessSupervisorOnStartup
        const report = await bootstrapProcessSupervisorOnStartup({
          workspaceRoot: WS_A,
          silent: true,
        });

        expect(report).toBeDefined();
        expect(report?.mutatingJobsRequiringReview).toBe(1);
        expect(report?.jobAssessments[0]?.reconciledStatus).toBe("unknown_outcome_review_required");
        expect(report?.jobAssessments[0]?.requiresReview).toBe(true);

        // Verify supervisor cached the report
        expect(supervisor.getLastReconciliationReport()).toBe(report);

        // Verify subsequent bootstrap call is a no-op (once-per-owner)
        const secondReport = await bootstrapProcessSupervisorOnStartup({
          workspaceRoot: WS_A,
          silent: true,
        });
        expect(secondReport).toBe(report);
      } finally {
        if (origEnv) {
          process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = origEnv;
        } else {
          delete process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
        }
      }
    });
  });

  // =========================================================================
  // P0-2: Scoped Filter Ownerless Record Leak Remediation
  // =========================================================================
  describe("P0-2: Workspace Scoped Privacy & Ownerless Record Isolation", () => {
    it("reproduces and eliminates audit P0-2 leak: ownerless records are omitted from scoped scans", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });

      // Record 1: Ownerless record (no workspaceRoot) with private jobId
      registry.addRecord({
        recordId: "audit_finished_foreign",
        pid: 99991,
        parentPid: 1000,
        creationIdentity: "win:mock1",
        executable: "node.exe",
        sanitizedArgs: ["secret.js"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { jobId: "private_job_123" }, // NO workspaceRoot!
        component: "cli_bridge",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 10_000,
        updatedAt: Date.now() - 5_000,
      });

      // Record 2: Matching workspace record
      registry.addRecord({
        recordId: "matching_proc",
        pid: 99992,
        parentPid: 1000,
        creationIdentity: "win:mock2",
        executable: "node.exe",
        sanitizedArgs: ["local.js"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "local_job_456" },
        component: "cli_bridge",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 10_000,
        updatedAt: Date.now() - 5_000,
      });

      // Request scoped scan for unrelated workspace WS_B
      const reportB = await reconcileStartupProcesses(registry, {
        callerWorkspaceRoot: WS_B,
      });

      // In the audit reproduction, audit_finished_foreign leaked into WS_B!
      // With the fix, WS_B must receive ZERO records and ZERO leaked jobIds
      expect(reportB.totalRecords).toBe(0);
      expect(reportB.entries).toHaveLength(0);
      expect(reportB.mutatingJobsRequiringReview).toBe(0);
      expect(JSON.stringify(reportB)).not.toContain("private_job_123");
      expect(JSON.stringify(reportB)).not.toContain("audit_finished_foreign");

      // Request scoped scan for WS_A: must only see matching_proc
      const reportA = await reconcileStartupProcesses(registry, {
        callerWorkspaceRoot: WS_A,
      });
      expect(reportA.totalRecords).toBe(1);
      expect(reportA.entries).toHaveLength(1);
      expect(reportA.entries[0]?.recordId).toBe("matching_proc");
      expect(JSON.stringify(reportA)).not.toContain("private_job_123");

      // Request unscoped operator scan (no callerWorkspaceRoot): all records visible
      const reportGlobal = await reconcileStartupProcesses(registry);
      expect(reportGlobal.totalRecords).toBe(2);
      expect(reportGlobal.entries).toHaveLength(2);
    });

    it("P1-4: hardens getProcessDiagnostics against ownerless record leaks", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });
      await supervisor.initialize();

      // Register ownerless record directly in registry
      supervisor.getRegistry().addRecord({
        recordId: "ownerless_diag_rec",
        pid: 99993,
        parentPid: 1000,
        creationIdentity: "win:mock3",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { jobId: "private_ownerless_job" }, // no workspaceRoot
        component: "worker",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Diagnostic query strictly filtered by workspace
      const filteredDiag = await supervisor.getProcessDiagnostics({
        filterByWorkspaceRoot: WS_A,
      });
      expect(filteredDiag.totalTracked).toBe(0);
      expect(filteredDiag.entries).toHaveLength(0);

      // Diagnostic query with callerWorkspaceRoot masking
      const maskedDiag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: WS_A,
      });
      expect(maskedDiag.totalTracked).toBe(1);
      const entry = maskedDiag.entries[0];
      expect(entry?.ownership.isForeignWorkspace).toBe(true);
      expect(entry?.ownership.jobId).toBe("[foreign_job]");
      expect(entry?.ownership.sessionId).toBe("[foreign_session]");
      expect(JSON.stringify(maskedDiag)).not.toContain("private_ownerless_job");
    });
  });

  // =========================================================================
  // P0-3: Multi-Process Durability & Lost-Update Prevention
  // =========================================================================
  describe("P0-3: Multi-Process Registry Durability & Lost-Update Prevention", () => {
    it("reproduces and eliminates audit P0-3: concurrent instances A and B never lose records", async () => {
      const instA = new ProcessRegistry({ storagePath: registryFile });
      const instB = new ProcessRegistry({ storagePath: registryFile });
      await instA.load();
      await instB.load();

      // Instance A registers owner_A and saves
      instA.addRecord({
        recordId: "owner_A",
        pid: 1001,
        parentPid: 1,
        creationIdentity: "mock_id_A",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "comp_A",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
      await instA.save();

      // Instance B registers owner_B from its previously empty in-memory snapshot and saves
      instB.addRecord({
        recordId: "owner_B",
        pid: 1002,
        parentPid: 1,
        creationIdentity: "mock_id_B",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "comp_B",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
      await instB.save();

      // Reload from disk: BOTH owner_A and owner_B MUST survive!
      const reloaded = new ProcessRegistry({ storagePath: registryFile });
      await reloaded.load();

      const ids = reloaded.listRecords().map((r) => r.recordId);
      expect(ids).toContain("owner_A");
      expect(ids).toContain("owner_B");
      expect(ids).toHaveLength(2);
    });

    it("runs 2 separate OS child processes saving concurrently with zero lost updates", async () => {
      // Create child worker script that saves records
      const workerScript = path.join(tmpDir, "test_worker.js");
      await fs.writeFile(
        workerScript,
        `
        const { ProcessRegistry } = require("${path.resolve("dist/core/process/processRegistry.js").replace(/\\/g, "/")}");
        async function run() {
          const prefix = process.argv[2];
          const count = parseInt(process.argv[3], 10);
          const storagePath = process.argv[4];

          const reg = new ProcessRegistry({ storagePath });
          await reg.load();

          for (let i = 0; i < count; i++) {
            reg.addRecord({
              recordId: prefix + "_" + i,
              pid: process.pid,
              parentPid: 1,
              creationIdentity: "id_" + prefix + "_" + i,
              executable: "node.exe",
              sanitizedArgs: [],
              runtimeGeneration: "gen_test",
              component: "worker",
              launchIntent: "headless",
              state: "running",
              lifecycle: "job",
              cleanupPolicy: "caller_owned",
              exitCode: null,
              signal: null,
              registeredAt: Date.now(),
              updatedAt: Date.now(),
            });
            await reg.save();
          }
        }
        run().catch(err => { console.error(err); process.exit(1); });
        `,
        "utf8"
      );

      // Launch process A (12 records) and process B (12 records) concurrently
      const execP = (prefix: string, count: number) =>
        new Promise<number>((resolve, reject) => {
          const cp = spawn(process.execPath, [workerScript, prefix, String(count), registryFile], {
            stdio: "ignore",
            windowsHide: true,
          });
          cp.on("exit", (code) => resolve(code ?? 0));
          cp.on("error", reject);
        });

      const [codeA, codeB] = await Promise.all([execP("procA", 12), execP("procB", 12)]);
      expect(codeA).toBe(0);
      expect(codeB).toBe(0);

      const reloaded = new ProcessRegistry({ storagePath: registryFile, maxRecords: 100 });
      await reloaded.load();
      const records = reloaded.listRecords();
      expect(records).toHaveLength(24);

      const procAKeys = records.filter((r) => r.recordId.startsWith("procA_"));
      const procBKeys = records.filter((r) => r.recordId.startsWith("procB_"));
      expect(procAKeys).toHaveLength(12);
      expect(procBKeys).toHaveLength(12);
    });

    it("preserves terminal state monotonically during multi-process CAS merge", async () => {
      const instA = new ProcessRegistry({ storagePath: registryFile });
      const instB = new ProcessRegistry({ storagePath: registryFile });
      await instA.load();
      await instB.load();

      // Instance A registers a process and marks it terminal
      instA.addRecord({
        recordId: "job_monotonic_1",
        pid: 2001,
        parentPid: 1,
        creationIdentity: "id_mono_1",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 1000,
        updatedAt: Date.now() - 500,
        exitedAt: Date.now() - 500,
      });
      await instA.save();

      // Instance B has the same record in memory as "running" from an older snapshot
      instB.addRecord({
        recordId: "job_monotonic_1",
        pid: 2001,
        parentPid: 1,
        creationIdentity: "id_mono_1",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "delegate",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: null,
        signal: null,
        registeredAt: Date.now() - 1000,
        updatedAt: Date.now(), // Newer timestamp on running state
      });
      await instB.save();

      // Reload: terminal state MUST win over running state regardless of timestamps
      const reloaded = new ProcessRegistry({ storagePath: registryFile });
      await reloaded.load();
      const rec = reloaded.getRecord("job_monotonic_1");
      expect(rec?.state).toBe("exited");
      expect(rec?.exitCode).toBe(0);
    });

    it("fails closed on corrupt registry encountered during lock re-read without overwriting", async () => {
      // Write corrupted JSON to registry file
      await fs.writeFile(registryFile, "{ malformed JSON file content ...", "utf8");

      const reg = new ProcessRegistry({ storagePath: registryFile });
      reg.addRecord({
        recordId: "new_record",
        pid: 3001,
        parentPid: 1,
        creationIdentity: "mock_id",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "worker",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Saving must throw and mark corrupt fail-closed
      await expect(reg.save()).rejects.toThrow(/corrupt/i);
      expect(reg.isRegistryCorrupt()).toBe(true);

      // Verify corrupted file on disk was preserved intact
      const content = await fs.readFile(registryFile, "utf8");
      expect(content).toContain("malformed JSON file content");
    });
  });

  // =========================================================================
  // P1-1: Authoritative Terminal Job Verification
  // =========================================================================
  describe("P1-1: Authoritative Terminal Job Verification", () => {
    it("classifies terminal verified mutating job as succeeded, NOT unknown_outcome_review_required", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_verified_mutating",
        pid: 5001,
        parentPid: 1000,
        creationIdentity: "win:5001_id",
        executable: "node.exe",
        sanitizedArgs: ["mutate.js"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "verified_job_001" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 50_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint: JobCheckpoint = {
        checkpointId: "chk_v1",
        jobId: "verified_job_001",
        timestamp: Date.now() - 10_000,
        lastEvent: "verified_succeeded",
        resourceClaims: [],
        verificationState: "verified",
        hasMutatingWrite: true,
      };

      const report = await reconcileStartupProcesses(
        registry,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => checkpoint,
        }
      );

      // Mutating review count MUST be 0!
      expect(report.mutatingJobsRequiringReview).toBe(0);
      expect(report.jobAssessments).toHaveLength(1);
      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("succeeded");
      expect(assessment?.requiresReview).toBe(false);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(report.entries[0]?.recommendedSafeAction).toBe("none");
    });

    it("classifies interrupted verifier job as unknown_outcome_review_required", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_interrupted_verifier",
        pid: 5002,
        parentPid: 1000,
        creationIdentity: "win:5002_id",
        executable: "node.exe",
        sanitizedArgs: ["verifier.js"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "interrupted_job_002" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "running", // Crashed while running verifier
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: null,
        signal: null,
        registeredAt: Date.now() - 50_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint: JobCheckpoint = {
        checkpointId: "chk_v2",
        jobId: "interrupted_job_002",
        timestamp: Date.now() - 10_000,
        lastEvent: "verifier_executing",
        resourceClaims: [],
        verificationState: "verifying",
        hasMutatingWrite: true,
      };

      const report = await reconcileStartupProcesses(
        registry,
        { callerWorkspaceRoot: WS_A },
        {
          observePid: () => "pid_absent",
          readJobCheckpoint: async () => checkpoint,
        }
      );

      expect(report.mutatingJobsRequiringReview).toBe(1);
      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
    });
  });

  // =========================================================================
  // P1-2: Explicit Global-System vs Workspace Ownership Contract
  // =========================================================================
  describe("P1-2: Explicit Global-System Service Ownership", () => {
    it("models global system services with systemScope: 'global' and excludes from tenant scans", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });
      await supervisor.initialize();

      // Register global infrastructure service (no workspaceRoot)
      const globalService = await supervisor.registerProcess({
        component: "core_worker",
        executable: process.execPath,
        args: ["--server", "7888"],
        launchIntent: "headless",
        lifecycle: "persistent",
        cleanupPolicy: "lease_managed",
        systemScope: "global",
      });

      expect(globalService.ownership?.systemScope).toBe("global");
      expect(globalService.ownership?.workspaceRoot).toBeUndefined();

      // Register tenant workspace job
      const tenantJob = await supervisor.registerProcess({
        component: "cli_bridge_delegate",
        executable: "agy.exe",
        workspaceRoot: WS_A,
        jobId: "tenant_job_1",
      });
      expect(tenantJob.ownership?.systemScope).toBe("workspace");
      expect(tenantJob.ownership?.workspaceRoot).toBe(WS_A);

      // Scoped reconciliation for WS_A: must only see tenantJob, NEVER globalService
      const report = await supervisor.reconcileOnStartup({
        callerWorkspaceRoot: WS_A,
      });
      expect(report.totalRecords).toBe(1);
      expect(report.entries[0]?.recordId).toBe(tenantJob.recordId);
      expect(report.entries[0]?.jobId).toBe("tenant_job_1");

      // Diagnostics strictly scoped by workspace: excludes globalService
      const diag = await supervisor.getProcessDiagnostics({
        filterByWorkspaceRoot: WS_A,
      });
      expect(diag.totalTracked).toBe(1);
      expect(diag.entries[0]?.recordId).toBe(tenantJob.recordId);

      // Unscoped operator diagnostics: surfaces both with clear systemScope
      const operatorDiag = await supervisor.getProcessDiagnostics();
      expect(operatorDiag.totalTracked).toBe(2);
      const globalEntry = operatorDiag.entries.find((e) => e.recordId === globalService.recordId);
      expect(globalEntry?.ownership.systemScope).toBe("global");
    });
  });

  // =========================================================================
  // P1-3: Monotonic Terminal Lifecycle & Spawn Race Protection
  // =========================================================================
  describe("P1-3: Monotonic Terminal Lifecycle Protection", () => {
    it("prevents late recordProcessSpawn from resurrecting an exited process back to running", async () => {
      const supervisor = new ProcessSupervisor({ storagePath: registryFile });
      await supervisor.initialize();

      const reg = await supervisor.registerProcess({
        component: "ephemeral_hook",
        executable: "node.exe",
        workspaceRoot: WS_A,
      });

      // Spawn and immediately observe exit
      await supervisor.recordProcessSpawn(reg.recordId, 44401);
      await supervisor.recordProcessExit(reg.recordId, { exitCode: 0 });

      let record = supervisor.getRegistry().getRecord(reg.recordId);
      expect(record?.state).toBe("exited");
      expect(record?.exitCode).toBe(0);

      // Late spawn observation arrives asynchronously
      const lateResult = await supervisor.recordProcessSpawn(reg.recordId, 44401);

      record = supervisor.getRegistry().getRecord(reg.recordId);
      expect(record?.state).toBe("exited"); // MUST remain exited!
      expect(lateResult?.state).toBe("exited");
    });

    it("registry.updateRecord rejects patch state regression from terminal to running", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "rec_term_guard",
        pid: 6001,
        parentPid: 1,
        creationIdentity: "id_guard",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "task",
        launchIntent: "headless",
        state: "failed",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: 1,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Attempt to patch state to 'running'
      const updated = registry.updateRecord("rec_term_guard", { state: "running" });
      expect(updated?.state).toBe("failed");
      expect(registry.getRecord("rec_term_guard")?.state).toBe("failed");
    });
  });

  // =========================================================================
  // P2-2: Canonical Job ID Validation and Path Containment
  // =========================================================================
  describe("P2-2: Checkpoint Canonical ID Validation & Path Containment", () => {
    it("validates canonical job IDs and rejects path traversals", () => {
      expect(isValidJobId("job_123")).toBe(true);
      expect(isValidJobId("job-alpha-001")).toBe(true);
      expect(isValidJobId("abcDEF123_456-789")).toBe(true);

      // Path traversal attempts
      expect(isValidJobId("../../etc/passwd")).toBe(false);
      expect(isValidJobId("..\\windows\\system32")).toBe(false);
      expect(isValidJobId("job/subjob")).toBe(false);
      expect(isValidJobId("job\\subjob")).toBe(false);
      expect(isValidJobId("")).toBe(false);
      expect(isValidJobId("a".repeat(129))).toBe(false); // exceeds 128 chars
      expect(isValidJobId(null)).toBe(false);
      expect(isValidJobId(undefined)).toBe(false);
    });

    it("writeJobCheckpoint rejects path traversal job IDs", async () => {
      const maliciousCheckpoint: JobCheckpoint = {
        checkpointId: "chk_bad",
        jobId: "../../escaped_job",
        timestamp: Date.now(),
        lastEvent: "bad",
        resourceClaims: [],
        verificationState: "unknown",
        hasMutatingWrite: true,
      };

      await expect(writeJobCheckpoint(maliciousCheckpoint)).rejects.toThrow(/Invalid canonical jobId/);
    });

    it("readJobCheckpoint returns null for invalid job IDs without throwing", async () => {
      const result = await readJobCheckpoint("../../../outside");
      expect(result).toBeNull();
    });
  });
});
