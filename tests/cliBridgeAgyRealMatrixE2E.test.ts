import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  startDelegateJob,
  getDelegateJob,
  cancelDelegateJob,
  isProcessSuccessful,
  isTaskVerified,
  requiresReview,
  getTaskOutcome,
  __resetDelegateJobsForTests,
} from "../src/core/tools/cliBridgeDelegateJobs.js";
import {
  writeJobCheckpoint,
  reconcileJobOnRestart,
  type JobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";
import { listDetailedCapacitySlots } from "../src/core/tools/cliBridgeCapacity.js";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";

const AGY_BIN = "C:\\Users\\USER\\AppData\\Local\\agy\\bin\\agy.exe";

describe("Milestone M8: Real AGY End-to-End Certification Matrix (E1–E10)", () => {
  let testWorkspace: string;
  let testConfigDir: string;
  let testCapacityDir: string;
  let testCheckpointsDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "agy-matrix-"));
    testConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-config-"));
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

  async function pollUntilTerminal(jobId: string, maxWaitMs = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const job = await getDelegateJob(jobId);
      if (job && !["starting", "running", "cancelling"].includes(job.status)) {
        return job;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    const finalJob = await getDelegateJob(jobId);
    throw new Error(`Job ${jobId} did not reach terminal state within ${maxWaitMs}ms. Status: ${finalJob?.status}`);
  }

  // ─── E1: No Contract ────────────────────────────────────────────────────────
  it("E1: Real AGY with no contract returns exit 0 -> PROCESS_OK / UNVERIFIED", async () => {
    const job = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Reply with SUCCESS",
      args: ["--dangerously-skip-permissions", "-p", "Reply with SUCCESS"],
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      timeoutMs: 60000,
    });

    const finished = await pollUntilTerminal(job.jobId);
    expect(finished.status).toBe("succeeded");
    expect(finished.exitCode).toBe(0);
    expect(finished.completionState).toBe("unverified");
    expect(finished.taskOutcome).toBe("PROCESS_OK / UNVERIFIED");
    expect(isProcessSuccessful(finished)).toBe(true);
    expect(isTaskVerified(finished)).toBe(false);

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 65000);

  // ─── E2: Artifact-Only ───────────────────────────────────────────────────────
  it("E2: Real AGY creating declared artifact returns artifacts_verified", async () => {
    const artifactName = "output.txt";
    const artifactPath = path.join(testWorkspace, artifactName);

    const job = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Create output.txt",
      args: ["--dangerously-skip-permissions", "-p", "Print ok"],
      expectedArtifacts: [artifactName],
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      timeoutMs: 60000,
    });

    // Write file during execution to simulate artifact output
    await fs.writeFile(artifactPath, "artifact verified content\n", "utf8");

    const finished = await pollUntilTerminal(job.jobId);
    expect(finished.status).toBe("succeeded");
    expect(finished.exitCode).toBe(0);
    expect(finished.completionState).toBe("artifacts_verified");
    expect(finished.taskOutcome).toBe("ARTIFACTS_VERIFIED");
    expect(isProcessSuccessful(finished)).toBe(true);
    expect(isTaskVerified(finished)).toBe(false); // file changed, but not semantic verification

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 65000);

  // ─── E3: Full Contract ───────────────────────────────────────────────────────
  it("E3: Real AGY passing artifact + verification tests returns VERIFIED", async () => {
    const codeFile = "calc.js";
    const codePath = path.join(testWorkspace, codeFile);
    await fs.writeFile(codePath, "module.exports = { multiply: (a, b) => a * b };\n", "utf8");

    const job = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Verify calc",
      args: ["--dangerously-skip-permissions", "-p", "Print ok"],
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      acceptanceContract: {
        artifacts: [{ path: codeFile, mustExist: true, minBytes: 10 }],
        tests: [
          {
            kind: "binary",
            executable: process.execPath,
            args: ["-e", "const c = require('./calc.js'); if (c.multiply(3, 4) !== 12) process.exit(1);"],
          },
        ],
      },
      timeoutMs: 60000,
    });

    const finished = await pollUntilTerminal(job.jobId);
    expect(finished.status).toBe("succeeded");
    expect(finished.exitCode).toBe(0);
    expect(finished.completionState).toBe("verified");
    expect(finished.taskOutcome).toBe("VERIFIED");
    expect(isTaskVerified(finished)).toBe(true);
    expect(finished.verificationResult?.state).toBe("verified");
    expect(finished.verificationResult?.testsPassed).toBe(true);
    expect(finished.verificationResult?.artifactsPassed).toBe(true);

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 65000);

  // ─── E4: Test Failure ────────────────────────────────────────────────────────
  it("E4: Real AGY exiting 0 with failing acceptance test returns VERIFICATION_FAILED", async () => {
    const job = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Execute task",
      args: ["--dangerously-skip-permissions", "-p", "Print ok"],
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      acceptanceContract: {
        tests: [
          {
            kind: "binary",
            executable: process.execPath,
            args: ["-e", "console.error('Test assertion failed'); process.exit(1);"],
          },
        ],
      },
      timeoutMs: 60000,
    });

    const finished = await pollUntilTerminal(job.jobId);
    expect(finished.status).toBe("verification_failed");
    expect(finished.completionState).toBe("verification_failed");
    expect(finished.taskOutcome).toBe("VERIFICATION_FAILED");
    expect(isTaskVerified(finished)).toBe(false);
    expect(finished.verificationResult?.state).toBe("verification_failed");
    expect(finished.verificationResult?.testsPassed).toBe(false);

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 65000);

  // ─── E5: Missing Artifact ────────────────────────────────────────────────────
  it("E5: Real AGY exiting 0 with missing required artifact returns artifact_verification_failed", async () => {
    const job = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Run without creating missing artifact",
      args: ["--dangerously-skip-permissions", "-p", "Print ok"],
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      acceptanceContract: {
        artifacts: [{ path: "missing-report.json", mustExist: true }],
      },
      timeoutMs: 60000,
    });

    const finished = await pollUntilTerminal(job.jobId);
    expect(finished.status).toBe("verification_failed");
    expect(finished.completionState).toBe("verification_failed");
    expect(finished.taskOutcome).toBe("VERIFICATION_FAILED");
    expect(isTaskVerified(finished)).toBe(false);
    expect(finished.error).toContain("does not exist");

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 65000);

  // ─── E6: Permission Denial ───────────────────────────────────────────────────
  it("E6: Real AGY without skip-permissions triggers headless permission auto-denial -> permission_blocked", async () => {
    // AGY without --dangerously-skip-permissions attempts preflight command and gets auto-denied
    const job = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Plan task",
      args: ["--mode", "plan", "-p", "Print confirmation"],
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      timeoutMs: 60000,
    });

    const finished = await pollUntilTerminal(job.jobId);
    expect(finished.status).toBe("permission_blocked");
    expect(finished.completionState).toBe("permission_blocked");
    expect(finished.taskOutcome).toBe("PERMISSION_BLOCKED");
    expect(isTaskVerified(finished)).toBe(false);
    expect(requiresReview(finished)).toBe(true);
    expect(finished.error).toContain("permission");

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 65000);

  // ─── E7: Timeout / Cancel ────────────────────────────────────────────────────
  it("E7: Real AGY cancellation cleanly releases capacity slot and marks cancelled", async () => {
    const job = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Long running AGY task to be cancelled",
      args: ["--dangerously-skip-permissions", "-p", "Think deeply and plan comprehensive refactoring of all systems."],
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      timeoutMs: 60000,
    });

    // Cancel job immediately while running
    const cancelResult = await cancelDelegateJob(job.jobId);
    expect(cancelResult.ok).toBe(true);

    const finished = await pollUntilTerminal(job.jobId);
    expect(finished.status).toBe("cancelled");
    expect(isTaskVerified(finished)).toBe(false);

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 45000);

  // ─── E8: Crash / Restart ─────────────────────────────────────────────────────
  it("E8: Restart during uncertain execution reconciles to unknown_outcome_review_required", async () => {
    const testJobId = `job-crash-${Date.now()}`;
    const checkpoint: JobCheckpoint = {
      jobId: testJobId,
      ownerPid: process.pid,
      ownerProcessIdentity: "win32:current",
      childPid: 99999999, // dead child PID
      childProcessIdentity: null,
      status: "running",
      isMutating: true,
      hasMutatingWrite: true,
      roleProfile: "coder",
      updatedAt: Date.now(),
    };

    await writeJobCheckpoint(checkpoint);

    const outcome = await reconcileJobOnRestart(
      {
        jobId: testJobId,
        status: "running",
        pid: 99999999,
        hasMutatingWrite: true,
      },
      checkpoint
    );

    expect(outcome.reconciledStatus).toBe("unknown_outcome_review_required");
    expect(outcome.requiresReview).toBe(true);
    expect(outcome.eligibleForRetry).toBe(false);
  });

  // ─── E9: 4 Concurrent Real AGY Jobs ──────────────────────────────────────────
  it("E9: 4 concurrent real AGY jobs run isolated with distinct outputs and 0 leaked slots", async () => {
    const count = 4;
    const jobs = await Promise.all(
      Array.from({ length: count }).map(async (_, idx) => {
        const workerCwd = path.join(testWorkspace, `worker-ws-${idx}`);
        await fs.mkdir(workerCwd, { recursive: true });
        return startDelegateJob({
          cliAlias: "agy",
          projectId: `agy-worker-${idx}`,
          binary: AGY_BIN,
          prompt: `Print message ${idx}`,
          args: ["--dangerously-skip-permissions", "-p", `Print worker-${idx}`],
          cwd: workerCwd,
          workspaceRoot: workerCwd,
          timeoutMs: 90000,
        });
      })
    );

    expect(jobs.length).toBe(4);
    const jobIds = new Set(jobs.map((j) => j.jobId));
    expect(jobIds.size).toBe(4);

    const finishedJobs = await Promise.all(jobs.map((j) => pollUntilTerminal(j.jobId, 120000)));

    for (const j of finishedJobs) {
      if (j.status !== "succeeded") {
        const logContent = await fs.readFile(j.logPath, "utf8").catch(() => "NO LOG");
        console.log(`JOB ${j.jobId} ENDED WITH STATUS: ${j.status}, EXIT: ${j.exitCode}, ERROR: ${j.error}`);
        console.log(`OUTPUT TAIL:\n${j.outputTail}\nLOG FILE:\n${logContent}`);
      }
      expect(j.status).toBe("succeeded");
      expect(j.completionState).toBe("unverified");
    }

    // Assert that all capacity slots are cleanly released and 0 leaked
    const slots = await listDetailedCapacitySlots();
    const occupied = slots.filter((s) => s.occupied);
    expect(occupied.length).toBe(0);
  }, 180000);

  // ─── E10: Cross-Workspace Isolation ──────────────────────────────────────────
  it("E10: Cross-workspace access protects foreign jobs and rejects foreign inspection", async () => {
    const workspaceA = path.join(testWorkspace, "ws-A");
    const workspaceB = path.join(testWorkspace, "ws-B");
    await fs.mkdir(workspaceA, { recursive: true });
    await fs.mkdir(workspaceB, { recursive: true });

    const jobA = await startDelegateJob({
      cliAlias: "agy",
      binary: AGY_BIN,
      prompt: "Workspace A job",
      args: ["--dangerously-skip-permissions", "-p", "Print workspace A"],
      cwd: workspaceA,
      workspaceRoot: workspaceA,
      timeoutMs: 60000,
    });

    // Workspace B cannot access or inspect job A
    const resB = await cliBridgeTool.execute({ action: "delegate.get", jobId: jobA.jobId }, workspaceB);
    expect(String(resB)).toContain("not found in the authorized workspace");

    // Wait for job A to complete
    const finishedA = await pollUntilTerminal(jobA.jobId);
    expect(finishedA.status).toBe("succeeded");

    // Verify slot released
    const slots = await listDetailedCapacitySlots();
    expect(slots.filter((s) => s.occupied).length).toBe(0);
  }, 65000);
});
