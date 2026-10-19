import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "node:crypto";

const headlessAgentHarness = vi.hoisted(() => ({ instances: [] as any[] }));
const retentionSweepHarness = vi.hoisted(() => ({
  runMemoryRetentionSweep: vi.fn(async () => ({
    mode: "applied",
    projectId: "p-test",
    scanned: 2,
    eligibleToExpire: 1,
    skippedQuarantined: 0,
    byScope: { project: 1, global: 0 },
    exportTruncated: false,
    items: [],
    markedExpired: 1,
    conflicts: 0,
    skipped: 0,
    failed: 0,
    results: [{ id: "old-memory", scope: "project", status: "marked_expired" }],
  })),
}));
const skillLearningHarness = vi.hoisted(() => ({
  bridgeRepeatedSkillFailures: vi.fn(async () => ({
    status: "insufficient_evidence",
    evidenceRunIds: [] as string[],
  })),
}));

vi.mock("../src/core/skills/skillLearningBridge.js", () => ({
  bridgeRepeatedSkillFailures: skillLearningHarness.bridgeRepeatedSkillFailures,
}));

const gatewayHarness = vi.hoisted(() => ({
  config: null as any,
  adapters: {} as Record<string, { sendReply: (...args: any[]) => Promise<boolean> }>,
}));


vi.mock("../src/core/gateway/gatewayManager.js", () => ({
  gatewayManager: {
    getConfig: () => gatewayHarness.config,
    getAdapter: (channel: string) => gatewayHarness.adapters[channel],
  },
}));

vi.mock("../src/core/memoryRetentionSweep.js", () => ({
  runMemoryRetentionSweep: retentionSweepHarness.runMemoryRetentionSweep,
}));

