import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const headlessAgentHarness = vi.hoisted(() => ({ instances: [] as any[] }));

vi.mock("../src/core/agent.js", () => ({
  Agent: class {
    public isMultiAgent = false;
    public tier = "master";
    public disableAmbientYoloMode = false;

    constructor(
      public onEvent: (event: any) => void,
      public onPermission: (toolCall: any, description: string) => Promise<boolean>,
      public onQuestion: (...args: any[]) => Promise<string>,
    ) {
      headlessAgentHarness.instances.push(this);
    }

    async sendMessage() {
      this.onEvent({ type: "text", content: "mock headless output" });
    }
  },
}));

import { DaemonScheduler } from "../src/core/daemon/daemonScheduler.js";

describe("DaemonScheduler", () => {
  let tmpDir: string;
  let scheduler: DaemonScheduler;

  beforeEach(() => {
    headlessAgentHarness.instances.length = 0;
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

  it("fails closed for headless permission requests and disables ambient YOLO inheritance", async () => {
    const job = scheduler.addJob({
      name: "Headless Safety Check",
      cronExpression: "0 0 * * *",
      prompt: "Perform a safe scheduled check",
      workspace: tmpDir,
    });

    const result = await scheduler.triggerJobNow(job.id);
    expect(result.success).toBe(true);

    const headlessAgent = headlessAgentHarness.instances.at(-1);
    expect(headlessAgent).toBeDefined();
    expect(headlessAgent.disableAmbientYoloMode).toBe(true);
    expect(headlessAgent.restrictHeadlessTools).toBe(true);
    expect(headlessAgent.headlessAllowedTools.has("read")).toBe(true);
    expect(headlessAgent.headlessAllowedTools.has("write_to_file")).toBe(false);
    await expect(headlessAgent.onPermission({ name: "run_command" }, "dangerous command")).resolves.toBe(false);
  });

  it("normalizes explicit per-job tool grants and pins a resolved workspace", async () => {
    const requestedWorkspace = path.join(tmpDir, "nested", "..", "workspace");
    fs.mkdirSync(requestedWorkspace, { recursive: true });
    const job = scheduler.addJob({
      name: "Explicit Capabilities",
      cronExpression: "0 0 * * *",
      prompt: "Check authorized task",
      workspace: requestedWorkspace,
      allowedTools: ["write_to_file", " run_command ", "", 12 as any] as any,
    });

    expect(job.workspace).toBe(path.resolve(requestedWorkspace));
    expect(job.allowedTools).toEqual(["write_to_file", "run_command"]);
    await scheduler.triggerJobNow(job.id);

    const headlessAgent = headlessAgentHarness.instances.at(-1);
    expect(headlessAgent.headlessAllowedTools.has("write_to_file")).toBe(true);
    expect(headlessAgent.headlessAllowedTools.has("run_command")).toBe(true);
    expect(headlessAgent.headlessAllowedTools.has("")).toBe(false);
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
