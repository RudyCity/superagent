import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { DaemonScheduler } from "../src/core/daemon/daemonScheduler.js";

describe("DaemonScheduler", () => {
  let tmpDir: string;
  let scheduler: DaemonScheduler;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `superagent_daemon_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    scheduler = new DaemonScheduler(tmpDir);
  });

  afterEach(() => {
    scheduler.stopDaemon();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("starts in idle status with no jobs", () => {
    const status = scheduler.getStatus();
    expect(status.running).toBe(false);
    expect(status.totalJobsCount).toBe(0);
    expect(scheduler.listJobs()).toHaveLength(0);
  });

  it("adds, updates, retrieves, and deletes jobs with persistence", () => {
    const job = scheduler.addJob({
      name: "Nightly Clean",
      cronExpression: "0 2 * * *",
      prompt: "Clean temporary files and cache",
      workspace: "/test/workspace"
    });

    expect(job.id).toBeDefined();
    expect(job.name).toBe("Nightly Clean");
    expect(job.enabled).toBe(true);
    expect(job.nextRun).toBeDefined();

    // Verify retrieval
    const retrieved = scheduler.getJob(job.id);
    expect(retrieved?.prompt).toBe("Clean temporary files and cache");

    // Verify update
    const updated = scheduler.updateJob(job.id, {
      name: "Nightly Deep Clean",
      cronExpression: "30 2 * * *"
    });
    expect(updated?.name).toBe("Nightly Deep Clean");
    expect(updated?.cronExpression).toBe("30 2 * * *");

    // Persistence test
    const scheduler2 = new DaemonScheduler(tmpDir);
    const persistedJob = scheduler2.getJob(job.id);
    expect(persistedJob?.name).toBe("Nightly Deep Clean");

    // Deletion test
    const deleted = scheduler.deleteJob(job.id);
    expect(deleted).toBe(true);
    expect(scheduler.getJob(job.id)).toBeNull();
  });

  it("rejects invalid cron expressions when adding a job", () => {
    expect(() => {
      scheduler.addJob({
        name: "Broken Job",
        cronExpression: "invalid-cron",
        prompt: "Fail"
      });
    }).toThrow(/Invalid cron expression/);
  });

  it("executes jobs via mock runner and updates run statistics", async () => {
    let executedPrompt = "";
    scheduler.setAgentRunner(async (prompt) => {
      executedPrompt = prompt;
      return "Clean completed: 42 files removed";
    });

    const job = scheduler.addJob({
      name: "Scheduled Sweep",
      cronExpression: "*/5 * * * *",
      prompt: "Run sweep"
    });

    const res = await scheduler.triggerJobNow(job.id);
    expect(res.success).toBe(true);
    expect(res.output).toContain("42 files removed");
    expect(executedPrompt).toBe("Run sweep");

    const updatedJob = scheduler.getJob(job.id);
    expect(updatedJob?.runCount).toBe(1);
    expect(updatedJob?.lastStatus).toBe("success");
    expect(updatedJob?.lastRun).toBeDefined();
    expect(updatedJob?.lastRunDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles execution errors gracefully and records failure", async () => {
    scheduler.setAgentRunner(async () => {
      throw new Error("Disk full simulation");
    });

    const job = scheduler.addJob({
      name: "Failing Job",
      cronExpression: "0 0 * * *",
      prompt: "Trigger error"
    });

    const res = await scheduler.triggerJobNow(job.id);
    expect(res.success).toBe(false);
    expect(res.error).toBe("Disk full simulation");

    const updatedJob = scheduler.getJob(job.id);
    expect(updatedJob?.runCount).toBe(1);
    expect(updatedJob?.lastStatus).toBe("error");
    expect(updatedJob?.lastError).toBe("Disk full simulation");
  });

  it("starts and stops daemon timer cleanly", () => {
    expect(scheduler.isRunning()).toBe(false);
    scheduler.startDaemon(500);
    expect(scheduler.isRunning()).toBe(true);
    expect(scheduler.getStatus().running).toBe(true);

    scheduler.stopDaemon();
    expect(scheduler.isRunning()).toBe(false);
    expect(scheduler.getStatus().running).toBe(false);
  });
});