vi.mock("../src/core/agent.js", () => ({
  Agent: class {
    public isMultiAgent = false;
    public tier = "master";
    public disableAmbientYoloMode = false;
    public sessionId = "";
    public currentHistoryFilePath = "";
    resolveHistoryFilePath(sessionId: string) { return sessionId + "/" + sessionId + ".json"; }

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
import { closeHistoryDb, getHistoryDb } from "../src/core/storage/historyDb.js";
import { getDaemonRun, insertDaemonRun, listDaemonRuns } from "../src/core/storage/daemonRunLedger.js";
import { lockFile, releaseFile } from "../src/core/storage/sharedMemory.js";
import { SelfDevEventStore } from "../src/core/selfdev/eventStore.js";
import { getSelfDevConfig, updateSelfDevConfig } from "../src/core/selfdev/settings.js";
import { createSkillCandidate, evaluateSkillCandidate, promoteSkillCandidate, replaySkillCandidate, getSkillCandidate } from "../src/core/skills/skillLifecycle.js";

const skillPatterns = {
  toolsUsed: ["run_command"],
  commandPatterns: ["bun"],
  recoveredErrors: [],
  keySteps: ["Inspect code", "Run tests"],
};

function skillMarkdown(name: string, body = "1. Inspect the workspace.\n2. Run focused tests."): string {
  return [
    "---",
    "name: " + name,
    "description: A bounded workflow candidate for tests",
    "category: testing",
    "---",
    "",
    "# Candidate Workflow",
    "",
    "## When to Use",
    "Use after a similar task has been completed and verified.",
    "",
    "## Step-by-Step Workflow",
    body,
    "",
    "## Verification Protocol",
    "Run the project's test command and inspect the result.",
    "",
  ].join("\n");
}

function createCompletedEvidence(workspace: string, taskId: string): string {
  const sessionId = "session-" + randomUUID();
  const store = new SelfDevEventStore({
    workspace,
    getDb: () => getHistoryDb() as any,
    config: getSelfDevConfig(),
  });
  const verification = store.record({
    id: "test-" + randomUUID(),
    ts: Date.now(),
    sessionId,
    workspace,
    kind: "test_result",
    summary: "Focused test suite passed",
    evidence: [],
    tags: ["task-evidence", "test_result"],
    payload: { taskId, commandFamily: "vitest", toolName: "run_command", exitCode: 0, passed: true },
  });
  if (!verification) throw new Error("Could not persist test evidence.");
  const terminal = store.record({
    id: "completed-" + randomUUID(),
    ts: Date.now() + 1,
    sessionId,
    workspace,
    kind: "task_completed",
    summary: "Task completed after verification",
    evidence: [verification.id],
    tags: ["task-evidence"],
    payload: { taskId, outcome: "task_completed" },
  });
  if (!terminal) throw new Error("Could not persist completed-task evidence.");
  return terminal.id;
}

describe("DaemonScheduler", () => {
  let tmpDir: string;
  let scheduler: DaemonScheduler;
  let originalConfigDir: string | undefined;

  beforeEach(() => {
    originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
    retentionSweepHarness.runMemoryRetentionSweep.mockClear();
    skillLearningHarness.bridgeRepeatedSkillFailures.mockClear();
    headlessAgentHarness.instances.length = 0;
    gatewayHarness.config = {
      enabled: true,
      channels: {
        webhook: { enabled: false },
        telegram: { enabled: false },
        discord: { enabled: false },
        slack: { enabled: false },
      },
    };
    gatewayHarness.adapters = {
      telegram: { sendReply: vi.fn(async () => true) },
      discord: { sendReply: vi.fn(async () => true) },
      slack: { sendReply: vi.fn(async () => true) },
    };
    tmpDir = path.join(os.tmpdir(), `superagent_daemon_test_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.SUPERAGENT_CONFIG_DIR = tmpDir;
    closeHistoryDb();
    scheduler = new DaemonScheduler(tmpDir);
  });

  afterEach(() => {
    scheduler.stopDaemon();
    closeHistoryDb();
    if (originalConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
    else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
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

  it("rejects invalid job payloads consistently across CLI/HTTP constructor paths", () => {
    const base = {
      name: "Validated job",
      cronExpression: "0 5 * * *",
      prompt: "Inspect safely",
      workspace: tmpDir,
    };
    const invalid = [
      { mode: "privileged" },
      { enabled: "false" },
      { notifyGateway: "yes" },
      { workspace: 42 },
      { idempotent: "true" },
      { maxRuns: -1 },
      { prompt: "" },
      { name: "" },
      { allowedTools: "bash" },
      { tags: ["valid", 1] },
    ];
    for (const changes of invalid) {
      expect(() => scheduler.addJob({ ...base, ...changes } as any)).toThrow();
    }
    expect(scheduler.listJobs()).toHaveLength(0);
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

    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    expect(run.status).toBe("success");
    expect(JSON.parse(run.executionPolicyJson)).toMatchObject({
      policyVersion: "daemon-headless-v1",
      runner: "default-headless",
      disableAmbientYoloMode: true,
      explicitAllowedTools: [],
    });
    expect(JSON.parse(run.executionPolicyJson).allowedTools).toContain("read");
    expect(JSON.parse(run.executionPolicyJson).allowedTools).not.toContain("write_to_file");
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
    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    const policy = JSON.parse(run.executionPolicyJson);
    expect(policy.explicitAllowedTools).toEqual(["write_to_file", "run_command"]);
    expect(policy.allowedTools).toContain("write_to_file");
    expect(policy.allowedTools).toContain("run_command");
  });

  it("rejects workspace symlink traversal before execution and retains the denied run in the ledger", async () => {
    const targetWorkspace = path.join(tmpDir, "workspace-real");
    const linkedWorkspace = path.join(tmpDir, "workspace-link");
    fs.mkdirSync(targetWorkspace, { recursive: true });
    fs.symlinkSync(targetWorkspace, linkedWorkspace, "junction");

    const runner = vi.fn(async () => "unsafe workspace should never execute");
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Reject linked workspace",
      cronExpression: "0 4 * * *",
      prompt: "Never execute through a symlinked workspace",
      workspace: linkedWorkspace,
    });

    const result = await scheduler.triggerJobNow(job.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/symbolic-link/i);
    expect(runner).not.toHaveBeenCalled();

    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    expect(run).toMatchObject({
      jobId: job.id,
      status: "error",
      workspacePath: path.resolve(linkedWorkspace),
    });
    expect(run.errorMessage).toMatch(/symbolic-link/i);
    expect(JSON.parse(run.executionPolicyJson)).toMatchObject({
      workspacePath: path.resolve(linkedWorkspace),
      projectId: expect.any(String),
      disableAmbientYoloMode: true,
    });
  });

  it("persists terminal run outcomes and redacts secrets from the ledger", async () => {
    const successJob = scheduler.addJob({
      name: "Ledger success case",
      cronExpression: "0 4 * * *",
      prompt: "Run with a successful injected provider",
      workspace: tmpDir,
    });
    scheduler.setAgentRunner(async () => "Completed with API key sk-proj-abcdefghijklmnop");
    const successResult = await scheduler.triggerJobNow(successJob.id);
    expect(successResult.success).toBe(true);

    expect((await scheduler.triggerJobNow(successJob.id)).success).toBe(true);
    const successRuns = listDaemonRuns({ jobId: successJob.id, limit: 10 });
    expect(successRuns).toHaveLength(2);
    expect(successRuns.map((run) => run.attemptNumber).sort()).toEqual([1, 2]);
    expect(successRuns.every((run) => run.status === "success")).toBe(true);
    expect(successRuns[0]).toMatchObject({
      jobId: successJob.id,
      mode: "single",
      workspacePath: fs.realpathSync(tmpDir),
    });
    expect(successRuns.every((run) => run.outputSummary?.includes("[REDACTED]") ?? false)).toBe(true);
    expect(JSON.parse(successRuns[0].executionPolicyJson)).toMatchObject({
      disableAmbientYoloMode: true,
      runner: "injected",
    });

    const failedJob = scheduler.addJob({
      name: "Ledger failure case",
      cronExpression: "0 5 * * *",
      prompt: "Run with a failing injected provider",
      workspace: tmpDir,
    });
    scheduler.setAgentRunner(async () => { throw new Error("request failed: Bearer abcdefghijklmnop"); });
    const failureResult = await scheduler.triggerJobNow(failedJob.id);
    expect(failureResult.success).toBe(false);

    const failureRuns = listDaemonRuns({ jobId: failedJob.id, limit: 10 });
    expect(failureRuns).toHaveLength(1);
    expect(failureRuns[0]).toMatchObject({ jobId: failedJob.id, status: "error" });
    expect(failureRuns[0].errorMessage).toContain("[REDACTED_AUTH]");
  });

  it("runs the system memory retention sweep as built-in maintenance without invoking the LLM runner", async () => {
    const agentRunner = vi.fn(async () => "the LLM runner must not execute the system task");
    scheduler.setAgentRunner(agentRunner);
    const job = scheduler.addJob({
      name: "System Memory Retention Sweep",
      cronExpression: "0 4 * * *",
      prompt: "This prompt is informational only for the internal maintenance task",
      workspace: tmpDir,
      kind: "system-memory-retention-sweep",
    });

    const result = await scheduler.triggerJobNow(job.id);
    expect(result.success).toBe(true);
    expect(agentRunner).not.toHaveBeenCalled();
    expect(retentionSweepHarness.runMemoryRetentionSweep).toHaveBeenCalledWith({
      projectPath: fs.realpathSync(tmpDir),
      apply: true,
    });
    expect(result.output).toContain("marked_expired");
    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    expect(run.status).toBe("success");
    expect(JSON.parse(run.executionPolicyJson)).toMatchObject({
      runner: "system-memory-retention-sweep",
      fileLockGuard: "internal-memory-maintenance-no-workspace-file-access",
      pinnedSkillVersion: null,
    });
  });

  it("blocks write-capable daemon work during active project locks but keeps read-only jobs isolated", async () => {
    const targetFile = path.join(tmpDir, "user-editing.txt");
    fs.writeFileSync(targetFile, "interactive work in progress", "utf-8");
    const lock = lockFile(targetFile, "interactive-owner-session", "t-line", 60_000, tmpDir);
    expect(lock.success).toBe(true);

    try {
      const writeRunner = vi.fn(async () => "must not execute while another session edits this workspace");
      scheduler.setAgentRunner(writeRunner);
      const writeJob = scheduler.addJob({
        name: "Write while locked",
        cronExpression: "* * * * *",
        prompt: "Modify a file",
        workspace: tmpDir,
        allowedTools: ["write_to_file"],
      });
      const writeResult = await scheduler.triggerJobNow(writeJob.id);
      expect(writeResult.success).toBe(false);
      expect(writeResult.error).toMatch(/DAEMON_FILE_LOCK_CONTENTION/);
      expect(writeRunner).not.toHaveBeenCalled();
      const deniedRun = listDaemonRuns({ jobId: writeJob.id, limit: 1 })[0];
      expect(deniedRun).toMatchObject({ status: "error" });
      expect(deniedRun.errorMessage).toMatch(/DAEMON_FILE_LOCK_CONTENTION/);
      expect(JSON.parse(deniedRun.executionPolicyJson)).toMatchObject({
        fileLockGuard: "block-write-capable-run-on-active-project-lock",
        daemonSessionId: expect.stringMatching(/^sess_daemon_/),
      });

      const readOnlyScheduler = new DaemonScheduler(tmpDir);
      const readOnlyJob = readOnlyScheduler.addJob({
        name: "Read while locked",
        cronExpression: "* * * * *",
        prompt: "Read status only",
        workspace: tmpDir,
      });
      const readResult = await readOnlyScheduler.triggerJobNow(readOnlyJob.id);
      expect(readResult.success).toBe(true);
      const agent = headlessAgentHarness.instances.at(-1);
      expect(agent.sessionId).toMatch(new RegExp("^sess_daemon_" + readOnlyJob.id + "_"));
      expect(agent.currentHistoryFilePath).toContain(agent.sessionId);
      const readRun = listDaemonRuns({ jobId: readOnlyJob.id, limit: 1 })[0];
      expect(JSON.parse(readRun.executionPolicyJson)).toMatchObject({
        fileLockGuard: "read-only-run",
        daemonSessionId: agent.sessionId,
      });
    } finally {
      releaseFile(targetFile, "interactive-owner-session", tmpDir);
    }
  });

  it("records successful gateway delivery without changing task success", async () => {
    gatewayHarness.config.channels.telegram = {
      enabled: true,
      botToken: "test-token",
      allowedUserIds: ["telegram-target"],
    };
    const telegram = gatewayHarness.adapters.telegram;
    const runner = vi.fn(async () => "Finished safely");
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Notify after successful run",
      cronExpression: "* * * * *",
      prompt: "Run and notify",
      workspace: tmpDir,
      notifyGateway: true,
    });

    const result = await scheduler.triggerJobNow(job.id);
    expect(result.success).toBe(true);
    await vi.waitFor(() => {
      const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
      expect(run?.notificationStatus).toBe("delivered");
    });
    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    expect(run).toMatchObject({ status: "success", notificationStatus: "delivered", notificationError: null });
    expect(telegram.sendReply).toHaveBeenCalledWith("telegram-target", expect.stringContaining("Finished safely"));
  });

  it("records gateway failure and keeps the task result successful", async () => {
    gatewayHarness.config.channels.slack = {
      enabled: true,
      botToken: "test-token",
      allowedUserIds: ["slack-target"],
    };
    gatewayHarness.adapters.slack.sendReply = vi.fn(async () => false);
    scheduler.setAgentRunner(async () => "Task itself succeeded");
    const job = scheduler.addJob({
      name: "Notify failure",
      cronExpression: "* * * * *",
      prompt: "Run but fail to notify",
      workspace: tmpDir,
      notifyGateway: true,
    });

    const result = await scheduler.triggerJobNow(job.id);
    expect(result.success).toBe(true);
    await vi.waitFor(() => {
      expect(listDaemonRuns({ jobId: job.id, limit: 1 })[0]?.notificationStatus).toBe("failed");
    });
    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    expect(run).toMatchObject({
      status: "success",
      notificationStatus: "failed",
      notificationError: expect.stringContaining("slack"),
    });
    expect(run?.errorMessage).toBeNull();
  });

  it("fails closed when the scheduled workspace path crosses a symlink", async () => {
    const realWorkspace = path.join(tmpDir, "real-workspace");
    const linkedWorkspace = path.join(tmpDir, "linked-workspace");
    fs.mkdirSync(realWorkspace, { recursive: true });
    try {
      fs.symlinkSync(realWorkspace, linkedWorkspace, "junction");
    } catch (error: any) {
      // Symlink creation can be disabled by the host policy. Do not hide any
      // scheduler behavior; mark the case skipped only when the fixture itself
      // cannot be created due to host permissions.
      if (["EPERM", "EACCES", "ENOTSUP", "UNKNOWN"].includes(error?.code)) {
        console.warn("Skipping symlink workspace regression: host does not permit creating a junction.");
        return;
      }
      throw error;
    }

    const runner = vi.fn(async () => "must not execute");
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Symlink workspace",
      cronExpression: "* * * * *",
      prompt: "Do not enter workspace through a symlink",
      workspace: linkedWorkspace,
    });
    const result = await scheduler.triggerJobNow(job.id);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/symbolic-link|symlink traversal/i);
    expect(runner).not.toHaveBeenCalled();
    expect(listDaemonRuns({ jobId: job.id, limit: 1 })[0]).toMatchObject({ status: "error" });
  });

  it("bridges repeated failures of an actually executed pinned skill, preserving the run outcome", async () => {
    // Skip expensive lifecycle setup here: the positive fully-approved pin test
    // separately validates that resolvePinnedSkill cannot bypass approval.
    (scheduler as any).resolvePinnedSkill = vi.fn(async () => ({
      reference: "learning-probe@abcdef123456",
      content: "# Safe approved workflow\nReview preconditions.",
      contentSha256: "abcdef123456",
    }));
    const runner = vi.fn(async () => { throw new Error("provider rejected invocation"); });
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Pinned skill failure learning",
      cronExpression: "0 4 * * *",
      prompt: "Apply the pinned workflow",
      workspace: tmpDir,
      pinnedSkillVersion: "learning-probe@abcdef123456",
    });

    const first = await scheduler.triggerJobNow(job.id);
    const second = await scheduler.triggerJobNow(job.id);
    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
    expect(runner).toHaveBeenCalledTimes(2);
    const runs = listDaemonRuns({ jobId: job.id, limit: 5 });
    expect(runs).toHaveLength(2);
    expect(runs.map(run => run.status)).toEqual(["error", "error"]);
    expect(skillLearningHarness.bridgeRepeatedSkillFailures).toHaveBeenCalledTimes(2);
    expect(skillLearningHarness.bridgeRepeatedSkillFailures).toHaveBeenLastCalledWith({
      jobId: job.id,
      workspacePath: fs.realpathSync(tmpDir),
      pinnedSkillVersion: "learning-probe@abcdef123456",
    });
  });

  it("runs a scheduler job with a fully approved pinned skill and records the immutable version", async () => {
    const originalSelfDev = getSelfDevConfig();
    updateSelfDevConfig({
      enabled: true,
      collectionEnabled: true,
      injectionEnabled: true,
      storePath: path.join(tmpDir, "lessons.json"),
    });

    try {
      const taskId = randomUUID();
      const evidenceId = createCompletedEvidence(tmpDir, taskId);
      const candidate = await createSkillCandidate(tmpDir, {
        name: "daemon-pinned-skill-helper",
        description: "pinned skill used by daemon scheduler test",
        category: "testing",
        markdownContent: skillMarkdown("daemon-pinned-skill-helper"),
        extractedPatterns: skillPatterns,
        sourceEvidenceIds: [evidenceId],
      });

      const evaluated = await evaluateSkillCandidate(tmpDir, candidate.record.name, candidate.record.version);
      const evaluation = evaluated.record.evaluations.find((item) => item.evaluationId === evaluated.record.latestEvaluationId)!;
      expect(evaluation.status).toBe("passed");

      const replay = await replaySkillCandidate(tmpDir, candidate.record.name, candidate.record.version, {
        fixtureId: "daemon-pinned-skill-fixture-v1",
        name: "write output file",
        description: "produce a deterministic file output",
        taskPrompt: "Read input.txt and write output.txt containing the original content followed by done.",
        initialFiles: { "input.txt": "input" },
        actions: [
          { type: "assert_file_exists", target: "output.txt" },
          { type: "assert_file_contains", target: "output.txt", expected: "input-done" },
        ],
      }, async ({ tools, taskPrompt, instructions }) => {
        expect(taskPrompt).toContain("output.txt");
        expect(instructions).toContain("Candidate Workflow");
        const input = await tools.readFile("input.txt");
        await tools.writeFile("output.txt", input + "-done");
      });
      expect(replay.status).toBe("passed");

      const reEvaluated = getSkillCandidate(tmpDir, candidate.record.name, candidate.record.version);
      const currentEvaluationId = reEvaluated.record.latestEvaluationId;
      expect(currentEvaluationId).toBeDefined();
      const promoted = await promoteSkillCandidate(tmpDir, candidate.record.name, candidate.record.version, {
        approvedBy: "test-owner",
        method: "interactive-cli",
        evaluationId: currentEvaluationId,
      });
      expect(promoted.record.status).toBe("active");

      const runner = vi.fn(async (prompt: string) => {
        expect(prompt).toContain("Pinned approved skill:");
        expect(prompt).toContain("<pinned-skill-content>");
        return "pinned skill executed";
      });
      scheduler.setAgentRunner(runner);
      const job = scheduler.addJob({
        name: "Pinned skill job",
        cronExpression: "* * * * *",
        prompt: "Use the pinned skill to guide this run",
        workspace: tmpDir,
        pinnedSkillVersion: candidate.record.name + "@" + candidate.record.version,
      });

      const result = await scheduler.triggerJobNow(job.id);
      expect(result.success).toBe(true);
      expect(runner).toHaveBeenCalledTimes(1);

      const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
      expect(run).toMatchObject({
        status: "success",
        pinnedSkillVersion: candidate.record.name + "@" + candidate.record.version,
      });
      expect(JSON.parse(run.executionPolicyJson)).toMatchObject({
        pinnedSkillVersion: candidate.record.name + "@" + candidate.record.version,
        pinnedSkillSha256: candidate.record.contentSha256,
      });
    } finally {
      updateSelfDevConfig({
        enabled: originalSelfDev.enabled,
        collectionEnabled: originalSelfDev.collectionEnabled,
        injectionEnabled: originalSelfDev.injectionEnabled,
        storePath: originalSelfDev.storePath,
      });
    }
  });

  it("rejects malformed skill pins and fails closed for missing pinned versions", async () => {
    expect(() => scheduler.addJob({
      name: "Malformed pin",
      cronExpression: "* * * * *",
      prompt: "Never run",
      workspace: tmpDir,
      pinnedSkillVersion: "skill-without-hash",
    })).toThrow(/skill-name@12-char-hash/);

    const runner = vi.fn(async () => "must not execute");
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Missing pinned skill",
      cronExpression: "* * * * *",
      prompt: "Should not execute without its version",
      workspace: tmpDir,
      pinnedSkillVersion: "missing-skill@abcdef123456",
    });
    const result = await scheduler.triggerJobNow(job.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/skill/i);
    expect(runner).not.toHaveBeenCalled();
    expect(listDaemonRuns({ jobId: job.id, limit: 1 })[0]).toMatchObject({
      pinnedSkillVersion: "missing-skill@abcdef123456",
      status: "error",
    });
  });

  it("requires explicit idempotency before enabling automatic retries", () => {
    expect(() => scheduler.addJob({
      name: "Unsafe retry",
      cronExpression: "* * * * *",
      prompt: "This must not retry implicitly",
      workspace: tmpDir,
      retryLimit: 2,
    })).toThrow(/idempotent: true/);
  });

  it("retries an idempotent failure with backoff and records each attempt", async () => {
    let calls = 0;
    scheduler.setAgentRunner(async () => {
      calls++;
      if (calls === 1) throw new Error("temporary provider failure");
      return "recovered";
    });
    const job = scheduler.addJob({
      name: "Retryable check",
      cronExpression: "* * * * *",
      prompt: "Retry safe operation",
      workspace: tmpDir,
      idempotent: true,
      retryLimit: 1,
      retryDelayMs: 1,
    });

    expect((await scheduler.triggerJobNow(job.id)).success).toBe(false);
    expect(scheduler.getJob(job.id)?.retryAt).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 5));
    (scheduler as any).tick();
    await vi.waitFor(() => expect(calls).toBe(2));
    const runs = listDaemonRuns({ jobId: job.id, limit: 5 });
    await vi.waitFor(() => expect(listDaemonRuns({ jobId: job.id, limit: 5 }).some((run) => run.status === "success")).toBe(true));
    expect(runs.map((run) => run.attemptNumber).sort()).toEqual([1, 2]);
    expect(listDaemonRuns({ jobId: job.id, limit: 5 }).some((run) => run.status === "error")).toBe(true);
    expect(scheduler.getJob(job.id)?.retryCount).toBe(0);
    expect(scheduler.getJob(job.id)?.retryAt).toBeUndefined();
  });

  it("uses the safe five-minute default timeout for jobs without an explicit deadline", () => {
    const job = scheduler.addJob({
      name: "Default deadline",
      cronExpression: "0 4 * * *",
      prompt: "Safe default",
      workspace: tmpDir,
    });
    expect(job.timeoutMs).toBe(300_000);
  });

  it("rejects manual triggers when the global concurrency limit is already full", async () => {
    (scheduler as any).config.maxConcurrentJobs = 1;
    (scheduler as any).runningJobIds.add("another-running-job");
    const runner = vi.fn(async () => "must not start");
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Manual blocked",
      cronExpression: "* * * * *",
      prompt: "Respect global cap",
      workspace: tmpDir,
    });

    const result = await scheduler.triggerJobNow(job.id);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/concurrency limit/i);
    expect(runner).not.toHaveBeenCalled();
    expect(listDaemonRuns({ jobId: job.id, limit: 1 })).toHaveLength(0);
  });

  it("persists cron work in the queue when the concurrency cap is reached", () => {
    (scheduler as any).config.maxConcurrentJobs = 1;
    const blocker = scheduler.addJob({
      name: "Busy slot",
      cronExpression: "* * * * *",
      prompt: "Busy",
      workspace: tmpDir,
    });
    const waiting = scheduler.addJob({
      name: "Queued job",
      cronExpression: "* * * * *",
      prompt: "Run when available",
      workspace: tmpDir,
    });
    (scheduler as any).runningJobIds.add(blocker.id);

    (scheduler as any).tick();

    expect(scheduler.getJob(waiting.id)?.lastStatus).toBe("queued");
    expect(scheduler.getJob(waiting.id)?.queuedAt).toBeDefined();
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, "daemon-jobs.json"), "utf-8")).find((item: any) => item.id === waiting.id)?.queuedAt).toBeDefined();
  });

  it("aborts a run at its deadline, records timed_out, and frees the scheduler slot", async () => {
    let observedSignal: AbortSignal | undefined;
    const runner = vi.fn((_prompt: string, _workspace: string, _mode: "single" | "multi", signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("runner observed abort");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    const timedJob = new DaemonScheduler(tmpDir, runner).addJob({
      name: "Deadline test",
      cronExpression: "0 4 * * *",
      prompt: "Wait until cancelled",
      workspace: tmpDir,
      timeoutMs: 100,
    });

    const runScheduler = new DaemonScheduler(tmpDir, runner);
    const result = await runScheduler.triggerJobNow(timedJob.id);
    expect(result.success).toBe(false);
    expect(result.error).toContain("timed out after 100ms");
    expect(observedSignal?.aborted).toBe(true);
    expect(runScheduler.isJobRunning(timedJob.id)).toBe(false);
    expect(runScheduler.getJob(timedJob.id)?.lastStatus).toBe("timed_out");
    expect(listDaemonRuns({ jobId: timedJob.id, limit: 1 })[0]).toMatchObject({
      jobId: timedJob.id,
      status: "timed_out",
      errorMessage: expect.stringContaining("timed out after 100ms"),
    });
  });

  it("cancels an in-flight run by run ID without marking timeout or scheduling retry", async () => {
    let receivedSignal: AbortSignal | undefined;
    const runner = vi.fn((_prompt: string, _workspace: string, _mode: "single" | "multi", signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<string>((_resolve, reject) => {
        const abort = () => reject(new Error("cancelled"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    });
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Cancellation smoke test",
      cronExpression: "0 4 * * *",
      prompt: "Wait until explicitly cancelled",
      workspace: tmpDir,
      timeoutMs: 30_000,
      retryLimit: 1,
      idempotent: true,
    });

    const pending = scheduler.triggerJobNow(job.id);
    await vi.waitFor(() => expect(listDaemonRuns({ jobId: job.id, limit: 1 })[0]?.status).toBe("running"));
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    expect(scheduler.cancelRun(run.runId)).toBe(true);
    expect(scheduler.cancelRun(run.runId)).toBe(false);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cancelled by operator/);
    expect(receivedSignal?.aborted).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(scheduler.isJobRunning(job.id)).toBe(false);
    expect(scheduler.getJob(job.id)?.lastStatus).toBe("cancelled");
    expect(scheduler.getJob(job.id)?.retryAt).toBeUndefined();
    expect(listDaemonRuns({ jobId: job.id, limit: 1 })[0]).toMatchObject({
      status: "cancelled", interruptionReason: "operator_cancel_requested",
    });
  });

  it("rejects internal state injection and freezes execution policy during an active run", async () => {
    const runner = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseRunner = resolve;
      });
      return "run completed under original policy";
    });
    let releaseRunner: (() => void) | undefined;
    scheduler.setAgentRunner(runner);
    const job = scheduler.addJob({
      name: "Immutable running policy",
      cronExpression: "0 4 * * *",
      prompt: "Inspect with original permissions",
      workspace: tmpDir,
      mode: "single",
      allowedTools: ["read_file"],
    });

    expect(() => scheduler.updateJob(job.id, { kind: "system-memory-retention-sweep" })).toThrow(/immutable/);
    expect(() => scheduler.updateJob(job.id, { lastStatus: "success" })).toThrow(/immutable/);
    expect(() => scheduler.updateJob(job.id, { runCount: 999 })).toThrow(/immutable/);
    expect(() => scheduler.updateJob(job.id, { id: "spoof" })).toThrow(/immutable/);
    expect(() => scheduler.updateJob(job.id, { mode: "unknown" as any })).toThrow(/single or multi/);

    const pending = scheduler.triggerJobNow(job.id);
    await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
    try {
      expect(() => scheduler.updateJob(job.id, { workspace: path.dirname(tmpDir) })).toThrow(/running daemon/);
      expect(() => scheduler.updateJob(job.id, { allowedTools: ["bash"] })).toThrow(/running daemon/);
      expect(() => scheduler.updateJob(job.id, { pinnedSkillVersion: "rogue@abcdef123456" })).toThrow(/running daemon/);
      expect(() => scheduler.updateJob(job.id, { prompt: "new privileged task" })).toThrow(/running daemon/);
      expect(scheduler.deleteJob(job.id)).toBe(false);
      expect(scheduler.updateJob(job.id, { enabled: false })?.enabled).toBe(false);
    } finally {
      releaseRunner?.();
    }
    const result = await pending;
    expect(result.success).toBe(true);
    expect(scheduler.getJob(job.id)).toMatchObject({
      workspace: fs.realpathSync(tmpDir),
      prompt: "Inspect with original permissions",
      mode: "single",
      runCount: 1,
    });
    const run = listDaemonRuns({ jobId: job.id, limit: 1 })[0];
    expect(run.status).toBe("success");
    expect(JSON.parse(run.executionPolicyJson)).toMatchObject({
      workspacePath: fs.realpathSync(tmpDir),
      mode: "single",
      explicitAllowedTools: ["read_file"],
    });
  });

  it("reconciles stale running records on restart without re-executing the job", () => {
    const job = scheduler.addJob({
      name: "Interrupted after restart",
      cronExpression: "* * * * *",
      prompt: "Must not be replayed automatically",
      workspace: tmpDir,
    });
    const legacyJob = scheduler.addJob({
      name: "Legacy running job without ledger",
      cronExpression: "* * * * *",
      prompt: "Legacy state must also be healed",
      workspace: tmpDir,
    });
    const startedAt = Date.now() - 30_000;
    // Simulate historical on-disk records without granting public PATCH
    // permission to alter internal execution/ledger state.
    Object.assign(scheduler.getJob(job.id)!, { lastStatus: "running", lastRun: startedAt });
    Object.assign(scheduler.getJob(legacyJob.id)!, { lastStatus: "running", lastRun: startedAt - 10_000 });
    (scheduler as any).saveJobs();
    const runId = "stale-run-" + Date.now();
    insertDaemonRun({
      runId,
      jobId: job.id,
      attemptNumber: 1,
      workspacePath: job.workspace,
      projectId: "test-project",
      mode: job.mode,
      status: "running",
      executionPolicyJson: JSON.stringify({ allowedTools: ["read"], disableAmbientYoloMode: true }),
      startedAt,
    });

    const runner = vi.fn(async () => "should never run during recovery");
    const recovered = new DaemonScheduler(tmpDir, runner);
    expect(getDaemonRun(runId)).toMatchObject({
      runId,
      status: "interrupted",
      interruptionReason: "daemon_restarted_during_execution",
      recoveryAction: "reconciled_stale",
    });
    expect(recovered.getJob(job.id)).toMatchObject({
      lastStatus: "interrupted",
      lastError: expect.stringContaining(runId),
    });
    expect(recovered.isJobRunning(job.id)).toBe(false);
    expect(recovered.getJob(legacyJob.id)).toMatchObject({
      lastStatus: "interrupted",
      lastError: expect.stringContaining("no matching durable run record"),
    });

    // Even with an every-minute schedule, recovery must not replay the interrupted
    // work during the startup tick in the same minute.
    recovered.startDaemon(60_000);
    expect(runner).not.toHaveBeenCalled();
    recovered.stopDaemon();
  });

  it("recovers a corrupted primary jobs file from the last known-good backup", () => {
    const first = scheduler.addJob({
      name: "First durable job",
      cronExpression: "0 2 * * *",
      prompt: "First prompt",
      workspace: tmpDir,
    });
    scheduler.addJob({
      name: "Second durable job",
      cronExpression: "30 2 * * *",
      prompt: "Second prompt",
      workspace: tmpDir,
    });

    const jobsPath = path.join(tmpDir, "daemon-jobs.json");
    const backupPath = jobsPath + ".bak";
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(backupPath, "utf-8"))).toHaveLength(1);

    fs.writeFileSync(jobsPath, "{ invalid json", "utf-8");
    const recovered = new DaemonScheduler(tmpDir);
    expect(recovered.listJobs().map((job) => job.id)).toEqual([first.id]);
    expect(JSON.parse(fs.readFileSync(jobsPath, "utf-8")).map((job: any) => job.id)).toEqual([first.id]);
    expect(JSON.parse(fs.readFileSync(backupPath, "utf-8")).map((job: any) => job.id)).toEqual([first.id]);
    expect(fs.readdirSync(tmpDir).some((name) => name.endsWith(".tmp"))).toBe(false);
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
