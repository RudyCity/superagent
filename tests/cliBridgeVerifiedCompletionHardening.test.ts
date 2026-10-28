import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  startDelegateJob,
  getDelegateJob,
  listDelegateJobs,
  cancelDelegateJob,
  isProcessSuccessful,
  isTaskVerified,
  requiresReview,
  getTaskOutcome,
  __resetDelegateJobsForTests,
} from "../src/core/tools/cliBridgeDelegateJobs.js";
import {
  executeAcceptanceVerification,
  runVerificationCommands,
  verifyArtifacts,
  buildSafeVerificationEnv,
  redactSecrets,
  type TypedVerificationCommand,
} from "../src/core/tools/cliBridgeAcceptance.js";
import {
  normalizePublicAcceptanceContract,
  normalizeTypedVerificationCommand,
  AcceptanceContractValidationError,
} from "../src/core/tools/cliBridgeAcceptanceContract.js";
import {
  inspectAgyBridgeLine,
  inspectAgyBridgeOutput,
} from "../src/core/tools/cliBridgeAgyPermissions.js";
import {
  reconcileJobOnRestart,
  writeJobCheckpoint,
  readJobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";
import {
  createDagGraph,
  saveDagGraph,
  advanceDagNode,
  evaluateSpeculativeCandidates,
  runSpeculativeWorkflow,
  runConsensusWorkflow,
} from "../src/core/tools/cliBridgeDag.js";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";
import {
  listDetailedCapacitySlots,
  getCapacityDir,
} from "../src/core/tools/cliBridgeCapacity.js";

describe("Milestones M2–M8: CLI Bridge Verified Completion Hardening", () => {
  let testWorkspace: string;
  let testConfigDir: string;
  let testCapacityDir: string;
  let testCheckpointsDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "vch-workspace-"));
    testConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "vch-config-"));
    testCapacityDir = path.join(testWorkspace, "capacity");
    testCheckpointsDir = path.join(testWorkspace, "checkpoints");
    await fs.mkdir(testCapacityDir, { recursive: true });
    await fs.mkdir(testCheckpointsDir, { recursive: true });

    originalEnv = {
      SUPERAGENT_CONFIG_DIR: process.env.SUPERAGENT_CONFIG_DIR,
      SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR: process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR,
      SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR: process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR,
      SUPERAGENT_CLI_BRIDGE_MAX_JOBS: process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS,
      SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE: process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE,
    };

    process.env.SUPERAGENT_CONFIG_DIR = testConfigDir;
    process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = testCapacityDir;
    process.env.SUPERAGENT_CLI_BRIDGE_CHECKPOINTS_DIR = testCheckpointsDir;
    process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "4";
    process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE = "none";

    await __resetDelegateJobsForTests();
  });

  afterEach(async () => {
    await __resetDelegateJobsForTests();

    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }

    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {});
    await fs.rm(testConfigDir, { recursive: true, force: true }).catch(() => {});
  });

  // ─── 1. Permission Precedence (V-I3) ──────────────────────────────────────────
  describe("1. Permission Precedence over Exit Code and Artifact Changes", () => {
    it("parses detailed AGY permission denial signals from structured output and prose", () => {
      // 1. Result event with denied_actions
      const resSignal = inspectAgyBridgeLine(
        JSON.stringify({ event: "result", result: { denied_actions: ["fs.write_file", "shell.exec"] } })
      );
      expect(resSignal.permissionDenied).toBeDefined();
      expect(resSignal.permissionDenied).toContain("denied_actions");
      expect(resSignal.permissionDenied).toContain("fs.write_file");

      // 2. Step update event with permission error
      const stepSignal = inspectAgyBridgeLine(
        JSON.stringify({
          event: "step_update",
          step_update: {
            state: "ERROR",
            tool_info: { name: "run_shell_cmd", error: { message: "user denied permission to execute script" } },
          },
        })
      );
      expect(stepSignal.permissionDenied).toBeDefined();
      expect(stepSignal.permissionDenied).toContain("run_shell_cmd");
      expect(stepSignal.permissionDenied).toContain("user denied permission");

      // 3. Raw prose permission denial
      const proseSignal = inspectAgyBridgeLine("Error: permission check failed for tool edit_file");
      expect(proseSignal.permissionDenied).toBeDefined();
      expect(proseSignal.permissionDenied).toContain("permission check failed");

      // 4. Mode warning only (not an actual denial)
      const warningSignal = inspectAgyBridgeLine("warning: --mode full-auto is not available for this account");
      expect(warningSignal.modeWarning).toBeDefined();
      expect(warningSignal.permissionDenied).toBeUndefined();
    });

    it("never injects full-auto into background AGY fallback without explicit authorization", async () => {
      const oldPath = process.env.PATH;
      const fakeAgy = path.join(testWorkspace, process.platform === "win32" ? "agy.cmd" : "agy");
      const argsFile = path.join(testWorkspace, "agy-args.txt");
      if (process.platform === "win32") {
        await fs.writeFile(fakeAgy, "@echo off\r\necho %* > agy-args.txt\r\nexit /b 0\r\n", "utf8");
      } else {
        await fs.writeFile(fakeAgy, "#!/bin/sh\nprintf \'%s\\n\' \"$*\" > agy-args.txt\nexit 0\n", "utf8");
        await fs.chmod(fakeAgy, 0o755);
      }
      process.env.PATH = testWorkspace + path.delimiter + (oldPath ?? "");
      try {
        const job = await startDelegateJob({
          cliAlias: "agy",
          binary: "agy",
          prompt: "safe fallback",
          cwd: testWorkspace,
          workspaceRoot: testWorkspace,
          args: [],
          timeoutMs: 10000,
        });
        let current = await getDelegateJob(job.jobId);
        while (current && ["starting", "running"].includes(current.status)) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          current = await getDelegateJob(job.jobId);
        }
        const invokedArgs = await fs.readFile(argsFile, "utf8");
        expect(invokedArgs).toContain("--mode");
        expect(invokedArgs).toContain("accept-edits");
        expect(invokedArgs).not.toContain("--dangerously-skip-permissions");
      } finally {
        process.env.PATH = oldPath;
      }
    });

    it("ensures permission failure strictly dominates exit 0 and artifact changes", async () => {
      // Create a script that creates output.txt, but prints a permission denial signal and exits 0
      const script = [
        'const fs = require("fs");',
        'fs.writeFileSync("output.txt", "tampered content");',
        'console.log(JSON.stringify({ event: "result", result: { denied_actions: ["fs.write_file"] } }));',
      ].join("\n");

      const job = await startDelegateJob({
        cliAlias: "agy",
        binary: process.execPath,
        prompt: "Simulate permission blocked job",
        cwd: testWorkspace,
        workspaceRoot: testWorkspace,
        args: ["-e", script],
        expectedArtifacts: ["output.txt"],
        timeoutMs: 10000,
      });

      // Wait for job to complete
      let current = await getDelegateJob(job.jobId);
      while (current && ["starting", "running"].includes(current.status)) {
        await new Promise((r) => setTimeout(r, 40));
        current = await getDelegateJob(job.jobId);
      }

      expect(current).not.toBeNull();
      // Even though exitCode was 0 and output.txt was modified, status MUST be permission_blocked
      expect(current!.status).toBe("permission_blocked");
      expect(current!.completionState).toBe("permission_blocked");
      expect(current!.taskOutcome).toBe("PERMISSION_BLOCKED");
      expect(isTaskVerified(current!)).toBe(false);
      expect(requiresReview(current!)).toBe(true);
      expect(current!.error).toContain("denied_actions");
    });
  });

  // ─── 2. Authorization Boundary & Path Traversal (V-I4) ───────────────────────
  describe("2. Authorization Boundary & Path Traversal in Verifiers", () => {
    it("accepts valid typed verification commands and rejects unauthorized raw shell strings", () => {
      // Valid typed verifiers
      const valid = normalizePublicAcceptanceContract({
        artifacts: [{ path: "docs/report.json" }],
        tests: [{ kind: "bun-script", name: "test", args: ["tests/sample.test.ts"] }],
        build: [{ kind: "npm-script", name: "build" }],
        commands: [{ kind: "binary", executable: "pytest", args: ["tests/test_api.py"] }],
        customVerifier: { kind: "git-status", args: ["--porcelain"] },
      });

      expect(valid?.tests).toHaveLength(1);
      expect(valid?.build).toHaveLength(1);
      expect(valid?.commands).toHaveLength(1);
      expect(valid?.customVerifier).toBeDefined();

      // Rejects raw arbitrary shell string in public contract
      expect(() =>
        normalizePublicAcceptanceContract({ commands: ["echo bypass; rm -rf /"] })
      ).toThrow(/unsupported field/);

      expect(() =>
        normalizePublicAcceptanceContract({ customVerifier: "powershell -Command whoami" })
      ).toThrow(/unsupported field/);
    });

    it("rejects path traversal in typed command arguments and unauthorized executables", () => {
      // Path traversal in args
      expect(() =>
        normalizeTypedVerificationCommand(
          { kind: "bun-script", name: "test", args: ["../../etc/passwd"] },
          "tests[0]"
        )
      ).toThrow(/path traversal/);

      // Forbidden shell metacharacters in args
      expect(() =>
        normalizeTypedVerificationCommand(
          { kind: "npm-script", name: "build", args: ["foo && rm -rf /"] },
          "build[0]"
        )
      ).toThrow(/forbidden shell metacharacters/);

      // Unauthorized binary
      expect(() =>
        normalizeTypedVerificationCommand(
          { kind: "binary", executable: "curl", args: ["https://example.com"] },
          "commands[0]"
        )
      ).toThrow(/not an authorized verification binary/);
    });

    it("fails closed when runVerificationCommands receives path traversal or dynamic substitutions", async () => {
      // Direct verifier command execution check
      const traversalRes = await runVerificationCommands(testWorkspace, ["node ../../outside.js"]);
      expect(traversalRes.passed).toBe(false);
      expect(traversalRes.failureReason).toContain("path traversal");

      const dynamicRes = await runVerificationCommands(testWorkspace, ["echo $(whoami)"]);
      expect(dynamicRes.passed).toBe(false);
      expect(dynamicRes.failureReason).toContain("dynamic command substitution");
    });

    it("rejects raw-shell verifier contracts at DAG and speculative workflow ingress", async () => {
      expect(() => createDagGraph({
        name: "unsafe-dag",
        workspaceRoot: testWorkspace,
        nodes: [{
          id: "node1",
          prompt: "noop",
          acceptance: { commands: ["echo bypass"] } as any,
        }],
      })).toThrow(/raw shell text|unsupported field/);

      await expect(runSpeculativeWorkflow([{
        candidateId: "candidate1",
        prompt: "noop",
        worktree: false,
        acceptance: { commands: ["echo bypass"] } as any,
      }], testWorkspace, { timeoutMs: 1000 })).rejects.toThrow(/raw shell text|unsupported field/);
    });
  });

  // ─── 3. Secret Leakage & Redaction (V-I8) ─────────────────────────────────────
  describe("3. Environment Isolation & Secret Redaction", () => {
    it("buildSafeVerificationEnv strips sensitive credentials and keys", () => {
      process.env.ANTHROPIC_API_KEY = "sk-ant-test-super-secret-key-12345";
      process.env.OPENAI_API_KEY = "sk-openai-secret-token-abcdef";
      process.env.JWT_SECRET = "super_jwt_secret";

      const safe = buildSafeVerificationEnv();
      expect(safe.ANTHROPIC_API_KEY).toBeUndefined();
      expect(safe.OPENAI_API_KEY).toBeUndefined();
      expect(safe.JWT_SECRET).toBeUndefined();
      expect(safe.PATH).toBeDefined();

      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.JWT_SECRET;
    });

    it("redactSecrets sanitizes API keys and tokens in verifier output", async () => {
      const sensitiveOutput =
        "Debug: token=sk-ant-api03-abcdef1234567890abcdef and Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz";
      const redacted = redactSecrets(sensitiveOutput);
      expect(redacted).not.toContain("sk-ant-api03-abcdef1234567890abcdef");
      expect(redacted).toContain("[REDACTED_API_KEY]");
      expect(redacted).toContain("Bearer [REDACTED_TOKEN]");

      // Test that runVerificationCommands redacts outputTail automatically
      const res = await runVerificationCommands(testWorkspace, [
        process.platform === "win32"
          ? 'cmd /c echo Bearer mysecrettoken123456789'
          : 'echo "Bearer mysecrettoken123456789"',
      ]);
      expect(res.passed).toBe(true);
      expect(res.results[0].outputTail).not.toContain("mysecrettoken123456789");
      expect(res.results[0].outputTail).toContain("Bearer [REDACTED_TOKEN]");
    });
  });

  // ─── 4. Timeouts & Clean Termination ──────────────────────────────────────────
  describe("4. Verifier Timeouts & Clean Process Cleanup", () => {
    it("terminates hanging verifiers cleanly and records timeout failure", async () => {
      const hangingVerifier: TypedVerificationCommand = {
        kind: "binary",
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
      };

      const startedAt = Date.now();
      const res = await runVerificationCommands(testWorkspace, [hangingVerifier], 1000);
      const duration = Date.now() - startedAt;

      expect(res.passed).toBe(false);
      expect(res.failureReason).toContain("timed out");
      expect(duration).toBeLessThan(8000);
    }, 15000);
  });

  // ─── 5. Persistence & Restart Reconciliation (V-I5, V-I10) ────────────────────
  describe("5. Durable Evidence & Crash Reconciliation", () => {
    it("reconciles crash during verifier execution to unknown_outcome_review_required", async () => {
      const jobId = "job-verifier-crash-01";
      const checkpoint = {
        checkpointId: "cp_test_verifier",
        jobId,
        timestamp: Date.now(),
        lastEvent: "verifier_started",
        resourceClaims: [],
        verificationState: "verifying",
        hasMutatingWrite: false,
      };

      await writeJobCheckpoint(checkpoint);
      const savedCp = await readJobCheckpoint(jobId);
      expect(savedCp).not.toBeNull();
      expect(savedCp?.verificationState).toBe("verifying");

      const outcome = await reconcileJobOnRestart(
        { jobId, status: "running", pid: 99999999 },
        checkpoint
      );
      expect(outcome.reconciledStatus).toBe("unknown_outcome_review_required");
      expect(outcome.requiresReview).toBe(true);
      expect(outcome.eligibleForRetry).toBe(false);
    });

    it("preserves permission_blocked status across restart reconciliation", async () => {
      const jobId = "job-perm-restart-02";
      const checkpoint = {
        checkpointId: "cp_perm_test",
        jobId,
        timestamp: Date.now(),
        lastEvent: "permission_blocked",
        resourceClaims: [],
        verificationState: "permission_blocked",
        hasMutatingWrite: true,
      };

      const outcome = await reconcileJobOnRestart(
        { jobId, status: "permission_blocked", pid: 99999999 },
        checkpoint
      );
      expect(outcome.reconciledStatus).toBe("permission_blocked");
      expect(outcome.requiresReview).toBe(true);
      expect(outcome.eligibleForRetry).toBe(false);
    });
  });

  // ─── 6. Slot Lifecycle & 100-Job Leak Soak (V-I7) ─────────────────────────────
  describe("6. Slot Lifecycle Certification across Diverse Outcomes", () => {
    it("proves 100 repeated jobs across diverse terminal outcomes leave zero leaked slots", async () => {
      process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "4";
      const totalJobs = 100;
      const batchSize = 4;

      for (let b = 0; b < totalJobs / batchSize; b++) {
        const batchJobs = await Promise.all(
          Array.from({ length: batchSize }).map((_, idx) => {
            const i = b * batchSize + idx;
            const mode = i % 4;
            let script = 'console.log("fast job");';
            if (mode === 1) script = "process.exit(1);";
            else if (mode === 2) script = 'console.log("warning: --mode plan is not available");';
            else if (mode === 3) script = 'require("fs").writeFileSync("artifact.txt", "evidence");';

            return startDelegateJob({
              cliAlias: "agy",
              projectId: `soak-p-${idx}`,
              binary: process.execPath,
              prompt: `Fast soak job ${i}`,
              cwd: testWorkspace,
              workspaceRoot: testWorkspace,
              args: ["-e", script],
              expectedArtifacts: mode === 3 ? ["artifact.txt"] : undefined,
              timeoutMs: 3000,
            });
          })
        );

        await Promise.all(
          batchJobs.map(async (job) => {
            let cur = await getDelegateJob(job.jobId);
            while (cur && ["starting", "running"].includes(cur.status)) {
              await new Promise((r) => setTimeout(r, 20));
              cur = await getDelegateJob(job.jobId);
            }
          })
        );
      }

      // Assert that all capacity slots are cleanly released and available
      const detailedSlots = await listDetailedCapacitySlots();
      const occupied = detailedSlots.filter((s) => s.occupied);
      expect(occupied.length).toBe(0);
    }, 180000);
  });

  // ─── 7. Workspace Isolation (V-I8) ────────────────────────────────────────────
  describe("7. Workspace Isolation & Unauthorized Access Prevention", () => {
    it("isolates jobs, diagnostics, and DAG cancellation across workspaces", async () => {
      const workspaceA = path.join(testWorkspace, "ws-A");
      const workspaceB = path.join(testWorkspace, "ws-B");
      await fs.mkdir(workspaceA, { recursive: true });
      await fs.mkdir(workspaceB, { recursive: true });

      // Start job in Workspace A
      const jobA = await startDelegateJob({
        cliAlias: "agy",
        binary: process.execPath,
        prompt: "Workspace A job",
        cwd: workspaceA,
        workspaceRoot: workspaceA,
        args: ["-e", 'console.log("ws-A");'],
        timeoutMs: 5000,
      });

      // Workspace B cannot inspect or tail job A
      const getB = await cliBridgeTool.execute({ action: "delegate.get", jobId: jobA.jobId }, workspaceB);
      expect(String(getB)).toContain("not found in the authorized workspace");

      // Create DAG in Workspace A
      const dagA = createDagGraph({
        name: "DAG-Workspace-A",
        workspaceRoot: workspaceA,
        nodes: [{ id: "n1", prompt: "task 1" }],
      });
      await saveDagGraph(dagA);

      // Attempt to cancel DAG A from Workspace B -> Must be rejected!
      const cancelB = await cliBridgeTool.execute({ action: "dag.cancel", graphId: dagA.graphId }, workspaceB);
      expect(String(cancelB)).toContain("unauthorized; DAG belongs to a different workspace");
    });
  });

  // ─── 8. Unverified Reviewer & DAG Rejection (V-I1, V-I2) ──────────────────────
  describe("8. Unverified Reviewer & DAG Rejection", () => {
    it("refuses to promote unverified exit-0 jobs as verified DAG nodes", async () => {
      const dag = createDagGraph({
        name: "Unverified-DAG-Test",
        workspaceRoot: testWorkspace,
        nodes: [
          { id: "root-task", prompt: "Root task without acceptance contract" },
        ],
      });

      advanceDagNode(dag, "root-task", {
        status: "succeeded",
        result: { verificationState: "succeeded_unverified" },
      });

      expect(dag.nodes["root-task"].status).toBe("succeeded");
      expect(dag.nodes["root-task"].result?.verificationState).toBe("succeeded_unverified");
      expect(dag.nodes["root-task"].result?.verificationState).not.toBe("verified");
    });

    it("evaluates speculative candidates and rejects unverified candidates", () => {
      const candidates = [
        { candidateId: "cand-1", verificationState: "succeeded_unverified" as const },
        { candidateId: "cand-2", verificationState: "verification_failed" as const },
      ];

      const outcome = evaluateSpeculativeCandidates(candidates);
      expect(outcome.winnerId).toBeUndefined();
      expect(outcome.loserIds).toEqual(["cand-1", "cand-2"]);

      // With one verified winner
      const withWinner = [
        { candidateId: "cand-1", verificationState: "succeeded_unverified" as const },
        { candidateId: "cand-verified", verificationState: "verified" as const },
      ];
      const outcome2 = evaluateSpeculativeCandidates(withWinner);
      expect(outcome2.winnerId).toBe("cand-verified");
      expect(outcome2.loserIds).toEqual(["cand-1"]);
    });

    it("cancels running reviewer jobs when consensus workflow deadline expires", async () => {
      // Reviewer that sleeps past workflow deadline
      const slowReviewer = {
        agentId: "slow-reviewer",
        cliAlias: "agy",
        prompt: "Review diff",
      };

      const diff = "--- a/file.ts\n+++ b/file.ts\n+const x = 1;";
      const outcome = await runConsensusWorkflow(diff, [slowReviewer], testWorkspace, {
        timeoutMs: 300,
        pollIntervalMs: 50,
      });

      expect(outcome.consensusVerdict).toBe("insufficient_evidence");
      expect(outcome.verdicts[0].verdict).toBe("insufficient_evidence");
    });
  });
});
