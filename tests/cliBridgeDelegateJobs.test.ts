import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type DelegateJobsModule = typeof import("../src/core/tools/cliBridgeDelegateJobs.js");

const configDir = path.join(os.tmpdir(), `superagent-cli-bridge-jobs-${process.pid}`);
const originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
const originalMaxJobs = process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
let delegateJobs: DelegateJobsModule;

function options(script: string, timeoutMs = 10_000): Parameters<DelegateJobsModule["startDelegateJob"]>[0] {
  return {
    cliAlias: "node-test",
    binary: process.execPath,
    prompt: "CLI Bridge background job test",
    cwd: process.cwd(),
    args: ["-e", script],
    timeoutMs,
  };
}

async function waitForTerminal(jobId: string, maxWaitMs = 8_000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const job = await delegateJobs.getDelegateJob(jobId);
    if (job && !["starting", "running", "cancelling"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for CLI Bridge job ${jobId} to finish`);
}

beforeAll(async () => {
  process.env.SUPERAGENT_CONFIG_DIR = configDir;
  await fs.rm(configDir, { recursive: true, force: true });
  delegateJobs = await import("../src/core/tools/cliBridgeDelegateJobs.js");
});

afterEach(async () => {
  await delegateJobs.__resetDelegateJobsForTests();
  if (originalMaxJobs === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
  else process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = originalMaxJobs;
});

afterAll(async () => {
  if (originalConfigDir === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = originalConfigDir;
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("CLI Bridge background delegation jobs", () => {
  it("returns promptly and makes a long-running job pollable until logs are complete", async () => {
    const started = await delegateJobs.startDelegateJob(options(
      'console.log("job-started"); setTimeout(() => { console.log("job-finished"); }, 250);',
    ));

    expect(started.jobId).toMatch(/^clj_\d+_[a-f0-9]+$/);
    expect(["starting", "running", "succeeded"]).toContain(started.status);

    const finished = await waitForTerminal(started.jobId);
    expect(finished.status).toBe("succeeded");
    expect(finished.exitCode).toBe(0);
    expect(finished.outputBytes).toBeGreaterThan(0);

    const tail = await delegateJobs.tailDelegateJob(started.jobId, 200);
    expect(tail?.output).toContain("job-started");
    expect(tail?.output).toContain("job-finished");
    expect(tail?.output).toContain("status=succeeded");
  }, 15_000);

  it("enforces the concurrency cap when starts are requested simultaneously", async () => {
    process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "1";
    const results = await Promise.allSettled([
      delegateJobs.startDelegateJob(options('setTimeout(() => console.log("job-one-done"), 900);', 5_000)),
      delegateJobs.startDelegateJob(options('setTimeout(() => console.log("job-two-done"), 900);', 5_000)),
    ]);

    const accepted = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<DelegateJobsModule["startDelegateJob"]>>> => result.status === "fulfilled");
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason)).toMatch(/concurrency limit reached/i);

    const finished = await waitForTerminal(accepted[0].value.jobId);
    expect(finished.status).toBe("succeeded");
  }, 15_000);

  it("runs independent jobs concurrently up to the configured cap", async () => {
    process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "2";
    const started = await Promise.all([
      delegateJobs.startDelegateJob(options('setTimeout(() => console.log("parallel-one-done"), 800);', 5_000)),
      delegateJobs.startDelegateJob(options('setTimeout(() => console.log("parallel-two-done"), 800);', 5_000)),
    ]);

    expect(new Set(started.map((job) => job.jobId)).size).toBe(2);
    expect(started.every((job) => ["starting", "running"].includes(job.status))).toBe(true);
    const active = await delegateJobs.listDelegateJobs();
    expect(active.filter((job) => ["starting", "running", "cancelling"].includes(job.status))).toHaveLength(2);

    const finished = await Promise.all(started.map((job) => waitForTerminal(job.jobId)));
    expect(finished.every((job) => job.status === "succeeded")).toBe(true);
  }, 15_000);

  it("isolates project A background jobs from project B list/get/tail/cancel", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cli-project-"));
    const rootA = path.join(fixture, "A");
    const rootB = path.join(fixture, "B");
    await fs.mkdir(rootA);
    await fs.mkdir(rootB);
    try {
      const started = await cliBridgeTool.execute({
        action: "delegate.start", cli: "custom", binary: process.execPath,
        args: ["-e", 'console.log("private-A-only"); setTimeout(() => {}, 1500);'],
        prompt: "Scope isolation", injectArtifacts: false, skillAutoDetect: false,
        timeoutMs: 5000,
      }, rootA);
      const id = String(started).match(/clj_\d+_[a-f0-9]+/)?.[0];
      expect(id).toBeTruthy();
      const fromB = await Promise.all([
        cliBridgeTool.execute({ action: "delegate.jobs" }, rootB),
        cliBridgeTool.execute({ action: "delegate.get", jobId: id }, rootB),
        cliBridgeTool.execute({ action: "delegate.tail", jobId: id }, rootB),
        cliBridgeTool.execute({ action: "delegate.cancel", jobId: id }, rootB),
      ]);
      for (const denied of fromB) {
        expect(String(denied)).not.toContain(id!);
        expect(String(denied)).not.toContain("private-A-only");
      }
      expect(fromB.slice(1).every(text => /not found|not available/i.test(String(text)))).toBe(true);
      const stillOwned = await delegateJobs.getDelegateJob(id!);
      expect(["running", "starting", "succeeded"]).toContain(stillOwned?.status);
      expect(String(await cliBridgeTool.execute({ action: "delegate.get", jobId: id }, rootA))).toContain(id!);
      expect(String(await cliBridgeTool.execute({ action: "delegate.cancel", jobId: id }, rootA))).toMatch(/Cancellation requested/);
      expect((await waitForTerminal(id!)).status).toBe("cancelled");
    } finally {
      // On Windows a running child's working directory cannot be removed.
      await delegateJobs.__resetDelegateJobsForTests();
      await fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("rejects explicit outside cwd for delegates, allowing only descendants in the caller workspace", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cli-path-"));
    const rootA = path.join(fixture, "A");
    const rootB = path.join(fixture, "B");
    const child = path.join(rootA, "child");
    await fs.mkdir(child, { recursive: true });
    await fs.mkdir(rootB);
    try {
      const denied = await cliBridgeTool.execute({
        action: "delegate.start", cli: "custom", binary: process.execPath,
        args: ["-e", 'console.log("unreachable")'], prompt: "Do not run",
        cwd: rootB, injectArtifacts: false, skillAutoDetect: false,
      }, rootA);
      expect(String(denied)).toMatch(/outside|not authorized|workspace/i);
      expect(String(denied)).not.toContain("Started background CLI delegation");
      const allowed = await cliBridgeTool.execute({
        action: "delegate.start", cli: "custom", binary: process.execPath,
        args: ["-e", 'console.log("safe-child")'], prompt: "Allowed child directory",
        cwd: child, injectArtifacts: false, skillAutoDetect: false, timeoutMs: 5000,
      }, rootA);
      const id = String(allowed).match(/clj_\d+_[a-f0-9]+/)?.[0];
      expect(id).toBeTruthy();
      expect((await waitForTerminal(id!)).status).toBe("succeeded");
      expect(String(await cliBridgeTool.execute({ action: "delegate.get", jobId: id }, rootA))).toContain(id!);
      expect(String(await cliBridgeTool.execute({ action: "delegate.get", jobId: id }, rootB))).toMatch(/not found|not available/i);
    } finally {
      // On Windows a running child's working directory cannot be removed.
      await delegateJobs.__resetDelegateJobsForTests();
      await fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("exposes background start, status polling, and log tail through the MCP tool", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const response = await cliBridgeTool.execute({
      action: "delegate.start",
      cli: "custom",
      binary: process.execPath,
      args: ["-e", 'console.log("mcp-job-started"); setTimeout(() => console.log("mcp-job-finished"), 150);'],
      prompt: "Run this background integration test",
      cwd: process.cwd(),
      injectArtifacts: false,
      skillAutoDetect: false,
      timeoutMs: 5_000,
    }, process.cwd());

    expect(response).toMatch(/Started background CLI delegation: (clj_[\w]+)/);
    const jobId = String(response).match(/Started background CLI delegation: (clj_[\w]+)/)?.[1];
    expect(jobId).toBeTruthy();

    const final = await waitForTerminal(jobId!);
    expect(final.status).toBe("succeeded");

    const status = await cliBridgeTool.execute({ action: "delegate.get", jobId }, process.cwd());
    const tail = await cliBridgeTool.execute({ action: "delegate.tail", jobId, tailLimit: 200 }, process.cwd());
    expect(status).toMatch(/Status: succeeded/);
    expect(tail).toContain("mcp-job-started");
    expect(tail).toContain("mcp-job-finished");
  }, 15_000);
});
