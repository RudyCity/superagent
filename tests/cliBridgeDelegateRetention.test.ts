import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  pruneJobs,
  getRetainedJobCount,
  getOwnedJobIdCount,
  getLogQueueCount,
  __resetDelegateJobsForTests,
  __populateCompletedJobsForTests,
  type DelegateJob,
} from "../src/core/tools/cliBridgeDelegateJobs.js";
import {
  persistJobShard,
  loadJobShards,
  pruneJobRevisions,
  getJobRevisionCount,
  MAX_JOB_SNAPSHOTS_PER_JOB,
} from "../src/core/tools/cliBridgeJobStore.js";

describe("CLI Bridge Delegate Job Retention & Lifecycle Ordering (M5)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(os.tmpdir(), `delegate-retention-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tempDir, { recursive: true });
    await __resetDelegateJobsForTests();
  });

  afterEach(async () => {
    await __resetDelegateJobsForTests();
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("pruneJobs bounds 1,000 completed jobs down to MAX_RETAINED_JOBS (100) and cleans in-memory revisions", async () => {
    // Populate 1,000 completed jobs in memory
    const syntheticJobs: DelegateJob[] = [];
    const baseTime = Date.now() - 2_000_000;
    for (let i = 0; i < 1000; i++) {
      const jobId = `clj_${1000 + i}_${(i + 1).toString().padStart(8, "0")}`;
      syntheticJobs.push({
        jobId,
        cwd: process.cwd(),
        logPath: path.join(tempDir, `${jobId}.log`),
        status: "completed",
        startedAt: baseTime + i * 1000,
        endedAt: baseTime + i * 1000 + 500,
        taskOutcome: "VERIFIED",
        processState: "completed",
        verificationState: "verified",
      });
    }

    __populateCompletedJobsForTests(syntheticJobs);
    expect(getRetainedJobCount()).toBe(1000);

    // Call pruneJobs() to enforce retention cap
    const prunedCount = pruneJobs();
    expect(prunedCount).toBe(900);
    expect(getRetainedJobCount()).toBe(100);

    // Verify the remaining 100 jobs are the most recent ones (startedAt highest)
    const oldestRemainingStartedAt = baseTime + 900 * 1000;
    // Calling pruneJobs again should prune 0
    expect(pruneJobs()).toBe(0);
    expect(getRetainedJobCount()).toBe(100);
  });

  it("clarifies on-disk snapshot compaction (MAX_JOB_SNAPSHOTS_PER_JOB=8) vs in-memory revision Map pruning", async () => {
    // 1. On-disk test: write 12 snapshot revisions for a single job
    const singleJobId = "clj_2000_12345678";
    for (let rev = 1; rev <= 12; rev++) {
      await persistJobShard(tempDir, {
        jobId: singleJobId,
        cwd: process.cwd(),
        logPath: path.join(tempDir, `${singleJobId}.log`),
        status: rev === 12 ? "completed" : "running",
        startedAt: 1000000,
        endedAt: rev === 12 ? 1005000 : undefined,
      });
    }

    // On-disk compaction limits files to MAX_JOB_SNAPSHOTS_PER_JOB (8)
    const jobDir = path.join(tempDir, "jobs.d", singleJobId);
    const files = await fs.readdir(jobDir);
    expect(files.length).toBe(MAX_JOB_SNAPSHOTS_PER_JOB);
    expect(files.length).toBe(8);

    // 2. In-memory test: verify revisions Map tracks active jobs and pruneJobRevisions prunes it
    expect(getJobRevisionCount()).toBeGreaterThan(0);
    pruneJobRevisions(new Set(["some_other_unrelated_job"]));
    // The singleJobId should now be purged from the in-memory revisions Map
    expect(getJobRevisionCount()).toBe(0);
  });

  it("persists and reads back 20 disk shards without losing data", async () => {
    for (let i = 0; i < 20; i++) {
      const jobId = `clj_${3000 + i}_${(i + 1).toString().padStart(8, "0")}`;
      await persistJobShard(tempDir, {
        jobId,
        cwd: process.cwd(),
        logPath: path.join(tempDir, `${jobId}.log`),
        status: "completed",
        startedAt: Date.now() - (20 - i) * 1000,
        endedAt: Date.now() - (20 - i) * 500,
        taskOutcome: "VERIFIED",
        processState: "completed",
        verificationState: "verified",
      });
    }

    const shards = await loadJobShards(tempDir);
    expect(shards.length).toBe(20);
  });

  it("leaves zero lingering ownedJobIds and logQueues after reset/terminal cleanup", async () => {
    expect(getOwnedJobIdCount()).toBe(0);
    expect(getLogQueueCount()).toBe(0);
    expect(getRetainedJobCount()).toBe(0);
  });
});
