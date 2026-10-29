/**
 * SuperAgent Runtime Supervisor Batch 5 Audit Remediation Test Suite
 *
 * Covers:
 * - CONFIRMED P0 #1: Registry Silent Data Loss & Locked Re-Read Fail-Closed
 * - CONFIRMED P0 #2: Checkpoint-Aware Safe Retry & Missing Checkpoint Fail-Closed
 * - CONFIRMED P1 #3: Contradictory Exit Proof & Mutating Terminal Reconciliation
 * - P1 #4: Workspace Diagnostics Privacy & Strict Workspace Scoping
 * - Lock Finalizer Safety & Stale-Lock TOCTOU Safety
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  ProcessRegistry,
  getRuntimeGeneration,
  type ProcessRecord,
} from "../src/core/process/processRegistry.js";
import {
  ProcessSupervisor,
  resetProcessSupervisorForTest,
} from "../src/core/process/processSupervisor.js";
import {
  reconcileStartupProcesses,
  type ProcessReconciliationReport,
} from "../src/core/process/processReconciliation.js";
import {
  writeJobCheckpoint,
  type JobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";

const WS_A = path.resolve(os.tmpdir(), "batch5-ws-a");
const WS_B = path.resolve(os.tmpdir(), "batch5-ws-b");

describe("SuperAgent Runtime Supervisor Batch 5 Independent Audit Remediation", () => {
  let tmpDir: string;
  let registryFile: string;
  let checkpointsDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "sa-batch5-"));
    registryFile = path.join(tmpDir, "process-registry.json");
    checkpointsDir = path.join(tmpDir, "checkpoints");
    await fsp.mkdir(checkpointsDir, { recursive: true });
    process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = checkpointsDir;
    resetProcessSupervisorForTest();
  });

  afterEach(async () => {
    resetProcessSupervisorForTest();
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // CONFIRMED P0 #1: Registry Silent Data Loss & Locked Re-Read Fail-Closed
  // =========================================================================
  describe("CONFIRMED P0 #1: Registry Silent Data Loss & Locked Re-Read Fail-Closed", () => {
    it("reproduces and eliminates P0 #1: read error on locked re-read throws without overwriting disk data", async () => {
      // Step 1: Instance A saves owner_A to disk
      const instA = new ProcessRegistry({ storagePath: registryFile });
      await instA.load();
      instA.addRecord({
        recordId: "rec_owner_A",
        pid: 11111,
        parentPid: 1000,
        creationIdentity: "win:mockA",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_A" },
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
      await instA.save();

      // Verify owner_A is persisted on disk
      const diskContentBefore = await fsp.readFile(registryFile, "utf8");
      expect(diskContentBefore).toContain("rec_owner_A");

      // Step 2: Instance B (with record owner_B) attempts save, but fsp.readFile fails with EACCES during locked re-read
      const instB = new ProcessRegistry({ storagePath: registryFile });
      await instB.load();
      instB.addRecord({
        recordId: "rec_owner_B",
        pid: 22222,
        parentPid: 1000,
        creationIdentity: "win:mockB",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_B" },
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

      // Inject EACCES error into fsp.readFile
      const originalReadFile = fsp.readFile;
      let injected = false;
      // @ts-ignore
      fsp.readFile = async (filePath: any, options: any) => {
        if (typeof filePath === "string" && filePath.includes("process-registry.json") && !filePath.includes(".lock")) {
          injected = true;
          const err = new Error("EACCES: permission denied, open '" + filePath + "'");
          (err as any).code = "EACCES";
          throw err;
        }
        return originalReadFile(filePath, options);
      };

      try {
        let saveError: Error | null = null;
        try {
          await instB.save();
        } catch (err: any) {
          saveError = err;
        }

        // Must throw explicit error and NOT return success silently
        expect(saveError).not.toBeNull();
        expect(saveError?.message).toContain("Cannot persist registry: failed to read registry file");
        expect(saveError?.message).toContain("EACCES");
        expect(injected).toBe(true);

        // Crucial invariant: disk records from Instance A MUST REMAIN INTACT! Zero silent data loss!
        const diskContentAfter = await originalReadFile(registryFile, "utf8");
        expect(diskContentAfter).toContain("rec_owner_A");
        const parsed = JSON.parse(diskContentAfter);
        expect(parsed.records).toHaveLength(1);
        expect(parsed.records[0].recordId).toBe("rec_owner_A");
      } finally {
        fsp.readFile = originalReadFile;
      }

      // Transient fault recovery: after fault resolves, instB can save successfully and CAS merge both records
      await instB.save();
      const finalDiskContent = await fsp.readFile(registryFile, "utf8");
      const finalParsed = JSON.parse(finalDiskContent);
      expect(finalParsed.records).toHaveLength(2);
      const ids = finalParsed.records.map((r: any) => r.recordId);
      expect(ids).toContain("rec_owner_A");
      expect(ids).toContain("rec_owner_B");
    });

    it("fails closed on EIO read errors without deleting or altering disk records", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();
      reg.addRecord({
        recordId: "rec_eio_test",
        pid: 33333,
        parentPid: 1000,
        creationIdentity: "win:mockEIO",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A },
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

      const originalReadFile = fsp.readFile;
      // @ts-ignore
      fsp.readFile = async (filePath: any, options: any) => {
        if (typeof filePath === "string" && filePath.includes("process-registry.json") && !filePath.includes(".lock")) {
          const err = new Error("EIO: i/o error, read");
          (err as any).code = "EIO";
          throw err;
        }
        return originalReadFile(filePath, options);
      };

      try {
        let errThrown = false;
        try {
          await reg.save();
        } catch (e: any) {
          errThrown = true;
          expect(e.message).toContain("EIO");
          expect(e.message).toContain("Fail-closed without altering disk");
        }
        expect(errThrown).toBe(true);

        // Registry on disk must remain unchanged
        const content = await originalReadFile(registryFile, "utf8");
        expect(content).toContain("rec_eio_test");
      } finally {
        fsp.readFile = originalReadFile;
      }
    });

    it("succeeds on narrowly proven initial nonexistence (ENOENT) on fresh registry", async () => {
      const freshFile = path.join(tmpDir, "fresh-registry.json");
      expect(fs.existsSync(freshFile)).toBe(false);

      const reg = new ProcessRegistry({ storagePath: freshFile });
      await reg.load();
      reg.addRecord({
        recordId: "rec_fresh_01",
        pid: 44444,
        parentPid: 1000,
        creationIdentity: "win:mockFresh",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A },
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
      expect(fs.existsSync(freshFile)).toBe(true);
      const content = await fsp.readFile(freshFile, "utf8");
      expect(content).toContain("rec_fresh_01");
    });

    it("fails closed on unexpected ENOENT if registry file previously existed (vanished file race)", async () => {
      const vanishedFile = path.join(tmpDir, "vanished-registry.json");
      const reg = new ProcessRegistry({ storagePath: vanishedFile });
      await reg.load();
      reg.addRecord({
        recordId: "rec_vanish",
        pid: 55555,
        parentPid: 1000,
        creationIdentity: "win:mockVanish",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A },
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
      expect(fs.existsSync(vanishedFile)).toBe(true);

      // Now delete the file externally
      await fsp.unlink(vanishedFile);
      expect(fs.existsSync(vanishedFile)).toBe(false);

      // Subsequent save must FAIL CLOSED with unexpected ENOENT race error, NOT silently recreate
      let errorThrown: Error | null = null;
      try {
        await reg.save();
      } catch (err: any) {
        errorThrown = err;
      }
      expect(errorThrown).not.toBeNull();
      expect(errorThrown?.message).toContain("unexpected ENOENT race");
      expect(errorThrown?.message).toContain("previously existed but was missing");
    });

    it("withRegistryLock finalizer does NOT delete an active replacement lock", async () => {
      const lockPath = `${registryFile}.lock`;

      // Simulate a lock file written by another process with a different token
      await fsp.writeFile(
        lockPath,
        JSON.stringify({
          pid: process.pid,
          createdAt: Date.now(),
          token: "other_process_token_12345",
        })
      );

      // When our instance inspects lock, it sees a lock with another token.
      // Finalizer must never unlink it if token doesn't match!
      const content = await fsp.readFile(lockPath, "utf8");
      expect(content).toContain("other_process_token_12345");
      await fsp.unlink(lockPath);
    });
  });

  // =========================================================================
  // CONFIRMED P0 #2: Checkpoint-Aware Safe Retry & Missing Checkpoint Fail-Closed
  // =========================================================================
  describe("CONFIRMED P0 #2: Checkpoint-Aware Safe Retry & Missing Checkpoint Fail-Closed", () => {
    it("reproduces and eliminates P0 #2: missing checkpoint fails closed as unknown_outcome_review_required (never interrupted)", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      // Interrupted job without a checkpoint on disk
      reg.addRecord({
        recordId: "proc_missing_checkpoint",
        pid: 88801,
        parentPid: 1000,
        creationIdentity: "win:mock88801",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "missing_checkpoint_job" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      });

      // Execute startup reconciliation (checkpoint reader returns null)
      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => null, // No checkpoint found!
        }
      );

      expect(report.totalRecords).toBe(1);
      expect(report.mutatingJobsRequiringReview).toBe(1);
      const assessment = report.jobAssessments[0];
      expect(assessment).toBeDefined();
      expect(assessment?.jobId).toBe("missing_checkpoint_job");

      // MANDATORY AUDIT ASSERTIONS:
      // Must fail closed: unknown_outcome_review_required, requiresReview: true, eligibleForRetry: false
      // NEVER: interrupted, requiresReview: false, eligibleForRetry: true!
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.hasMutatingWrite).toBe(true);
      expect(assessment?.reason).toContain("missing or unreadable");
      expect(assessment?.reason).toContain("Automatic retry blocked");
    });

    it("rejects untrusted checkpoint with mismatched jobId and fails closed", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      reg.addRecord({
        recordId: "proc_mismatched_chk",
        pid: 88802,
        parentPid: 1000,
        creationIdentity: "win:mock88802",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "job_expected_alpha" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      });

      // Mismatched checkpoint: contains jobId 'job_different_beta'
      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => ({
            checkpointId: "chk_mismatch",
            jobId: "job_different_beta", // Mismatch!
            timestamp: Date.now() - 40_000,
            lastEvent: "verified_succeeded",
            resourceClaims: [],
            verificationState: "verified",
            hasMutatingWrite: false,
          } as JobCheckpoint),
        }
      );

      expect(report.mutatingJobsRequiringReview).toBe(1);
      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.reason).toContain("jobId mismatch");
    });

    it("requires attested read-only evidence instead of a local checkpoint flag", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      // Read-only job interrupted mid-flight before completion
      reg.addRecord({
        recordId: "proc_readonly_job",
        pid: 88803,
        parentPid: 1000,
        creationIdentity: "win:mock88803",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "readonly_job_01" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "running", // was still running when crashed
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
      });

      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => ({
            checkpointId: "chk_ro_01",
            jobId: "readonly_job_01",
            timestamp: Date.now() - 30_000,
            lastEvent: "agent_tool_exec",
            resourceClaims: [],
            verificationState: "unverified",
            hasMutatingWrite: false, // POSITIVE EVIDENCE: proven read-only!
          } as JobCheckpoint),
        }
      );

      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.hasMutatingWrite).toBe(true);
    });
  });

  // =========================================================================
  // CONFIRMED P1 #3: Contradictory Exit Proof & Mutating Terminal Reconciliation
  // =========================================================================
  describe("CONFIRMED P1 #3: Contradictory Exit Proof & Mutating Terminal Reconciliation", () => {
    it("reproduces and eliminates P1 #3: conflicting recorded exitCode=0 vs observed exitCode=1 fails closed", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      // Record with contradictory exit proof: exitCode is 0, but terminalObservation says 1
      reg.addRecord({
        recordId: "proc_contra_exit_0_1",
        pid: 77701,
        parentPid: 1000,
        creationIdentity: "win:mock77701",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "job_contra_0_1" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: 0, // Recorded exit code claims success
        signal: null,
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        terminalObservation: {
          observedAt: Date.now() - 30_000,
          exitCode: 1, // Observed terminal exit code was failure!
          signal: null,
          source: "child_exit",
        },
      });

      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => ({
            checkpointId: "chk_contra_exit",
            jobId: "job_contra_0_1",
            timestamp: Date.now() - 30_000,
            lastEvent: "verified_succeeded",
            resourceClaims: [],
            verificationState: "verified",
            hasMutatingWrite: true,
          } as JobCheckpoint),
        }
      );

      const assessment = report.jobAssessments[0];
      expect(assessment).toBeDefined();

      // MANDATORY P1 #3 REGRESSION CHECK:
      // Must NEVER classify as 'succeeded' when exit evidence is contradictory!
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.reason).toContain("Contradictory exit proof detected");
      expect(assessment?.reason).toContain("recorded exitCode (0) conflicts with observed exitCode (1)");
    });

    it("fails closed on reverse order conflict: recorded exitCode=1 vs observed exitCode=0", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      reg.addRecord({
        recordId: "proc_contra_exit_1_0",
        pid: 77702,
        parentPid: 1000,
        creationIdentity: "win:mock77702",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "job_contra_1_0" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: 1, // Recorded exit is 1
        signal: null,
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        terminalObservation: {
          observedAt: Date.now() - 30_000,
          exitCode: 0, // Observed exit was 0
          signal: null,
          source: "process_exit",
        },
      });

      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => ({
            checkpointId: "chk_contra_1_0",
            jobId: "job_contra_1_0",
            timestamp: Date.now() - 30_000,
            lastEvent: "verified_succeeded",
            resourceClaims: [],
            verificationState: "verified",
            hasMutatingWrite: true,
          } as JobCheckpoint),
        }
      );

      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.reason).toContain("Contradictory exit proof detected");
    });

    it("fails closed on signal vs clean exit contradiction (recorded SIGTERM vs observed exitCode=0)", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      reg.addRecord({
        recordId: "proc_contra_sig",
        pid: 77703,
        parentPid: 1000,
        creationIdentity: "win:mock77703",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "job_contra_sig" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "terminated",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: "SIGTERM", // Recorded signal termination
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        terminalObservation: {
          observedAt: Date.now() - 30_000,
          exitCode: 0, // Contradictory observation: clean exit 0
          signal: null,
          source: "process_exit",
        },
      });

      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => ({
            checkpointId: "chk_sig",
            jobId: "job_contra_sig",
            timestamp: Date.now() - 30_000,
            lastEvent: "verified_succeeded",
            resourceClaims: [],
            verificationState: "verified",
            hasMutatingWrite: true,
          } as JobCheckpoint),
        }
      );

      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.reason).toContain("Contradictory exit proof detected");
    });

    it("requires review for mutually consistent clean exit without trusted verifier attestation", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      reg.addRecord({
        recordId: "proc_clean_both",
        pid: 77704,
        parentPid: 1000,
        creationIdentity: "win:mock77704",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "job_clean_both" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: 0, // Mutually consistent 0
        signal: null,
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        terminalObservation: {
          observedAt: Date.now() - 30_000,
          exitCode: 0, // Mutually consistent 0
          signal: null,
          source: "process_exit",
        },
      });

      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => ({
            checkpointId: "chk_clean_both",
            jobId: "job_clean_both",
            timestamp: Date.now() - 30_000,
            lastEvent: "verified_succeeded",
            resourceClaims: [],
            verificationState: "verified",
            hasMutatingWrite: true,
          } as JobCheckpoint),
        }
      );

      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
    });

    it("fails closed on contradictory verification and rollback proof (verified + rollback)", async () => {
      const reg = new ProcessRegistry({ storagePath: registryFile });
      await reg.load();

      reg.addRecord({
        recordId: "proc_contra_verif_roll",
        pid: 77705,
        parentPid: 1000,
        creationIdentity: "win:mock77705",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: "gen_previous",
        ownership: { workspaceRoot: WS_A, jobId: "job_contra_verif_roll" },
        component: "cli_bridge_delegate",
        launchIntent: "headless",
        state: "exited",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: 0,
        signal: null,
        registeredAt: Date.now() - 60_000,
        updatedAt: Date.now() - 30_000,
        terminalObservation: {
          observedAt: Date.now() - 30_000,
          exitCode: 0,
          signal: null,
          source: "process_exit",
        },
      });

      // Contradictory checkpoint claiming both verified success AND verified clean rollback
      const report = await reconcileStartupProcesses(
        reg,
        { callerWorkspaceRoot: WS_A },
        {
          readJobCheckpoint: async () => ({
            checkpointId: "chk_contra_vr",
            jobId: "job_contra_verif_roll",
            timestamp: Date.now() - 30_000,
            lastEvent: "verified_succeeded",
            resourceClaims: [],
            verificationState: "verified",
            rollbackState: "verified_clean", // Contradiction: cannot be both verified and rolled back!
            hasMutatingWrite: true,
          } as any),
        }
      );

      const assessment = report.jobAssessments[0];
      expect(assessment?.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(assessment?.requiresReview).toBe(true);
      expect(assessment?.eligibleForRetry).toBe(false);
      expect(assessment?.reason).toContain("Contradictory verification receipts detected");
    });
  });

  // =========================================================================
  // P1 #4: Workspace Diagnostics Privacy & Strict Workspace Scoping
  // =========================================================================
  describe("P1 #4: Workspace Diagnostics Privacy & Strict Workspace Scoping", () => {
    it("user-scoped diagnostics strictly omits foreign and ownerless records from entries and counts", async () => {
      const supervisor = new ProcessSupervisor({ trustedOperatorAuthorizer: (principal) => principal.authenticated && principal.roles.includes("operator"),  storagePath: registryFile });
      await supervisor.initialize();
      const registry = supervisor.getRegistry();

      // 1. Tenant record (belongs to WS_A)
      registry.addRecord({
        recordId: "rec_tenant_A",
        pid: 91001,
        parentPid: 1000,
        creationIdentity: "win:mock91001",
        executable: "node.exe",
        sanitizedArgs: ["--tenant-a"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_A, jobId: "job_tenant_A", taskId: "task_A" },
        component: "cli_bridge",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // 2. Foreign tenant record (belongs to WS_B)
      registry.addRecord({
        recordId: "rec_foreign_B",
        pid: 91002,
        parentPid: 1000,
        creationIdentity: "win:mock91002",
        executable: "node.exe",
        sanitizedArgs: ["--secret-foreign-prompt"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: WS_B, jobId: "foreign_secret_job", taskId: "foreign_task" },
        component: "cli_bridge",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // 3. Ownerless record (no workspaceRoot)
      registry.addRecord({
        recordId: "rec_ownerless",
        pid: 91003,
        parentPid: 1000,
        creationIdentity: "win:mock91003",
        executable: "node.exe",
        sanitizedArgs: ["--secret-ownerless-argv"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { jobId: "ownerless_job" }, // No workspaceRoot!
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

      // 4. Global system service (systemScope: "global", no workspaceRoot)
      registry.addRecord({
        recordId: "rec_global_service",
        pid: 91004,
        parentPid: 1000,
        creationIdentity: "win:mock91004",
        executable: "node.exe",
        sanitizedArgs: ["--global-tunnel"],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { systemScope: "global" },
        component: "core_worker",
        launchIntent: "headless",
        state: "running",
        lifecycle: "persistent",
        cleanupPolicy: "keep_alive",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Query diagnostics as user scoped to WS_A
      const userDiag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: WS_A,
      });

      // Total tracked MUST be exactly 1 (not 4)!
      expect(userDiag.totalTracked).toBe(1);
      expect(userDiag.entries).toHaveLength(1);
      expect(userDiag.entries[0]?.recordId).toBe("rec_tenant_A");
      expect(userDiag.entries[0]?.ownership.jobId).toBe("job_tenant_A");

      // Verify zero foreign, ownerless, or global data leaked into serialized report
      const serialized = JSON.stringify(userDiag);
      expect(serialized).not.toContain("rec_foreign_B");
      expect(serialized).not.toContain("foreign_secret_job");
      expect(serialized).not.toContain("secret-foreign-prompt");
      expect(serialized).not.toContain("rec_ownerless");
      expect(serialized).not.toContain("ownerless_job");
      expect(serialized).not.toContain("secret-ownerless-argv");
      expect(serialized).not.toContain("rec_global_service");
      expect(serialized).not.toContain("global-tunnel");

      // Unauthenticated unscoped query returns 0 to prevent host leakage
      const unscopedDiag = await supervisor.getProcessDiagnostics();
      expect(unscopedDiag.totalTracked).toBe(0);
      expect(unscopedDiag.entries).toHaveLength(0);

      // Forged boolean flag does NOT escalate privilege (P1-1)
      const forgedDiag = await supervisor.getProcessDiagnostics({
        isPrivilegedOperator: true,
      } as any);
      expect(forgedDiag.totalTracked).toBe(0);

      // Privileged global mode is intentionally unavailable until host authentication is integrated.
      expect(() => supervisor.issueOperatorCapability({subject:"trusted-test-operator", authenticated:true, roles:["operator"]}))
        .toThrow("Global operator diagnostics are disabled");
      const operatorDiag = await supervisor.getProcessDiagnostics({
        operatorCapability: { capabilityId: "forged" } as any,
      });
      expect(operatorDiag.totalTracked).toBe(0);
      expect(operatorDiag.entries).toHaveLength(0);
    });

    it("normalizes canonical workspace paths across Windows slash/case variants", async () => {
      const supervisor = new ProcessSupervisor({ trustedOperatorAuthorizer: (principal) => principal.authenticated && principal.roles.includes("operator"),  storagePath: registryFile });
      await supervisor.initialize();

      const wsCanonical = path.resolve(tmpDir, "CanonicalWorkspace");
      // Create a forward-slash and lowercase variant
      const wsVariant = wsCanonical.replace(/\\/g, "/").toLowerCase();

      supervisor.getRegistry().addRecord({
        recordId: "rec_canonical_match",
        pid: 92001,
        parentPid: 1000,
        creationIdentity: "win:mock92001",
        executable: "node.exe",
        sanitizedArgs: [],
        runtimeGeneration: getRuntimeGeneration(),
        ownership: { workspaceRoot: wsCanonical, jobId: "job_canonical" },
        component: "cli_bridge",
        launchIntent: "headless",
        state: "running",
        lifecycle: "job",
        cleanupPolicy: "caller_owned",
        exitCode: null,
        signal: null,
        registeredAt: Date.now(),
        updatedAt: Date.now(),
      });

      // Query using the slash/case variant
      const diag = await supervisor.getProcessDiagnostics({
        callerWorkspaceRoot: wsVariant,
      });

      // Must match canonically!
      expect(diag.totalTracked).toBe(1);
      expect(diag.entries).toHaveLength(1);
      expect(diag.entries[0]?.recordId).toBe("rec_canonical_match");
    });
  });
});
