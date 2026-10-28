import { describe, it, expect } from "vitest";
import {
  evaluateResourcePressure,
  sampleSystemResources,
  type SystemResourceSample,
} from "../src/core/tools/cliBridgeResourceSampler.js";
import {
  calculateEffectiveSlots,
  evaluateJobAdmission,
  calculateJobSchedulingScore,
  CliBridgePriorityQueue,
  type ScheduledJobRequest,
  type SchedulerPolicy,
} from "../src/core/tools/cliBridgeScheduler.js";

describe("Milestone M2 — Dynamic Concurrency and Resource-Aware Scheduling", () => {
  describe("Resource Sampler & Pressure Evaluation (P1.1)", () => {
    it("classifies host resource pressure based on CPU and memory thresholds", () => {
      expect(evaluateResourcePressure(40, 60)).toBe("none");
      expect(evaluateResourcePressure(75, 40)).toBe("moderate");
      expect(evaluateResourcePressure(85, 20)).toBe("high");
      expect(evaluateResourcePressure(95, 20)).toBe("critical");
      expect(evaluateResourcePressure(20, 8)).toBe("critical");
    });

    it("samples system resources with valid structure and metrics", () => {
      const sample = sampleSystemResources({ light: 1, normal: 2, heavy: 0, exclusive: 0 });
      expect(sample.timestamp).toBeGreaterThan(0);
      expect(sample.cpu.cores).toBeGreaterThanOrEqual(1);
      expect(sample.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(sample.cpu.usagePercent).toBeLessThanOrEqual(100);
      expect(sample.memory.totalBytes).toBeGreaterThan(0);
      expect(sample.memory.freeBytes).toBeGreaterThan(0);
      expect(sample.memory.freePercent).toBeGreaterThanOrEqual(0);
      expect(sample.memory.freePercent).toBeLessThanOrEqual(100);
      expect(["none", "moderate", "high", "critical"]).toContain(sample.pressure);
      expect(sample.activeJobs.total).toBe(3);
    });
  });

  describe("Adaptive 2–8 Capacity Calculation (P1.2)", () => {
    const policy: SchedulerPolicy = {
      minSlots: 2,
      maxSlots: 8,
      configuredSlots: 6,
      cooldownMs: 5000,
      perProjectQuota: 3,
      maxHeavyJobs: 1,
    };

    it("immediately contracts slots to minSlots under critical pressure", () => {
      const sample: SystemResourceSample = {
        timestamp: 1000,
        cpu: { cores: 8, loadAverage1m: 6, usagePercent: 95 },
        memory: { totalBytes: 16000, freeBytes: 1000, freePercent: 6, processRssBytes: 200 },
        pressure: "critical",
        activeJobs: { light: 0, normal: 3, heavy: 0, exclusive: 0, total: 3 },
      };

      const res = calculateEffectiveSlots(sample, policy, 6, 0, 1000);
      expect(res.effectiveSlots).toBe(2);
      expect(res.changed).toBe(true);
    });

    it("prevents scaling up if cooldown period has not elapsed (hysteresis)", () => {
      const healthySample: SystemResourceSample = {
        timestamp: 2000,
        cpu: { cores: 8, loadAverage1m: 1, usagePercent: 20 },
        memory: { totalBytes: 16000, freeBytes: 10000, freePercent: 60, processRssBytes: 200 },
        pressure: "none",
        activeJobs: { light: 0, normal: 2, heavy: 0, exclusive: 0, total: 2 },
      };

      // Was contracted to 2 at t = 1000. Now t = 3000 (cooldown is 5000ms)
      const res1 = calculateEffectiveSlots(healthySample, policy, 2, 1000, 3000);
      expect(res1.effectiveSlots).toBe(2);
      expect(res1.changed).toBe(false);

      // Now t = 7000 (> 5000ms cooldown) -> scales up to configuredSlots (6)
      const res2 = calculateEffectiveSlots(healthySample, policy, 2, 1000, 7000);
      expect(res2.effectiveSlots).toBe(6);
      expect(res2.changed).toBe(true);
    });
  });

  describe("Job Admission & Quota Enforcement (P2.2)", () => {
    const policy: SchedulerPolicy = {
      minSlots: 2,
      maxSlots: 8,
      configuredSlots: 4,
      cooldownMs: 5000,
      perProjectQuota: 2,
      maxHeavyJobs: 1,
    };

    it("enforces per-project quota so one project cannot monopolize slots", () => {
      const activeJobs: ScheduledJobRequest[] = [
        { jobId: "j1", projectId: "projA", cliAlias: "agy", priority: "normal", resourceClass: "normal", createdAt: 100 },
        { jobId: "j2", projectId: "projA", cliAlias: "agy", priority: "normal", resourceClass: "normal", createdAt: 200 },
      ];

      // projA requests a 3rd slot (quota is 2)
      const reqA: ScheduledJobRequest = {
        jobId: "j3",
        projectId: "projA",
        cliAlias: "agy",
        priority: "high",
        resourceClass: "normal",
        createdAt: 300,
      };
      const decA = evaluateJobAdmission(reqA, activeJobs, 4, "none", policy);
      expect(decA.admitted).toBe(false);
      expect(decA.reason).toContain("Project quota reached for 'projA'");

      // projB requests a slot (quota is 2, currently 0 active for projB)
      const reqB: ScheduledJobRequest = {
        jobId: "j4",
        projectId: "projB",
        cliAlias: "agy",
        priority: "normal",
        resourceClass: "normal",
        createdAt: 300,
      };
      const decB = evaluateJobAdmission(reqB, activeJobs, 4, "none", policy);
      expect(decB.admitted).toBe(true);
    });

    it("enforces heavy-job limit and exclusive job mutual exclusivity", () => {
      const activeHeavy: ScheduledJobRequest[] = [
        { jobId: "h1", projectId: "projA", cliAlias: "agy", priority: "normal", resourceClass: "heavy", createdAt: 100 },
      ];

      // Second heavy job is rejected
      const reqHeavy: ScheduledJobRequest = {
        jobId: "h2",
        projectId: "projB",
        cliAlias: "agy",
        priority: "normal",
        resourceClass: "heavy",
        createdAt: 200,
      };
      const decHeavy = evaluateJobAdmission(reqHeavy, activeHeavy, 4, "none", policy);
      expect(decHeavy.admitted).toBe(false);
      expect(decHeavy.reason).toContain("Heavy job quota reached");

      // Exclusive job requires all slots to be vacant
      const reqEx: ScheduledJobRequest = {
        jobId: "ex1",
        projectId: "projC",
        cliAlias: "agy",
        priority: "critical",
        resourceClass: "exclusive",
        createdAt: 300,
      };
      const decEx = evaluateJobAdmission(reqEx, activeHeavy, 4, "none", policy);
      expect(decEx.admitted).toBe(false);
      expect(decEx.reason).toContain("Exclusive job requires all slots to be vacant");
    });

    it("does not terminate currently running jobs when effective capacity contracts", () => {
      // 3 jobs are currently running
      const activeJobs: ScheduledJobRequest[] = [
        { jobId: "j1", projectId: "p1", cliAlias: "agy", priority: "normal", resourceClass: "normal", createdAt: 100 },
        { jobId: "j2", projectId: "p2", cliAlias: "agy", priority: "normal", resourceClass: "normal", createdAt: 200 },
        { jobId: "j3", projectId: "p3", cliAlias: "agy", priority: "normal", resourceClass: "normal", createdAt: 300 },
      ];

      // Effective slots dropped to 2 under pressure
      // New admission fails cleanly without modifying activeJobs
      const req: ScheduledJobRequest = {
        jobId: "j4",
        projectId: "p4",
        cliAlias: "agy",
        priority: "normal",
        resourceClass: "normal",
        createdAt: 400,
      };
      const dec = evaluateJobAdmission(req, activeJobs, 2, "high", policy);
      expect(dec.admitted).toBe(false);
      expect(dec.reason).toContain("Effective slot capacity reached");
      // All 3 existing jobs remain alive
      expect(activeJobs).toHaveLength(3);
    });
  });

  describe("Fair Priority Queue & Anti-Starvation (P2.1 & P2.3)", () => {
    it("prioritizes critical jobs over low and normal priority jobs", () => {
      const q = new CliBridgePriorityQueue();
      const now = 10000;

      const lowJob: ScheduledJobRequest = {
        jobId: "low",
        projectId: "p1",
        cliAlias: "agy",
        priority: "low",
        resourceClass: "normal",
        createdAt: now - 5000,
      };
      const critJob: ScheduledJobRequest = {
        jobId: "crit",
        projectId: "p2",
        cliAlias: "agy",
        priority: "critical",
        resourceClass: "normal",
        createdAt: now,
      };

      q.enqueue(lowJob);
      q.enqueue(critJob);

      const next = q.dequeueNextEligible([], 4, "none", now);
      expect(next?.job.jobId).toBe("crit");
    });

    it("prevents starvation of older jobs via aging score", () => {
      const now = 100000;
      // Job queued 120 seconds ago (120 * 10 = +1200 points)
      const oldLowJob: ScheduledJobRequest = {
        jobId: "old_low",
        projectId: "p1",
        cliAlias: "agy",
        priority: "low",
        resourceClass: "normal",
        createdAt: now - 120000,
      };
      // Brand new normal job (200 points)
      const newNormalJob: ScheduledJobRequest = {
        jobId: "new_norm",
        projectId: "p2",
        cliAlias: "agy",
        priority: "normal",
        resourceClass: "normal",
        createdAt: now,
      };

      const scoreOld = calculateJobSchedulingScore(oldLowJob, [], now);
      const scoreNew = calculateJobSchedulingScore(newNormalJob, [], now);
      expect(scoreOld).toBeGreaterThan(scoreNew);
    });

    it("favors waiting projects over a project that already has active jobs (fairness)", () => {
      const now = 1000;
      const activeJobs: ScheduledJobRequest[] = [
        { jobId: "a1", projectId: "projA", cliAlias: "agy", priority: "normal", resourceClass: "normal", createdAt: 100 },
        { jobId: "a2", projectId: "projA", cliAlias: "agy", priority: "normal", resourceClass: "normal", createdAt: 200 },
      ];

      const queuedProjA: ScheduledJobRequest = {
        jobId: "a3",
        projectId: "projA",
        cliAlias: "agy",
        priority: "normal",
        resourceClass: "normal",
        createdAt: now - 1000,
      };
      const queuedProjB: ScheduledJobRequest = {
        jobId: "b1",
        projectId: "projB",
        cliAlias: "agy",
        priority: "normal",
        resourceClass: "normal",
        createdAt: now - 1000,
      };

      const scoreA = calculateJobSchedulingScore(queuedProjA, activeJobs, now);
      const scoreB = calculateJobSchedulingScore(queuedProjB, activeJobs, now);

      // ProjA has 2 active jobs (2 * 150 = 300 penalty), so ProjB wins
      expect(scoreB).toBeGreaterThan(scoreA);
    });

    it("enforces hard dynamic capacity bounds 2..8 even when configured higher", async () => {
      process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "12";
      const { getSchedulerContext } = await import("../src/core/tools/cliBridgeDelegateJobs.js");
      const ctx = getSchedulerContext();
      expect(ctx.effectiveSlots).toBeLessThanOrEqual(8);
      expect(ctx.effectiveSlots).toBeGreaterThanOrEqual(2);
      expect(ctx.policy.maxSlots).toBe(8);
      expect(ctx.policy.minSlots).toBe(2);
      delete process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
    });

    it("self-drains restored durable queue on startup when host has capacity (S5)", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const os = await import("node:os");
      const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "queue-drain-test-"));
      process.env.SUPERAGENT_CONFIG_DIR = testDir;
      const {
        getDelegateJob,
        __resetDelegateJobsForTests,
      } = await import("../src/core/tools/cliBridgeDelegateJobs.js");
      await __resetDelegateJobsForTests();

      const qDir = path.join(testDir, "cli-bridge", "delegations", "queue");
      await fs.mkdir(qDir, { recursive: true });
      const testJobId = "clj_1730000000000_deadbeef";
      const queueFile = path.join(qDir, `${testJobId}.json`);
      const logDir = path.join(testDir, "logs", "cli-bridge");
      await fs.writeFile(
        queueFile,
        JSON.stringify({
          job: {
            jobId: testJobId,
            cliAlias: "node-test",
            status: "queued",
            completionState: "pending",
            startedAt: Date.now(),
            cwd: process.cwd(),
            logPath: path.join(logDir, `job-${testJobId}.log`),
            outputTail: "",
            outputBytes: 0,
          },
          opts: {
            cliAlias: "node-test",
            binary: process.execPath,
            prompt: "test",
            args: ["-e", "console.log('drained_ok')"],
            cwd: process.cwd(),
            timeoutMs: 10000,
          },
        }),
        "utf8"
      );

      // Reset in-memory state while preserving queue file on disk to simulate restart
      await __resetDelegateJobsForTests({ keepDiskFiles: true });
      // Wait briefly for self-drain to fire and execute
      let drained = false;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const j = await getDelegateJob(testJobId);
        if (j && (j.status === "starting" || j.status === "running" || j.status === "succeeded")) {
          drained = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(drained).toBe(true);
      delete process.env.SUPERAGENT_CONFIG_DIR;
      await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
    });
  });
});
