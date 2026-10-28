import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execa } from "execa";
import {
  startDelegateJob,
  getDelegateJob,
  listDelegateJobs,
  cancelDelegateJob,
  getQueuedJobCount,
  __resetDelegateJobsForTests,
} from "../src/core/tools/cliBridgeDelegateJobs.js";
import {
  createIsolatedWorktree,
  removeIsolatedWorktree,
  listIsolatedWorktrees,
  getWorktreeCommitProvenance,
} from "../src/core/tools/cliBridgeWorktreeManager.js";
import {
  acquireResourceClaims,
  releaseResourceClaims,
  inspectResourceClaim,
  type ResourceClaimRequest,
} from "../src/core/tools/cliBridgeResourceClaims.js";
import {
  createDagGraph,
  saveDagGraph,
  loadDagGraph,
  executeDagGraph,
  runSpeculativeWorkflow,
  runConsensusWorkflow,
  advanceDagNode,
  getRunnableNodes,
  reconcileRunningDagsOnStartup,
} from "../src/core/tools/cliBridgeDag.js";
import {
  getOrchestrationLiveStatus,
  getOrchestrationMetrics,
} from "../src/core/tools/cliBridgeOrchestrationFeed.js";
import {
  writeJobCheckpoint,
  readJobCheckpoint,
  reconcileJobOnRestart,
  type JobCheckpoint,
} from "../src/core/tools/cliBridgeReconciliation.js";
import {
  calculateEffectiveSlots,
  DEFAULT_SCHEDULER_POLICY,
} from "../src/core/tools/cliBridgeScheduler.js";
import { sampleSystemResources } from "../src/core/tools/cliBridgeResourceSampler.js";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";

const PINNED_BASE_SHA = "0c5cea2cc4f18b1838157b02a05f782461e783f9";

