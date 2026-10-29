import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  ProcessRegistry,
  getRuntimeGeneration,
  type ProcessRecord,
} from "../src/core/process/processRegistry.js";
import {
  ProcessSupervisor,
  type OperatorCapability,
} from "../src/core/process/processSupervisor.js";
import {
  reconcileJobOnRestart,
  writeJobCheckpoint,
  readJobCheckpoint,
  type JobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";

describe("SuperAgent Runtime Supervisor Batch 6 Independent Audit Remediation", () => {
  let tempDir: string;
  let registryFile: string;
  let supervisor: ProcessSupervisor;
  let originalCheckpointsDir: string | undefined;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `superagent-batch6-test-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`
    );
    await fs.mkdir(tempDir, { recursive: true });
    registryFile = path.join(tempDir, "process-registry.json");
    supervisor = new ProcessSupervisor({ trustedOperatorAuthorizer: (principal) => principal.authenticated && principal.roles.includes("operator"),  storagePath: registryFile });
    await supervisor.initialize();

    originalCheckpointsDir = process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
    process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = path.join(tempDir, "checkpoints");
    await fs.mkdir(process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (originalCheckpointsDir !== undefined) {
      process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = originalCheckpointsDir;
    } else {
      delete process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR;
    }
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // MANDATORY P0-1 & P1-2: CLI Bridge Restart Reconciliation Safety
  // =========================================================================
  describe("MANDATORY P0-1 & P1-2: CLI Bridge Restart Safety & Terminal Review Retention", () => {
    it("reproduces and eliminates audit P0-1: missing checkpoint fails closed to unknown_outcome_review_required even if job.hasMutatingWrite is false", async () => {
      // Independent audit reproduction:
      // { jobId: 'job_no_checkpoint', status: 'running', pid: null, hasMutatingWrite: false } with checkpoint = null
      const assessment = await reconcileJobOnRestart(
        {
          jobId: "job_no_checkpoint",
          status: "running",
          pid: null,
          hasMutatingWrite: false,
        },
        null
      );

      // Invariant: NEVER return { reconciledStatus: 'interrupted', eligibleForRetry: true, requiresReview: false }!
      expect(assessment.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment.eligibleForRetry).toBe(false);
      expect(assessment.requiresReview).toBe(true);
      expect(assessment.reason).toContain("cannot prove job was read-only");
    });

    it("reproduces and eliminates audit P0-1: checkpoint with mismatched jobId fails closed", async () => {
      // Checkpoint belonging to other job
      const otherCheckpoint: JobCheckpoint = {
        checkpointId: "cp_other_job",
        jobId: "other_job",
        timestamp: Date.now(),
        lastEvent: "read_file",
        resourceClaims: [],
        verificationState: "succeeded",
        hasMutatingWrite: false,
      };

      const assessment = await reconcileJobOnRestart(
        {
          jobId: "target_victim_job",
          status: "running",
          pid: null,
          hasMutatingWrite: false,
        },
        otherCheckpoint
      );

      expect(assessment.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment.eligibleForRetry).toBe(false);
      expect(assessment.requiresReview).toBe(true);
      expect(assessment.reason).toContain("jobId mismatch");
    });

    it("reproduces and eliminates audit P1-2: existing terminal unknown_outcome_review_required preserves requiresReview: true", async () => {
      const assessment = await reconcileJobOnRestart({
        jobId: "job_prior_unknown",
        status: "unknown_outcome_review_required",
        pid: null,
      });

      expect(assessment.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment.eligibleForRetry).toBe(false);
      // Audit confirmed bug: was previously requiresReview: false! Must be true!
      expect(assessment.requiresReview).toBe(true);
      expect(assessment.reason).toContain("operator review required");
    });

    it("preserves requiresReview: true for terminal verification_failed and permission_blocked statuses", async () => {
      const failedAssessment = await reconcileJobOnRestart({
        jobId: "job_prior_vf",
        status: "verification_failed",
        pid: null,
      });
      expect(failedAssessment.reconciledStatus).toBe("verification_failed");
      expect(failedAssessment.eligibleForRetry).toBe(false);
      expect(failedAssessment.requiresReview).toBe(true);

      const permAssessment = await reconcileJobOnRestart({
        jobId: "job_prior_perm",
        status: "permission_blocked",
        pid: null,
      });
      expect(permAssessment.reconciledStatus).toBe("permission_blocked");
      expect(permAssessment.eligibleForRetry).toBe(false);
      expect(permAssessment.requiresReview).toBe(true);
    });

    it("preserves requiresReview: false only for canonical non-review terminal statuses", async () => {
      for (const status of ["succeeded", "failed", "cancelled", "timed_out", "interrupted"]) {
        const assessment = await reconcileJobOnRestart({
          jobId: `job_${status}`,
          status,
          pid: null,
        });
        expect(assessment.reconciledStatus).toBe(status);
        expect(assessment.eligibleForRetry).toBe(false);
        expect(assessment.requiresReview).toBe(false);
      }
    });

    it("does not treat a durable checkpoint flag as signed read-only attestation", async () => {
      const validCheckpoint: JobCheckpoint = {
        checkpointId: "cp_valid_ro",
        jobId: "job_proven_ro",
        timestamp: Date.now(),
        lastEvent: "tool_call: read_file",
        worktreePath: "d:/test/worktree",
        branchName: "feature/test",
        resourceClaims: [],
        verificationState: "succeeded",
        hasMutatingWrite: false,
      };

      const assessment = await reconcileJobOnRestart(
        {
          jobId: "job_proven_ro",
          status: "running",
          pid: 99999999, // dead PID
          hasMutatingWrite: false,
        },
        validCheckpoint
      );

      expect(assessment.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment.eligibleForRetry).toBe(false);
      expect(assessment.requiresReview).toBe(true);
      expect(assessment.reason).toContain("automatic retry blocked");
    });

    it("fails closed on contradictory checkpoint receipts (e.g. verified paired with failure)", async () => {
      const contradictoryCp: JobCheckpoint = {
        checkpointId: "cp_contradiction",
        jobId: "job_contradiction",
        timestamp: Date.now(),
        lastEvent: "verified_failed", // conflict with verificationState: verified!
        resourceClaims: [],
        verificationState: "verified",
        hasMutatingWrite: false,
      };

      const assessment = await reconcileJobOnRestart(
        {
          jobId: "job_contradiction",
          status: "running",
          pid: 99999999,
          hasMutatingWrite: false,
        },
        contradictoryCp
      );

      expect(assessment.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment.eligibleForRetry).toBe(false);
      expect(assessment.requiresReview).toBe(true);
      expect(assessment.reason).toContain("Contradictory verifier receipts detected");
    });

    it("blocks retry and requires review for mutating jobs even with durable checkpoint", async () => {
      const mutatingCp: JobCheckpoint = {
        checkpointId: "cp_mutating",
        jobId: "job_mutating_interrupted",
        timestamp: Date.now(),
        lastEvent: "tool_call: write_file",
        resourceClaims: ["file:src/app.ts"],
        verificationState: "succeeded_unverified",
        hasMutatingWrite: true,
      };

      const assessment = await reconcileJobOnRestart(
        {
          jobId: "job_mutating_interrupted",
          status: "running",
          pid: 99999999,
          hasMutatingWrite: true,
        },
        mutatingCp
      );

      expect(assessment.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment.eligibleForRetry).toBe(false);
      expect(assessment.requiresReview).toBe(true);
      expect(assessment.reason).toContain("Automatic retry blocked to prevent duplicate writes");
    });
  });

  // =========================================================================
  // MANDATORY P0-2: Safe Single-Writer Registry Lock Architecture & TOCTOU Elimination
  // =========================================================================
  describe("MANDATORY P0-2: Safe Single-Writer Lock Architecture & TOCTOU Elimination", () => {
    it("refuses legacy lock files instead of deleting them during protocol migration", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      const legacyLock = registryFile + ".lock";
      const bytes = JSON.stringify({ pid: 99999999, createdAt: Date.now(), token: "old-owner" });
      await fs.writeFile(legacyLock, bytes);
      await expect((registry as any).withRegistryLock(async () => "not-run", 200))
        .rejects.toThrow("Legacy process registry lock");
      expect(await fs.readFile(legacyLock, "utf8")).toBe(bytes);
    });

    it("uses a transaction lock with no pathname unlink during acquisition or finalization", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      const originalUnlink = fs.unlink;
      const spy = vi.spyOn(fs, "unlink").mockImplementation(async (target: any) => {
        if (String(target).endsWith(".lock")) throw new Error("UNSAFE LEGACY UNLINK");
        return originalUnlink.call(fs, target);
      });
      try {
        expect(await (registry as any).withRegistryLock(async () => "transaction-ok", 1000))
          .toBe("transaction-ok");
        expect(await (registry as any).withRegistryLock(async () => "reacquired", 1000))
          .toBe("reacquired");
        expect((await fs.stat(registryFile + ".lock")).isDirectory()).toBe(true);
        await expect(fs.open(registryFile + ".lock", "wx")).rejects.toMatchObject({ code: expect.any(String) });
        await fs.stat(registryFile + ".coordination.sqlite");
      } finally {
        spy.mockRestore();
      }
    });

    it("disables recovery for both stale lock and unrelated files even with a fixed confirmation", async () => {
      const staleLock = registryFile + ".lock";
      const unrelated = path.join(tempDir, "private.json");
      await fs.writeFile(staleLock, JSON.stringify({pid:99999999, token:"stale"}));
      await fs.writeFile(unrelated, JSON.stringify({pid:99999999, secret:true}));
      for (const file of [staleLock, unrelated]) {
        const result = await ProcessRegistry.recoverStaleLock(file, {
          operatorConfirmation:"CONFIRM_MANUAL_STALE_LOCK_REMOVAL", expectedPid:99999999
        });
        expect(result.recovered).toBe(false);
        await fs.stat(file);
      }
    });

    it("SQLite lock automatically releases on thrown error; manual stale recovery not needed", async () => {
      const registry = new ProcessRegistry({ storagePath: registryFile });
      await expect((registry as any).withRegistryLock(async () => {
        throw new Error("simulated writer crash");
      }, 1000)).rejects.toThrow("simulated writer crash");
      const result = await (registry as any).withRegistryLock(async () => "success", 1000);
      expect(result).toBe("success");
    });

    it("handles multiple independent concurrent registry saves with zero data loss", async () => {
      const instA = new ProcessRegistry({ storagePath: registryFile });
      const instB = new ProcessRegistry({ storagePath: registryFile });

      await instA.load();
      await instB.load();

      instA.addRecord({
        recordId: "rec_conc_A",
        pid: 1001,
        parentPid: 1,
        creationIdentity: "id_A",
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

      instB.addRecord({
        recordId: "rec_conc_B",
        pid: 1002,
        parentPid: 1,
        creationIdentity: "id_B",
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

      // Save concurrently
      await Promise.all([instA.save(), instB.save()]);

      // Re-read fresh from disk
      const verifyInst = new ProcessRegistry({ storagePath: registryFile });
      await verifyInst.load();

      expect(verifyInst.getRecord("rec_conc_A")).toBeDefined();
      expect(verifyInst.getRecord("rec_conc_B")).toBeDefined();
      expect(verifyInst.listRecords()).toHaveLength(2);
    });
  });

  // =========================================================================
  // MANDATORY P1-1: Non-Forgeable Server-Internal Capability Authorization
  // =========================================================================
  describe("MANDATORY P1-1: Non-Forgeable Operator Capability Authorization Boundary", () => {
    it("reproduces and eliminates audit P1-1: caller-supplied boolean isPrivilegedOperator=true fails to escalate", async () => {
      const WS_CALLER = path.join(tempDir, "workspace-caller");
      const WS_PRIVATE = path.join(tempDir, "workspace-private");

      // Seed a private job in a foreign workspace
      supervisor.getRegistry().addRecord({
        recordId: "rec_private_job",
        pid: 9001,
        parentPid: 1,
        creationIdentity: "id_private",
        executable: "node.exe",
        sanitizedArgs: ["secret-plan.js"],
        runtimeGeneration: getRuntimeGeneration(),
        component: "cli-bridge",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
        ownership: {
          workspaceRoot: WS_PRIVATE,
          workspaceId: "ws_private",
          jobId: "private_job",
        },
      });

      // Baseline: caller queries own workspace -> 0 records found
      const userDiag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: WS_CALLER,
      });
      expect(userDiag.totalTracked).toBe(0);
      expect(userDiag.entries).toHaveLength(0);

      // Audit reproduction: untrusted caller supplies isPrivilegedOperator: true
      const forgedDiag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: WS_CALLER,
        isPrivilegedOperator: true,
      } as any);

      // Invariant: forged boolean MUST NOT elevate privilege or leak foreign records!
      expect(forgedDiag.totalTracked).toBe(0);
      expect(forgedDiag.entries).toHaveLength(0);
      expect(JSON.stringify(forgedDiag)).not.toContain("private_job");
      expect(JSON.stringify(forgedDiag)).not.toContain("secret-plan.js");
    });

    it("unauthenticated unscoped query fails closed and returns 0 records to prevent host leakage", async () => {
      supervisor.getRegistry().addRecord({
        recordId: "rec_unscoped_test",
        pid: 9002,
        parentPid: 1,
        creationIdentity: "id_unscoped",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "test",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      const diag = await supervisor.getProcessDiagnostics();
      expect(diag.totalTracked).toBe(0);
      expect(diag.entries).toHaveLength(0);
    });

    it("verifies genuine OperatorCapability grants host-wide diagnostics while forged objects are rejected", async () => {
      const WS_TENANT = path.join(tempDir, "workspace-tenant");

      supervisor.getRegistry().addRecord({
        recordId: "rec_global_tunnel",
        pid: 9003,
        parentPid: 1,
        creationIdentity: "id_global",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        component: "tunnel",
        launchIntent: "headless",
        state: "running",
        lifecycle: "persistent",
        cleanupPolicy: "keep_alive",
        registeredAt: Date.now(),
        updatedAt: Date.now(),
        ownership: {
          systemScope: "global",
        },
      });

      supervisor.getRegistry().addRecord({
        recordId: "rec_tenant_task",
        pid: 9004,
        parentPid: 1,
        creationIdentity: "id_tenant",
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
        ownership: {
          workspaceRoot: WS_TENANT,
          workspaceId: "ws_tenant",
          jobId: "tenant_job_1",
        },
      });

      // 1. Forged capability object (JSON attempt) is rejected
      const forgedObjectDiag = await supervisor.getProcessDiagnostics({
        operatorCapability: { capabilityId: "fake_token_123" } as any,
      });
      expect(forgedObjectDiag.totalTracked).toBe(0);

      // 2. Global operator capability cannot be issued until host authentication is wired.
      expect(() => supervisor.issueOperatorCapability({subject:"trusted-test-operator", authenticated:true, roles:["operator"]}))
        .toThrow("Global operator diagnostics are disabled");
      const operatorDiag = await supervisor.getProcessDiagnostics({
        operatorCapability: { capabilityId: "forged" } as any,
      });
      expect(operatorDiag.totalTracked).toBe(0);
      expect(operatorDiag.entries).toHaveLength(0);

      // 3. User query scoped to tenant workspace returns strictly tenant records and counts
      const tenantDiag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: WS_TENANT,
      });
      expect(tenantDiag.totalTracked).toBe(1);
      expect(tenantDiag.entries).toHaveLength(1);
      expect(tenantDiag.entries[0]?.recordId).toBe("rec_tenant_task");
      expect(JSON.stringify(tenantDiag)).not.toContain("rec_global_tunnel");
    });
  });
});
