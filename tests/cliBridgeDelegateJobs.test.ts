import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type DelegateJobsModule = typeof import("../src/core/tools/cliBridgeDelegateJobs.js");

const configDir = path.join(os.tmpdir(), `superagent-cli-bridge-jobs-${process.pid}`);
const originalConfigDir = process.env.SUPERAGENT_CONFIG_DIR;
const originalMaxJobs = process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
const originalCapacityDir = process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR;
const originalForcePressure = process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE;
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
  process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = path.join(configDir, "test-capacity");
  process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE = "none";
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
  if (originalCapacityDir === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR;
  else process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = originalCapacityDir;
  if (originalForcePressure === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE;
  else process.env.SUPERAGENT_CLI_BRIDGE_FORCE_PRESSURE = originalForcePressure;
  await fs.rm(configDir, { recursive: true, force: true });
});

describe("CLI Bridge background delegation jobs", () => {
  it("marks AGY permission denial as blocked despite exit code zero", async () => {
    const script = [
      'console.log("warning: --mode auto is not available for this account; continuing in the default mode.");',
      'console.log(JSON.stringify({event:"step_update",step_update:{state:"ERROR",step_type:"tool",tool_info:{error:{message:"permission check failed: user denied permission to run command"}}}}));',
      'console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"",denied_actions:[{action:"command"}]}}));',
    ].join("");
    const started = await delegateJobs.startDelegateJob({ ...options(script), cliAlias: "agy" });
    const finished = await waitForTerminal(started.jobId);
    expect(finished.exitCode).toBe(0);
    expect(finished.status).toBe("permission_blocked");
    expect(finished.completionState).toBe("permission_blocked");
    expect(finished.permissionWarning).toMatch(/request-review/);
    expect(finished.error).toMatch(/permissions.allow/);
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const report = String(await cliBridgeTool.execute({ action: "delegate.get", jobId: started.jobId }, process.cwd()));
    expect(report).toContain("Status: permission_blocked");
    expect(report).toContain("Mode warning:");
    expect(report).toContain("Permission blocked.");
  }, 15_000);

  it("recovers from an earlier AGY permission denial when a later clean final result supersedes it", async () => {
    const script = [
      'console.log(JSON.stringify({event:"step_update",step_update:{state:"ERROR",step_type:"tool",tool_info:{error:{message:"permission check failed: user denied permission to run command"}}}}));',
      'console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"completed through an alternate path"}}));',
    ].join("");
    const started = await delegateJobs.startDelegateJob({ ...options(script), cliAlias: "agy" });
    const finished = await waitForTerminal(started.jobId);
    expect(finished.exitCode).toBe(0);
    expect(finished.status).toBe("succeeded");
    expect(finished.completionState).toBe("unverified");
    expect(finished.permissionFailure).toBeUndefined();
    expect(finished.permissionRecovered).toBe(true);
    expect(finished.permissionRecoveryWarning).toMatch(/superseded by a clean final result/);
  }, 15_000);

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
    const releaseFile = path.join(configDir, "release-parallel-jobs");
    await fs.rm(releaseFile, { force: true });
    const barrierScript = `const fs=require("node:fs"); const f=${JSON.stringify(releaseFile)}; const t=setInterval(() => { if (fs.existsSync(f)) { clearInterval(t); console.log("parallel-done"); } }, 25);`;
    const started = await Promise.all([
      delegateJobs.startDelegateJob(options(barrierScript, 8_000)),
      delegateJobs.startDelegateJob(options(barrierScript, 8_000)),
    ]);

    expect(new Set(started.map((job) => job.jobId)).size).toBe(2);
    expect(started.every((job) => ["starting", "running"].includes(job.status))).toBe(true);
    const active = await delegateJobs.listDelegateJobs();
    expect(active.filter((job) => ["starting", "running", "cancelling"].includes(job.status))).toHaveLength(2);

    await fs.writeFile(releaseFile, "release", "utf8");
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

  it("marks exit 0 without declared output evidence as unverified", async () => {
    const started = await delegateJobs.startDelegateJob(options('console.log("exit-only")'));
    const finished = await waitForTerminal(started.jobId);
    expect(finished.status).toBe("succeeded"); // legacy process state
    expect(finished.completionState).toBe("unverified");
    expect(finished.artifactEvidence).toBeUndefined();
  }, 15_000);

  it("verifies creation and content updates with bounded persisted SHA-256 evidence", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-artifact-proof-"));
    try {
      await fs.writeFile(path.join(workspace, "updated.txt"), "before");
      const request = {
        ...options('const f = require("fs"); f.writeFileSync("created.txt", "new"); f.writeFileSync("updated.txt", "after");'),
        cwd: workspace, workspaceRoot: workspace,
        expectedArtifacts: ["created.txt", "updated.txt"],
      };
      const started = await delegateJobs.startDelegateJob(request);
      expect(["pending", "artifacts_verified"]).toContain(started.completionState);
      const final = await waitForTerminal(started.jobId);
      expect(final.status).toBe("succeeded");
      expect(final.completionState).toBe("artifacts_verified");
      expect(final.artifactEvidence?.map(item => item.state)).toEqual(["created", "updated"]);
      expect(final.artifactEvidence?.every(item => /^[a-f0-9]{64}$/.test(item.sha256 ?? ""))).toBe(true);
      expect(final.artifactEvidence?.map(item => item.bytes)).toEqual([3, 5]);
      const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
      const displayed = await cliBridgeTool.execute({ action: "delegate.get", jobId: started.jobId }, workspace);
      expect(String(displayed)).toContain("Completion proof: artifacts_verified");
      expect(String(displayed)).toContain("created.txt created sha256=");
      const files = await fs.readFile(path.join(configDir, "cli-bridge", "delegations", "jobs.json"), "utf8");
      expect(files).toContain('"completionState": "artifacts_verified"');
      expect(files).not.toContain('"new"');
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("refuses missing or unchanged artifacts despite successful CLI exit", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-artifact-fail-"));
    try {
      await fs.writeFile(path.join(workspace, "old.txt"), "unchanged");
      const started = await delegateJobs.startDelegateJob({
        ...options('console.log("no file edits");'),
        cwd: workspace, workspaceRoot: workspace,
        expectedArtifacts: ["old.txt", "missing.txt"],
      });
      const final = await waitForTerminal(started.jobId);
      expect(final.exitCode).toBe(0);
      expect(final.status).toBe("verification_failed");
      expect(final.completionState).toBe("artifact_verification_failed");
      expect(final.artifactEvidence?.map(item => item.state)).toEqual(["unchanged", "missing"]);
      expect(final.error).toMatch(/not newly created or changed/i);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("reserves overlapping output claims atomically but allows independent parallel output jobs", async () => {
    process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "3";
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-artifact-lock-"));
    try {
      const script = 'const fs = require("fs"); setTimeout(() => fs.writeFileSync(process.argv[1], "done"), 500);';
      const first = await delegateJobs.startDelegateJob({
        ...options(script, 5000), cwd: workspace, workspaceRoot: workspace,
        args: ["-e", script, "one.txt"], expectedArtifacts: ["one.txt"],
      });
      await expect(delegateJobs.startDelegateJob({
        ...options(script, 5000), cwd: workspace, workspaceRoot: workspace,
        args: ["-e", script, "one.txt"], expectedArtifacts: ["one.txt"],
      })).rejects.toThrow(/claim already held/i);
      const other = await delegateJobs.startDelegateJob({
        ...options(script, 5000), cwd: workspace, workspaceRoot: workspace,
        args: ["-e", script, "two.txt"], expectedArtifacts: ["two.txt"],
      });
      const [firstFinal, otherFinal] = await Promise.all([waitForTerminal(first.jobId), waitForTerminal(other.jobId)]);
      expect(firstFinal.completionState).toBe("artifacts_verified");
      expect(otherFinal.completionState).toBe("artifacts_verified");
      const reuse = await delegateJobs.startDelegateJob({
        ...options('require("fs").writeFileSync("one.txt", "changed again")'),
        cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["one.txt"],
      });
      expect((await waitForTerminal(reuse.jobId)).completionState).toBe("artifacts_verified");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("rejects invalid, foreign and symlinked artifact expectations before running children", async () => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-artifact-validation-"));
    const a = path.join(fixture, "A");
    const b = path.join(fixture, "B");
    await fs.mkdir(a);
    await fs.mkdir(b);
    try {
      for (const filename of ["../B/file.txt", path.join(b, "file.txt"), "./", "same/../../B/file.txt"]) {
        await expect(delegateJobs.startDelegateJob({
          ...options('console.log("must not execute")'), cwd: a, workspaceRoot: a,
          expectedArtifacts: [filename],
        })).rejects.toThrow(/outside|relative|regular file/i);
      }
      await expect(delegateJobs.startDelegateJob({
        ...options('console.log("invalid")'), cwd: a, workspaceRoot: a, expectedArtifacts: ["duplicate.txt", "duplicate.txt"],
      })).rejects.toThrow(/duplicate/i);
      const link = path.join(a, "foreign");
      try {
        await fs.symlink(b, link, process.platform === "win32" ? "junction" : "dir");
        await expect(delegateJobs.startDelegateJob({
          ...options('console.log("invalid")'), cwd: a, workspaceRoot: a, expectedArtifacts: ["foreign/file.txt"],
        })).rejects.toThrow(/outside/i);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
      }
    } finally {
      await fs.rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("exposes artifact verification through delegate.start, get and tail without trusting stdout", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cli-proof-tool-"));
    try {
      const result = await cliBridgeTool.execute({
        action: "delegate.start", cli: "custom", binary: process.execPath,
        prompt: "Produce the evidence file",
        args: ["-e", 'require("fs").writeFileSync("proof.txt", "proof content")'],
        cwd: workspace, expectedArtifacts: ["proof.txt"],
        skillAutoDetect: false, injectArtifacts: false,
      }, workspace);
      const id = String(result).match(/clj_\d+_[a-f0-9]+/)?.[0];
      expect(id).toBeTruthy();
      expect(String(result)).toMatch(/Completion proof: (pending|artifacts_verified)/);
      const final = await waitForTerminal(id!);
      expect(final.completionState).toBe("artifacts_verified");
      const status = await cliBridgeTool.execute({ action: "delegate.get", jobId: id }, workspace);
      const tail = await cliBridgeTool.execute({ action: "delegate.tail", jobId: id }, workspace);
      expect(String(status)).toContain("Completion proof: artifacts_verified");
      expect(String(status)).toContain("proof.txt created sha256=");
      expect(String(tail)).toContain("proof=artifacts_verified");
      expect(String(await cliBridgeTool.execute({
        action: "delegate", cli: "custom", binary: process.execPath,
        prompt: "No silent proof ignore", expectedArtifacts: ["another.txt"],
      }, workspace))).toMatch(/requires action=delegate.start/i);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("does not report verified for failed, timed-out or cancelled processes", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-artifact-terminal-"));
    try {
      const failed = await delegateJobs.startDelegateJob({
        ...options('require("fs").writeFileSync("bad.txt", "partial"); process.exit(4);'),
        cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["bad.txt"],
      });
      const failure = await waitForTerminal(failed.jobId);
      expect(failure.status).toBe("failed");
      expect(failure.completionState).toBe("failed");

      const timeout = await delegateJobs.startDelegateJob({
        ...options('setTimeout(() => require("fs").writeFileSync("too-late.txt", "late"), 8000);', 1000),
        cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["too-late.txt"],
      });
      const timed = await waitForTerminal(timeout.jobId);
      expect(timed.status).toBe("timed_out");
      expect(timed.completionState).toBe("timed_out");

      const cancelled = await delegateJobs.startDelegateJob({
        ...options('setTimeout(() => require("fs").writeFileSync("cancel.txt", "late"), 8000);', 10000),
        cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["cancel.txt"],
      });
      expect((await delegateJobs.cancelDelegateJob(cancelled.jobId)).ok).toBe(true);
      const terminal = await waitForTerminal(cancelled.jobId);
      expect(terminal.status).toBe("cancelled");
      expect(terminal.completionState).toBe("cancelled");
      expect([failure, timed, terminal].every(job => job.completionState !== "artifacts_verified")).toBe(true);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 25_000);

  it("rejects oversized evidence and canonicalizes an in-workspace symlink alias for conflict detection", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-artifact-limit-"));
    const actualDir = path.join(workspace, "actual");
    const aliasDir = path.join(workspace, "alias");
    await fs.mkdir(actualDir);
    try {
      const oversized = await delegateJobs.startDelegateJob({
        ...options('require("fs").writeFileSync("huge.bin", Buffer.alloc(10*1024*1024+1));'),
        cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["huge.bin"],
      });
      const final = await waitForTerminal(oversized.jobId);
      expect(final.status).toBe("verification_failed");
      expect(final.artifactEvidence?.[0].state).toBe("too_large");
      try {
        await fs.symlink(actualDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
        const first = await delegateJobs.startDelegateJob({
          ...options('setTimeout(() => require("fs").writeFileSync("actual/shared.txt", "ok"), 1500);'),
          cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["actual/shared.txt"],
        });
        await expect(delegateJobs.startDelegateJob({
          ...options('console.log("must not start")'), cwd: workspace, workspaceRoot: workspace,
          expectedArtifacts: ["alias/shared.txt"],
        })).rejects.toThrow(/claim already held/i);
        expect((await waitForTerminal(first.jobId)).completionState).toBe("artifacts_verified");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    } finally {
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 20_000);

  it("reports current runtime ownership without granting other workspaces access", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-recovery-A-"));
    const b = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-recovery-B-"));
    try {
      const started = await delegateJobs.startDelegateJob({
        ...options('setInterval(() => console.log("still-running"), 1000)', 10000),
        cwd: a, workspaceRoot: a,
      });
      const owned = await delegateJobs.getDelegateJob(started.jobId);
      expect(owned?.ownerPid).toBe(process.pid);
      if (process.platform === "win32" || process.platform === "linux") {
        expect(owned?.ownerProcessIdentity).toMatch(process.platform === "win32" ? /^win:\d{15,20}$/ : /^linux:[a-f0-9-]{36}:\d+$/);
      }
      const fromA = String(await cliBridgeTool.execute({ action: "delegate.recovery", jobId: started.jobId }, a));
      expect(fromA).toContain("Assessment: owned_by_this_runtime");
      expect(fromA).toContain("SuperAgent owner PID: " + process.pid);
      expect(fromA).toContain("Do not auto-kill, reattach, or unlock");
      const fromB = String(await cliBridgeTool.execute({ action: "delegate.recovery", jobId: started.jobId }, b));
      expect(fromB).toMatch(/not found in the authorized workspace/i);
      expect(fromB).not.toContain(started.jobId);
      await delegateJobs.cancelDelegateJob(started.jobId);
      expect((await waitForTerminal(started.jobId)).status).toBe("cancelled");
    } finally {
      await fs.rm(a, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
      await fs.rm(b, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 16_000);

  it("reconciles a foreign stale-looking job to review-required without auto-cancellation", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { persistJobShard, loadJobShards, jobShardPath } = await import("../src/core/tools/cliBridgeJobStore.js");
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-orphan-A-"));
    const b = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-orphan-B-"));
    const jobId = "clj_" + Date.now() + "_a1b2c3d4";
    const dir = path.join(configDir, "cli-bridge", "delegations");
    try {
      const snapshot = {
        jobId, cliAlias: "foreign-cli", binary: process.execPath,
        cwd: a, workspaceRoot: a, ownerPid: 2147483000,
        pid: 2147483001, status: "running" as const, completionState: "pending" as const,
        startedAt: Date.now(), updatedAt: Date.now(), exitCode: null,
        timedOut: false, timeoutMs: 5000,
        outputTail: "", outputBytes: 0, logPath: path.join(a, "orphan.log"),
      };
      await persistJobShard(dir, snapshot);
      const denied = String(await cliBridgeTool.execute({ action: "delegate.recovery", jobId }, b));
      expect(denied).toMatch(/not found in the authorized workspace/i);
      expect(denied).not.toContain(jobId);
      const fromA = String(await cliBridgeTool.execute({ action: "delegate.recovery", jobId }, a));
      expect(fromA).toContain("Manual review: required");
      expect(fromA).toContain("Stored status: unknown_outcome_review_required");
      expect(fromA).toContain("no automatic cancellation or lock removal");
      expect((await loadJobShards(dir)).find(job => job.jobId === jobId)?.status).toBe("unknown_outcome_review_required");
      const cancelled = String(await cliBridgeTool.execute({ action: "delegate.cancel", jobId }, a));
      expect(cancelled).toContain("already unknown_outcome_review_required");
      expect((await loadJobShards(dir)).find(job => job.jobId === jobId)?.status).toBe("unknown_outcome_review_required");
    } finally {
      await fs.rm(jobShardPath(dir, jobId), { recursive: true, force: true }).catch(() => {});
      await fs.rm(a, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
      await fs.rm(b, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 16_000);

  it("does not let a stale foreign active shard consume this runtime's admission count", async () => {
    const { persistJobShard, jobShardPath } = await import("../src/core/tools/cliBridgeJobStore.js");
    const foreign = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-foreign-admission-"));
    const id = "clj_" + Date.now() + "_aabbccdd";
    const dir = path.join(configDir, "cli-bridge", "delegations");
    const previousMax = process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
    try {
      process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = "1";
      await persistJobShard(dir, {
        jobId: id, cliAlias: "foreign-stale", binary: process.execPath,
        cwd: foreign, workspaceRoot: foreign, ownerPid: 2147483000,
        pid: 2147483001, status: "running", completionState: "pending",
        startedAt: Date.now(), updatedAt: Date.now(), exitCode: null,
        timedOut: false, timeoutMs: 5000,
        outputTail: "", outputBytes: 0, logPath: path.join(foreign, "stale.log"),
      });
      // Force the foreign shard into this process's read-only cache. It must
      // remain visible as evidence but must not count as an in-process running
      // reservation; the atomic host capacity slot is authoritative.
      await delegateJobs.listDelegateJobs();
      const started = await delegateJobs.startDelegateJob(options(
        'console.log("local-admission-ok")', 5000));
      const finished = await waitForTerminal(started.jobId);
      expect(finished.status).toBe("succeeded");
      expect(finished.outputTail).toContain("local-admission-ok");
    } finally {
      if (previousMax === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS;
      else process.env.SUPERAGENT_CLI_BRIDGE_MAX_JOBS = previousMax;
      await fs.rm(jobShardPath(dir, id), { recursive: true, force: true }).catch(() => {});
      await fs.rm(foreign, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 15_000);

  it("preserves PID-reuse evidence after reconciling a foreign record to review-required", async () => {
    const { cliBridgeTool } = await import("../src/core/tools/cliBridgeTool.js");
    const { persistJobShard, loadJobShards, jobShardPath } = await import("../src/core/tools/cliBridgeJobStore.js");
    const a = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-reused-pid-A-"));
    const b = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-reused-pid-B-"));
    const id = "clj_" + Date.now() + "_eeffbbcc";
    const dir = path.join(configDir, "cli-bridge", "delegations");
    try {
      await persistJobShard(dir, {
        jobId: id, cliAlias: "reused-pid-foreign", binary: process.execPath,
        cwd: a, workspaceRoot: a, ownerPid: process.pid,
        ownerProcessIdentity: "win:111111111111111111", pid: null,
        status: "running", completionState: "pending",
        startedAt: Date.now(), updatedAt: Date.now(), exitCode: null,
        timedOut: false, timeoutMs: 5000, outputTail: "", outputBytes: 0, logPath: path.join(a, "reused.log"),
      });
      const allowed = String(await cliBridgeTool.execute({ action: "delegate.recovery", jobId: id }, a));
      if (process.platform === "win32" || process.platform === "linux") {
        expect(allowed).toContain("Assessment: terminal");
        expect(allowed).toContain("Owner process start identity: mismatch");
      } else {
        expect(allowed).toContain("Owner process start identity: unknown");
      }
      expect(allowed).toContain("Manual review: required");
      const denied = String(await cliBridgeTool.execute({ action: "delegate.recovery", jobId: id }, b));
      expect(denied).toMatch(/not found in the authorized workspace/i);
      expect(denied).not.toContain(id);
      expect((await loadJobShards(dir)).find(job => job.jobId === id)?.status).toBe("unknown_outcome_review_required");
    } finally {
      await fs.rm(jobShardPath(dir, id), { recursive: true, force: true });
      await fs.rm(a, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
      await fs.rm(b, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 20_000);

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