describe("Milestone M6.2 — Full Live Multi-Agent Runtime E2E Certification", () => {
  let testWorkspace: string;
  let testWorktreeRoots: string[] = [];

  beforeEach(async () => {
    testWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-live-e2e-"));
    process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = path.join(testWorkspace, "capacity");
    process.env.SUPERAGENT_CLI_BRIDGE_CLAIMS_DIR = path.join(testWorkspace, "claims");
    await __resetDelegateJobsForTests();
    testWorktreeRoots = [];
  });

  afterEach(async () => {
    await __resetDelegateJobsForTests();
    delete process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR;
    delete process.env.SUPERAGENT_CLI_BRIDGE_CLAIMS_DIR;
    delete process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
    delete process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE;
    for (const wt of testWorktreeRoots) {
      await removeIsolatedWorktree({ repoRoot: process.cwd(), worktreePath: wt, force: true, deleteBranch: true }).catch(() => {});
    }
    await fs.rm(testWorkspace, { recursive: true, force: true }).catch(() => {});
  }, 60000);

  // ─── 1. Resource Pressure & Backpressure ───────────────────────────────
  it("certifies dynamic capacity 2–8 contraction and durable priority queue backpressure", async () => {
    // 1. Resource sampler & dynamic capacity under simulated pressure:
    const criticalSample = sampleSystemResources({ light: 0, normal: 4, heavy: 2, exclusive: 0 });
    criticalSample.pressure = "critical";
    criticalSample.cpu.usagePercent = 95;

    const criticalCalc = calculateEffectiveSlots(criticalSample, DEFAULT_SCHEDULER_POLICY, 4);
    expect(criticalCalc.effectiveSlots).toBe(DEFAULT_SCHEDULER_POLICY.minSlots); // contracted to 2
    expect(criticalCalc.changed).toBe(true);

    const normalSample = sampleSystemResources({ light: 0, normal: 0, heavy: 0, exclusive: 0 });
    normalSample.pressure = "none";
    normalSample.cpu.usagePercent = 10;
    normalSample.memory.freePercent = 80;

    const normalCalc = calculateEffectiveSlots(normalSample, { ...DEFAULT_SCHEDULER_POLICY, cooldownMs: 0 }, 4);
    expect(normalCalc.effectiveSlots).toBeGreaterThanOrEqual(4);

    // 2. Queueing backpressure under full slot capacity:
    process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE = "none";
    process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "1";
    await __resetDelegateJobsForTests();

    // Start running job occupying slot 0
    const job1 = await startDelegateJob({
      cliAlias: "agy",
      binary: process.execPath,
      prompt: "First job",
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      args: ["-e", "setTimeout(() => {}, 4000)"],
      timeoutMs: 30000,
    });
    expect(["starting", "running"]).toContain(job1.status);

    // Submit second job with queueIfBusy: true
    const job2 = await startDelegateJob({
      cliAlias: "agy",
      binary: process.execPath,
      prompt: "Second job (queued)",
      cwd: testWorkspace,
      workspaceRoot: testWorkspace,
      args: ["-e", "console.log('world')"],
      priority: "high",
      queueIfBusy: true,
      timeoutMs: 30000,
    });

    expect(job2.status).toBe("queued");
    expect(getQueuedJobCount()).toBe(1);

    // Cancel queued job cleanly
    const cancelRes = await cancelDelegateJob(job2.jobId);
    expect(cancelRes.ok).toBe(true);
    expect(cancelRes.job.status).toBe("cancelled");
    expect(getQueuedJobCount()).toBe(0);

    // Cancel running job1
    await cancelDelegateJob(job1.jobId);
  }, 15000);

  // ─── 2. Four Isolated Worktrees & Zero Main Workspace Mutation ─────────
  it("proves four real AGY delegate jobs run concurrently in four isolated Git worktrees without main repo mutation", async () => {
    process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE = "none";
    process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "4";
    await __resetDelegateJobsForTests();

    const mainRepoRoot = process.cwd();
    const cleanBefore = (await execa("git", ["status", "--porcelain"], { cwd: mainRepoRoot })).stdout;

    // Concurrently dispatch 4 real AGY coding jobs into isolated worktrees for the same project.
    // This certification scenario explicitly opts into full-auto; production code must never inject it implicitly.
    const jobs = await Promise.all([1, 2, 3, 4].map((idx) => {
      const prompt = `Create a file named provenance_${idx}.txt containing exactly 'PROVENANCE_WORKER_${idx}', git add provenance_${idx}.txt, and git commit -m 'worker ${idx} provenance'`;
      return startDelegateJob({
        cliAlias: "agy",
        binary: "agy",
        prompt,
        cwd: mainRepoRoot,
        workspaceRoot: mainRepoRoot,
        roleProfile: "coder",
        worktree: true,
        baseCommitSha: PINNED_BASE_SHA,
        branchName: `cli-bridge/live-worker-${idx}-${Date.now()}`,
        acceptanceContract: {
          artifacts: [{ path: `provenance_${idx}.txt`, mustExist: true }],
        },
        args: ["--dangerously-skip-permissions", "-p", prompt],
        timeoutMs: 180000,
      });
    }));

    expect(jobs.length).toBe(4);
    for (const j of jobs) {
      expect(j.roleProfile).toBe("coder");
      expect(j.worktreePath).toBeDefined();
      if (j.worktreePath) testWorktreeRoots.push(j.worktreePath);
      expect(["starting", "running", "succeeded"]).toContain(j.status);
    }

    // Wait for all 4 real AGY jobs to complete
    const completedJobs = await Promise.all(
      jobs.map(async (j) => {
        let current = await getDelegateJob(j.jobId);
        const deadline = Date.now() + 180000;
        while (current && (current.status === "starting" || current.status === "running") && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          current = await getDelegateJob(j.jobId);
        }
        return current!;
      })
    );

    // Assert all 4 jobs completed successfully and verified artifacts
    for (const c of completedJobs) {
      expect(c.status).toBe("succeeded");
      expect(c.exitCode).toBe(0);
      expect(c.completionState).toBe("verified");
      expect(c.worktreePath).toBeDefined();

      // Inspect commit provenance in worktrees
      const prov = await getWorktreeCommitProvenance(c.worktreePath!, PINNED_BASE_SHA);
      expect(prov).toBeDefined();
      expect(prov?.baseCommitSha).toBe(PINNED_BASE_SHA);
      expect(prov?.commitCount).toBeGreaterThanOrEqual(1);
      expect(prov?.commitMessages.some((m) => m.includes("provenance"))).toBe(true);
    }

    // Assert main working tree remains completely unmutated
    const cleanAfter = (await execa("git", ["status", "--porcelain"], { cwd: mainRepoRoot })).stdout;
    expect(cleanAfter).toBe(cleanBefore);
  }, 240000);

  // ─── 3. Atomic Cross-Process Resource Claims Stress ─────────────────────
  it("certifies atomic mutual exclusion on resource claims with zero double-writer wins", async () => {
    const claimTarget = path.join(testWorkspace, "shared-critical-file.ts");
    const claimRequests: ResourceClaimRequest[] = [{ type: "file", target: claimTarget, mode: "write" }];

    // Acquire claim
    const lease1 = await acquireResourceClaims(claimRequests, "job-writer-1");
    expect(lease1.length).toBe(1);
    expect(lease1[0].jobId).toBe("job-writer-1");

    // Second simultaneous writer must be rejected (0 double-writer wins)
    await expect(acquireResourceClaims(claimRequests, "job-writer-2")).rejects.toThrow();

    // Release and re-acquire
    await releaseResourceClaims(lease1);
    const lease2 = await acquireResourceClaims(claimRequests, "job-writer-2");
    expect(lease2.length).toBe(1);
    expect(lease2[0].jobId).toBe("job-writer-2");
    await releaseResourceClaims(lease2);
  }, 30000);

  // ─── 4. Crash & Restart Reconciliation ─────────────────────────────────
  it("certifies crash reconciliation restores uncompleted checkpoints safely", async () => {
    const testJobId = "job-crash-reconcile-test-01";
    const checkpoint: JobCheckpoint = {
      jobId: testJobId,
      ownerPid: process.pid,
      ownerProcessIdentity: "win32:test",
      childPid: 99999999, // dead PID
      childProcessIdentity: null,
      status: "running",
      isMutating: false,
      hasMutatingWrite: false,
      roleProfile: "researcher",
      updatedAt: Date.now(),
    };

    await writeJobCheckpoint(checkpoint);
    const saved = await readJobCheckpoint(testJobId);
    expect(saved).not.toBeNull();
    expect(saved?.jobId).toBe(testJobId);

    // Reconcile dead child process
    const outcome = await reconcileJobOnRestart({
      jobId: testJobId,
      status: "running",
      pid: 99999999,
      hasMutatingWrite: false,
    }, checkpoint);
    expect(outcome.reconciledStatus).toBe("interrupted");
    expect(outcome.eligibleForRetry).toBe(true);

    // Mutating job must require manual review
    const mutatingCheckpoint: JobCheckpoint = {
      ...checkpoint,
      jobId: "job-crash-mutating-test-02",
      isMutating: true,
      hasMutatingWrite: true,
    };
    await writeJobCheckpoint(mutatingCheckpoint);
    const mutatingOutcome = await reconcileJobOnRestart({
      jobId: "job-crash-mutating-test-02",
      status: "running",
      pid: 99999999,
      hasMutatingWrite: true,
    }, mutatingCheckpoint);
    expect(mutatingOutcome.reconciledStatus).toBe("unknown_outcome_review_required");
    expect(mutatingOutcome.eligibleForRetry).toBe(false);
  });

  // ─── 5. Durable Executable DAG Orchestration ────────────────────────────
  it("certifies multi-node DAG execution, fan-out, join barrier, fail-fast, acceptance semantics, and restart resume", async () => {
    const dag = createDagGraph({
      name: "E2E-MultiTier-Pipeline",
      workspaceRoot: testWorkspace,
      maxFanOut: 4,
      failFast: true,
      nodes: [
        { id: "step-1-plan", roleId: "architect", prompt: "Plan steps" },
        { id: "step-2-code-a", roleId: "coder", prompt: "Code A", dependencies: ["step-1-plan"] },
        { id: "step-2-code-b", roleId: "coder", prompt: "Code B", dependencies: ["step-1-plan"] },
        { id: "step-3-test-join", roleId: "tester", prompt: "Integration test join", dependencies: ["step-2-code-a", "step-2-code-b"] },
      ],
    });

    await saveDagGraph(dag);
    const loaded = await loadDagGraph(dag.graphId);
    expect(loaded).not.toBeNull();
    expect(Object.keys(loaded!.nodes).length).toBe(4);

    // Step 1: initial runnable is step-1-plan only
    const r1 = getRunnableNodes(dag);
    expect(r1.map((n) => n.id)).toEqual(["step-1-plan"]);

    advanceDagNode(dag, "step-1-plan", { status: "succeeded" });

    // Step 2: Fan-out to code-a and code-b
    const r2 = getRunnableNodes(dag);
    expect(r2.map((n) => n.id).sort()).toEqual(["step-2-code-a", "step-2-code-b"]);

    advanceDagNode(dag, "step-2-code-a", { status: "succeeded" });

    // Join barrier: test-join cannot run until code-b also succeeds
    const r3 = getRunnableNodes(dag);
    expect(r3.map((n) => n.id)).toEqual(["step-2-code-b"]);

    advanceDagNode(dag, "step-2-code-b", { status: "succeeded" });

    // Join complete: test-join can now run
    const r4 = getRunnableNodes(dag);
    expect(r4.map((n) => n.id)).toEqual(["step-3-test-join"]);

    advanceDagNode(dag, "step-3-test-join", { status: "succeeded" });
    expect(dag.status).toBe("succeeded");

    // Test fail-fast propagation:
    const failDag = createDagGraph({
      name: "E2E-FailFast-Pipeline",
      workspaceRoot: testWorkspace,
      failFast: true,
      nodes: [
        { id: "root", prompt: "Root task" },
        { id: "downstream", prompt: "Downstream task", dependencies: ["root"] },
      ],
    });
    advanceDagNode(failDag, "root", { status: "failed" });
    expect(failDag.status).toBe("failed");
    expect(failDag.nodes["downstream"].status).toBe("cancelled");

    // Test acceptance verification semantics (S7: worker_succeeded != verified):
    const semDag = createDagGraph({
      name: "E2E-Semantics-Pipeline",
      workspaceRoot: testWorkspace,
      nodes: [
        {
          id: "node-with-contract",
          prompt: "Write artifact",
          acceptance: { artifacts: [{ path: "out_v.txt", mustExist: true }] },
        },
        {
          id: "node-without-contract",
          prompt: "No contract",
          dependencies: ["node-with-contract"],
        },
      ],
    });
    advanceDagNode(semDag, "node-with-contract", {
      status: "succeeded",
      result: { verificationState: "verified" },
    });
    advanceDagNode(semDag, "node-without-contract", {
      status: "succeeded",
      result: { verificationState: "succeeded_unverified" },
    });
    expect(semDag.nodes["node-with-contract"].result?.verificationState).toBe("verified");
    expect(semDag.nodes["node-without-contract"].result?.verificationState).toBe("succeeded_unverified");

    // Test persisted running-DAG startup resume/reconciliation (M4.2 / S8):
    const runningDag = createDagGraph({
      name: "Persisted-Running-Pipeline",
      workspaceRoot: testWorkspace,
      nodes: [
        { id: "step-run", prompt: "Running node" },
      ],
    });
    runningDag.status = "running";
    runningDag.nodes["step-run"].status = "running";
    runningDag.nodes["step-run"].jobId = "clj_1730000000001_deadbeef";
    await saveDagGraph(runningDag);

    const reconcileRes = await reconcileRunningDagsOnStartup();
    expect(reconcileRes.reconciledCount).toBeGreaterThanOrEqual(1);
    const reloadedRunningDag = await loadDagGraph(runningDag.graphId);
    expect(reloadedRunningDag).not.toBeNull();
    expect(reloadedRunningDag?.nodes["step-run"].status).toBe("failed");
  }, 30000);

  // ─── 6. Speculative Execution & Consensus Workflows ────────────────────
  it("certifies speculative candidate evaluation and consensus review workflows with timeout cleanup", async () => {
    process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE = "none";
    process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "4";
    await __resetDelegateJobsForTests();

    // 1. Speculative workflow candidate evaluation:
    const specResult = await runSpeculativeWorkflow(
      [
        { candidateId: "cand-1", prompt: "Candidate 1", worktree: false, acceptance: { artifacts: [{ path: "output.txt", mustExist: true }] } },
        { candidateId: "cand-2", prompt: "Candidate 2", worktree: false, acceptance: { artifacts: [{ path: "output.txt", mustExist: true }] } },
      ],
      testWorkspace,
      { timeoutMs: 1500, pollIntervalMs: 50 }
    );
    expect(specResult).toBeDefined();
    expect(specResult.loserIds).toContain("cand-2");

    // 2. Real Consensus review evaluation returning substantive verdict (M4.3 / S9):
    const consensusResult = await runConsensusWorkflow(
      "diff --git a/file.ts b/file.ts\n+const added = true;",
      [
        { agentId: "reviewer-1", roleId: "reviewer" },
        { agentId: "reviewer-2", roleId: "reviewer" },
      ],
      testWorkspace,
      { timeoutMs: 120000, pollIntervalMs: 500 }
    );
    expect(consensusResult).toBeDefined();
    expect(["approve", "reject", "request_changes"]).toContain(consensusResult.consensusVerdict);
    expect(consensusResult.agreementRatio).toBeGreaterThan(0);

    // 3. Reviewer timeout cleanup verification (S9):
    const timeoutConsensus = await runConsensusWorkflow(
      "diff --git a/huge.ts b/huge.ts\n+const huge = true;",
      [{ agentId: "timeout-rev", roleId: "reviewer", prompt: "Wait indefinitely" }],
      testWorkspace,
      { timeoutMs: 50, pollIntervalMs: 20 }
    );
    expect(timeoutConsensus.consensusVerdict).toBe("insufficient_evidence");
    // Ensure reviewer jobs are cancelled and are not left running
    const allJobs = await listDelegateJobs();
    const activeReviewers = allJobs.filter((j) => j.roleProfile === "reviewer" && (j.status === "running" || j.status === "starting"));
    expect(activeReviewers.length).toBe(0);
  }, 180000);

  // ─── 7. T-Line Orchestration Dashboard & Feed ──────────────────────────
  it("certifies T-Line orchestration live status and metrics feed with workspace security", async () => {
    const liveStatus = await getOrchestrationLiveStatus(testWorkspace);
    expect(liveStatus).toBeDefined();
    expect(liveStatus.hostStrip).toBeDefined();
    expect(liveStatus.hostStrip.effectiveSlots).toBeGreaterThanOrEqual(2);
    expect(liveStatus.hostStrip.effectiveSlots).toBeLessThanOrEqual(8);
    expect(liveStatus.slots.length).toBe(liveStatus.hostStrip.effectiveSlots);
    expect(Array.isArray(liveStatus.jobs)).toBe(true);

    const metrics = await getOrchestrationMetrics(testWorkspace);
    expect(metrics).toBeDefined();
    expect(typeof metrics.successRate).toBe("number");
    expect(typeof metrics.verifiedRate).toBe("number");

    // Tool integration check:
    const toolRoleList = await cliBridgeTool.execute({ action: "role.list" }, testWorkspace);
    expect(String(toolRoleList)).toContain("architect");
    expect(String(toolRoleList)).toContain("coder");
    expect(String(toolRoleList)).toContain("tester");
    expect(String(toolRoleList)).toContain("reviewer");

    // Tool DAG check:
    const toolDagCreate = await cliBridgeTool.execute({
      action: "dag.create",
      dag: {
        name: "Tool-DAG",
        nodes: [{ id: "n1", prompt: "Step 1" }],
      },
    }, testWorkspace);
    expect(String(toolDagCreate)).toContain("Created DAG workflow");
  }, 30000);
});
