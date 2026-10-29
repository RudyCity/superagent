import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
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
      const supervisor = new ProcessSupervisor({ trustedOperatorAuthorizer: (principal) => principal.authenticated && principal.roles.includes("operator"),  storagePath: registryFile });
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

      // User-scoped diagnostics query strictly omits ownerless/foreign records (P1 #4)
      const scopedDiag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: WS_A,
      });
      expect(scopedDiag.totalTracked).toBe(0);
      expect(scopedDiag.entries).toHaveLength(0);
      expect(JSON.stringify(scopedDiag)).not.toContain("private_ownerless_job");

      // Privileged operator query surfaces the ownerless record (P1-1)
      const cap = supervisor.issueOperatorCapability({subject:"trusted-test-operator", authenticated:true, roles:["operator"]});
      const operatorDiag = await supervisor.getProcessDiagnostics({
        operatorCapability: cap,
      });
      expect(operatorDiag.totalTracked).toBe(1);
      expect(operatorDiag.entries).toHaveLength(1);
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
      const supervisor = new ProcessSupervisor({ trustedOperatorAuthorizer: (principal) => principal.authenticated && principal.roles.includes("operator"),  storagePath: registryFile });
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

      // Unauthenticated / unscoped user query returns 0 to prevent leakage
      const unscopedUserDiag = await supervisor.getProcessDiagnostics();
      expect(unscopedUserDiag.totalTracked).toBe(0);
      expect(unscopedUserDiag.entries).toHaveLength(0);

      // Authenticated privileged operator diagnostics: surfaces both with clear systemScope (P1-1)
      const cap = supervisor.issueOperatorCapability({subject:"trusted-test-operator", authenticated:true, roles:["operator"]});
      const operatorDiag = await supervisor.getProcessDiagnostics({
        operatorCapability: cap,
      });
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
      const supervisor = new ProcessSupervisor({ trustedOperatorAuthorizer: (principal) => principal.authenticated && principal.roles.includes("operator"),  storagePath: registryFile });
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

  // =========================================================================
  // Post-Batch4 Independent Audit Remediation: Windows-Safe Atomic Replacement
  // =========================================================================
  describe("Post-Batch4 Audit Remediation: Windows-Safe Atomic Replacement Without Destructive Unlink", () => {
    it("fails closed when rename encounters EPERM/EEXIST after retries: original file intact, no lost records, temp file cleaned up", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "rec_initial_1",
        pid: 7001,
        parentPid: 1,
        creationIdentity: "id_1",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "task",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });
      registry.addRecord({
        recordId: "rec_initial_2",
        pid: 7002,
        parentPid: 1,
        creationIdentity: "id_2",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "task",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Initial save succeeds
      await registry.save();
      expect(await fs.readFile(registryFile, "utf8")).toContain("rec_initial_1");
      expect(await fs.readFile(registryFile, "utf8")).toContain("rec_initial_2");

      // Add a third record
      registry.addRecord({
        recordId: "rec_new_3",
        pid: 7003,
        parentPid: 1,
        creationIdentity: "id_3",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "task",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Mock fs.rename to simulate Windows EPERM / EEXIST locking failure
      const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async () => {
        const err: any = new Error("EPERM: operation not permitted, rename");
        err.code = "EPERM";
        throw err;
      });

      try {
        await expect(registry.save()).rejects.toThrow(
          /Failed to atomically replace process registry.*Fail-closed with original registry intact/
        );

        // Verification: The original file MUST be completely intact!
        const onDiskRaw = await fs.readFile(registryFile, "utf8");
        const onDisk = JSON.parse(onDiskRaw);
        expect(onDisk.records.length).toBe(2);
        expect(onDisk.records.map((r: any) => r.recordId)).toEqual(["rec_initial_1", "rec_initial_2"]);

        // Verification: No temp files left in directory
        const files = await fs.readdir(tmpDir);
        const tempFiles = files.filter((f) => f.startsWith(".tmp.proc_reg"));
        expect(tempFiles.length).toBe(0);
      } finally {
        renameSpy.mockRestore();
      }

      // After restoring rename, saving succeeds cleanly with all 3 records
      await registry.save();
      const updatedRaw = await fs.readFile(registryFile, "utf8");
      const updated = JSON.parse(updatedRaw);
      expect(updated.records.length).toBe(3);
    });
  });

  // =========================================================================
  // Post-Batch4 Independent Audit Remediation: Lock Safety & TOCTOU Prevention
  // =========================================================================
  describe("Post-Batch4 Audit Remediation: Lock Safety & TOCTOU Race Prevention", () => {
    it("SQLite transaction lock is released after an operation error without deleting a lock path", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      await expect((registry as any).withRegistryLock(async () => {
        throw new Error("injected operation failure");
      }, 1000)).rejects.toThrow("injected operation failure");
      expect(await (registry as any).withRegistryLock(async () => "recovered", 1000)).toBe("recovered");
      await expect(fs.stat(registryFile + ".lock")).rejects.toThrow();
      await fs.stat(registryFile + ".coordination.sqlite");
    });

    it("stale-lock recovery does NOT delete an active replacement lock by race (TOCTOU)", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "rec_toctou_1",
        pid: 8002,
        parentPid: 1,
        creationIdentity: "id_toctou",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "task",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      const lockPath = `${registryFile}.lock`;

      // Seed a stale lock metadata (dead PID)
      const staleData = {
        pid: 999999, // guaranteed non-existent PID
        createdAt: Date.now() - 20_000,
        token: "stale_token_original",
      };
      await fs.writeFile(lockPath, JSON.stringify(staleData), "utf8");

      // Simulate a concurrent process that acquired the lock with a new token
      // right after Process A read the stale metadata, before unlinking:
      let readCount = 0;
      const activeReplacementData = {
        pid: process.pid,
        createdAt: Date.now(),
        token: "active_replacement_token_brand_new",
      };

      const origReadFile = fs.readFile;
      const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (targetPath: any, ...rest: any[]) => {
        if (String(targetPath) === lockPath) {
          readCount++;
          if (readCount === 1) {
            // First read: returns the stale data
            return JSON.stringify(staleData);
          } else {
            // Second read (verification read inside TOCTOU guard): returns active replacement!
            // Also write it to disk so if anyone attempts to unlink, it would delete the replacement
            await origReadFile.call(fs, targetPath, ...rest).catch(() => {});
            return JSON.stringify(activeReplacementData);
          }
        }
        return (origReadFile as any).call(fs, targetPath, ...rest);
      });

      // Write active replacement to disk as well
      await fs.writeFile(lockPath, JSON.stringify(activeReplacementData), "utf8");

      // Attempt save with very short timeout to observe behavior under contention
      try {
        await (registry as any).withRegistryLock(async () => "done", 200);
      } catch (err: any) {
        expect(err.message).toContain("Legacy process registry lock");
      } finally {
        readSpy.mockRestore();
      }

      // Assert that the active replacement lock file on disk was NOT deleted by stale-lock recovery!
      const finalLockContent = await fs.readFile(lockPath, "utf8");
      const parsedFinal = JSON.parse(finalLockContent);
      expect(parsedFinal.token).toBe("active_replacement_token_brand_new");
      expect(parsedFinal.pid).toBe(process.pid);

      // Clean up test lock
      await fs.unlink(lockPath);
    });
  });

  // =========================================================================
  // Post-Batch4 Independent Audit Remediation: Fail-Closed Process Reconciliation
  // =========================================================================
  describe("Post-Batch4 Audit Remediation: Fail-Closed Process Reconciliation", () => {
    it("handles nonexistent terminalObservation (undefined) without misclassifying as definitive failure", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_no_terminal_obs",
        pid: 9001,
        parentPid: 1,
        creationIdentity: "id_9001",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_no_obs_mutating" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: null,
        signal: null,
        registeredAt: Date.now() - 30_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint: JobCheckpoint = {
        checkpointId: "chk_no_obs",
        jobId: "job_no_obs_mutating",
        timestamp: Date.now() - 10_000,
        lastEvent: "tool_execution",
        resourceClaims: [],
        verificationState: "unverified",
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
      expect(assessment?.eligibleForRetry).toBe(false);
    });

    it("handles nonexistent terminalObservation (undefined) on non-mutating job without attestation as manual review", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_no_obs_non_mutating",
        pid: 9002,
        parentPid: 1,
        creationIdentity: "id_9002",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_no_obs_read_only" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: null,
        signal: null,
        registeredAt: Date.now() - 30_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint: JobCheckpoint = {
        checkpointId: "chk_ro",
        jobId: "job_no_obs_read_only",
        timestamp: Date.now() - 10_000,
        lastEvent: "reading_files",
        resourceClaims: [],
        verificationState: "unverified",
        hasMutatingWrite: false,
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
      expect(assessment?.eligibleForRetry).toBe(false);
    });

    it("fails closed on mutating job with nonzero exit: unknown_outcome_review_required, requiresReview: true, eligibleForRetry: false", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_mutating_nonzero",
        pid: 9003,
        parentPid: 1,
        creationIdentity: "id_9003",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_nonzero_mutating" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "failed",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 1,
        terminalObservation: {
          exitCode: 1,
          signal: null,
          observedAt: Date.now(),
        },
        signal: null,
        registeredAt: Date.now() - 30_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint: JobCheckpoint = {
        checkpointId: "chk_nonzero",
        jobId: "job_nonzero_mutating",
        timestamp: Date.now() - 10_000,
        lastEvent: "tool_execution",
        resourceClaims: [],
        verificationState: "unverified",
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

      // Mutating job with nonzero exit MUST require operator review!
      expect(report.mutatingJobsRequiringReview).toBe(1);
      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.reason).toContain("Mutating job exited with nonzero code (1) without authoritative proof of clean rollback");
    });

    it("rejects contradictory receipts (lastEvent: verified_succeeded with verificationState: verifying or verification_failed)", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_contradictory_1",
        pid: 9004,
        parentPid: 1,
        creationIdentity: "id_9004",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_contradictory_1" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 30_000,
        updatedAt: Date.now() - 10_000,
      });

      // Contradiction 1: lastEvent says verified_succeeded, but verificationState is still verifying!
      const contradictoryCheckpoint1: JobCheckpoint = {
        checkpointId: "chk_contra_1",
        jobId: "job_contradictory_1",
        timestamp: Date.now() - 10_000,
        lastEvent: "verified_succeeded",
        resourceClaims: [],
        verificationState: "verifying",
        hasMutatingWrite: true,
      };

      const report1 = await reconcileStartupProcesses(
        registry,
        { callerWorkspaceRoot: WS_A },
        {
          observePid: () => "pid_absent",
          readJobCheckpoint: async () => contradictoryCheckpoint1,
        }
      );

      expect(report1.mutatingJobsRequiringReview).toBe(1);
      const assessment1 = report1.jobAssessments[0];
      expect(assessment1?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment1?.requiresReview).toBe(true);
      expect(assessment1?.reason).toContain("Contradictory verification receipts detected");

      // Contradiction 2: lastEvent says verified_succeeded, but verificationState is verification_failed!
      const contradictoryCheckpoint2: JobCheckpoint = {
        checkpointId: "chk_contra_2",
        jobId: "job_contradictory_1",
        timestamp: Date.now() - 10_000,
        lastEvent: "verified_succeeded",
        resourceClaims: [],
        verificationState: "verification_failed",
        hasMutatingWrite: true,
      };

      const report2 = await reconcileStartupProcesses(
        registry,
        { callerWorkspaceRoot: WS_A },
        {
          observePid: () => "pid_absent",
          readJobCheckpoint: async () => contradictoryCheckpoint2,
        }
      );

      expect(report2.mutatingJobsRequiringReview).toBe(1);
      const assessment2 = report2.jobAssessments[0];
      expect(assessment2?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment2?.requiresReview).toBe(true);
      expect(assessment2?.reason).toContain("Contradictory verification receipts detected");
    });

    it("classifies clean terminal exit with consistent verified receipts as succeeded", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_clean_verified",
        pid: 9005,
        parentPid: 1,
        creationIdentity: "id_9005",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_clean_verified" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 30_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint: JobCheckpoint = {
        checkpointId: "chk_clean",
        jobId: "job_clean_verified",
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
          observePid: () => "pid_absent",
          readJobCheckpoint: async () => checkpoint,
        }
      );

      expect(report.mutatingJobsRequiringReview).toBe(0);
      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("succeeded");
      expect(assessment?.requiresReview).toBe(false);
      expect(assessment?.eligibleForRetry).toBe(false);
    });

    it("classifies non-mutating job failure as failed with requiresReview: false", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_ro_failed",
        pid: 9006,
        parentPid: 1,
        creationIdentity: "id_9006",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_ro_failed" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "failed",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 2,
        signal: null,
        registeredAt: Date.now() - 30_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint: JobCheckpoint = {
        checkpointId: "chk_ro_fail",
        jobId: "job_ro_failed",
        timestamp: Date.now() - 10_000,
        lastEvent: "read_error",
        resourceClaims: [],
        verificationState: "unverified",
        hasMutatingWrite: false,
      };

      const report = await reconcileStartupProcesses(
        registry,
        { callerWorkspaceRoot: WS_A },
        {
          observePid: () => "pid_absent",
          readJobCheckpoint: async () => checkpoint,
        }
      );

      expect(report.mutatingJobsRequiringReview).toBe(0);
      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("failed");
      expect(assessment?.requiresReview).toBe(false);
      expect(assessment?.eligibleForRetry).toBe(false);
    });

    it("classifies mutating job with verified clean rollback as failed with requiresReview: false", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      registry.addRecord({
        recordId: "proc_mutating_rollback",
        pid: 9007,
        parentPid: 1,
        creationIdentity: "id_9007",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_mutating_rollback" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "failed",
        lifecycle: "job",
        cleanupPolicy: "terminate_with_owner",
        exitCode: 1,
        signal: null,
        registeredAt: Date.now() - 30_000,
        updatedAt: Date.now() - 10_000,
      });

      const checkpoint = {
        checkpointId: "chk_rollback",
        jobId: "job_mutating_rollback",
        timestamp: Date.now() - 10_000,
        lastEvent: "failed",
        resourceClaims: [],
        verificationState: "verification_failed",
        hasMutatingWrite: true,
        rollbackState: "verified_clean",
      } as any;

      const report = await reconcileStartupProcesses(
        registry,
        { callerWorkspaceRoot: WS_A },
        {
          observePid: () => "pid_absent",
          readJobCheckpoint: async () => checkpoint,
        }
      );

      expect(report.mutatingJobsRequiringReview).toBe(0);
      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("verification_failed");
      expect(assessment?.requiresReview).toBe(false);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.reason).toContain("verified clean rollback was confirmed");
    });
  });
});
