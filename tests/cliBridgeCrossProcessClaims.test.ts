import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireCrossProcessArtifactClaims, releaseCrossProcessArtifactClaims, inspectCrossProcessArtifactClaim } from "../src/core/tools/cliBridgeCrossProcessClaims.js";
import { artifactClaimIdentity } from "../src/core/tools/cliBridgeArtifactEvidence.js";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";
import { startDelegateJob, getDelegateJob, __resetDelegateJobsForTests } from "../src/core/tools/cliBridgeDelegateJobs.js";

const worker = fileURLToPath(new URL("./fixtures/cliBridgeCrossProcessWorker.mjs", import.meta.url));
const spawned: ChildProcessWithoutNullStreams[] = [];

function startWorker(mode: "claim" | "delegation" | "shared-metadata", identity: string, jobId: string, configDir?: string) {
  const proc = spawn(process.execPath, ["--import", "tsx", worker, mode, identity, jobId, configDir ?? ""], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, SUPERAGENT_CONFIG_DIR: configDir ?? process.env.SUPERAGENT_CONFIG_DIR },
  });
  spawned.push(proc);
  const lines: string[] = [];
  let pending = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    for (;;) {
      const index = pending.indexOf("\n");
      if (index < 0) break;
      lines.push(pending.slice(0, index).trim());
      pending = pending.slice(index + 1);
    }
  });
  proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return { proc, lines, get stderr() { return stderr; } };
}
async function lineStarting(output: ReturnType<typeof startWorker>, prefix: string, maxWaitMs = 12_000): Promise<string> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const found = output.lines.find(line => line.startsWith(prefix));
    if (found) return found.slice(prefix.length);
    if (output.proc.exitCode !== null) throw new Error("Worker exited: " + output.stderr);
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for worker line " + prefix + " " + output.stderr);
}
async function waitExit(proc: ChildProcessWithoutNullStreams, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Worker did not terminate");
}
const identity = (suffix: string) => path.join(os.tmpdir(), "cross-proc-claim-" + crypto.randomUUID(), suffix);
const unique = (name: string) => crypto.createHash("sha256").update(name).digest("hex");

afterEach(async () => {
  for (const proc of spawned.splice(0)) {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await waitExit(proc).catch(() => {});
  }
  await __resetDelegateJobsForTests();
});

describe("Hermes Phase 4: same-host cross-process artifact claims", () => {
  it("preserves independent jobs with two processes using the same config directory", async () => {
    const config = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-shared-metadata-"));
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-shared-workspace-"));
    try {
      const first = startWorker("shared-metadata", workspace, "first", config);
      const second = startWorker("shared-metadata", workspace, "second", config);
      const [one, two] = await Promise.all([
        lineStarting(first, "JOB "),
        lineStarting(second, "JOB "),
      ]);
      const firstId = JSON.parse(one).jobId;
      const secondId = JSON.parse(two).jobId;
      expect(firstId).not.toBe(secondId);
      await Promise.all([
        lineStarting(first, "TERMINAL ", 18_000),
        lineStarting(second, "TERMINAL ", 18_000),
      ]);
      const { loadJobShards } = await import("../src/core/tools/cliBridgeJobStore.js");
      const dir = path.join(config, "cli-bridge", "delegations");
      const all = await loadJobShards(dir);
      const matches = all.filter(job => [firstId, secondId].includes(job.jobId));
      expect(matches).toHaveLength(2);
      expect(matches.every(job => job.status === "succeeded" && job.completionState === "unverified")).toBe(true);
    } finally {
      await fs.rm(config, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 30_000);

  it("blocks another process even with separate config dirs, then releases on normal exit", async () => {
    const file = identity("normal.txt");
    const holder = startWorker("claim", file, "worker-owner", path.join(os.tmpdir(), "unique-config-A"));
    const claim = JSON.parse(await lineStarting(holder, "CLAIM "));
    const diag = await inspectCrossProcessArtifactClaim(file);
    expect(diag).toMatchObject({ locked: true, jobId: "worker-owner", ownerPid: holder.proc.pid });
    await expect(acquireCrossProcessArtifactClaims([file], "other-owner"))
      .rejects.toThrow(/claim already held by another process/);
    holder.proc.stdin.write("release\n");
    await lineStarting(holder, "RELEASED");
    await waitExit(holder.proc);
    expect((await inspectCrossProcessArtifactClaim(file)).locked).toBe(false);
    const retry = await acquireCrossProcessArtifactClaims([file], "other-owner");
    await releaseCrossProcessArtifactClaims(retry);
    expect(claim.locks).toHaveLength(1);
  }, 20_000);

  it("rolls back partially acquired multi-file claims when a later claim conflicts", async () => {
    const names = [identity("one"), identity("two")].sort((a, b) => unique(a).localeCompare(unique(b)));
    const holder = startWorker("claim", names[1], "late-holder");
    await lineStarting(holder, "CLAIM ");
    await expect(acquireCrossProcessArtifactClaims(names, "loser")).rejects.toThrow(/already held/);
    expect((await inspectCrossProcessArtifactClaim(names[0])).locked).toBe(false);
    holder.proc.stdin.write("release\n");
    await lineStarting(holder, "RELEASED");
    await waitExit(holder.proc);
    const claimed = await acquireCrossProcessArtifactClaims(names, "winner");
    await releaseCrossProcessArtifactClaims(claimed);
  }, 20_000);

  it("keeps orphaned claims blocked after process crash until explicit owner-token cleanup", async () => {
    const file = identity("crash.txt");
    const holder = startWorker("claim", file, "crashed-owner");
    const snapshot = JSON.parse(await lineStarting(holder, "CLAIM "));
    holder.proc.kill();
    await waitExit(holder.proc);
    expect((await inspectCrossProcessArtifactClaim(file)).locked).toBe(true);
    await expect(acquireCrossProcessArtifactClaims([file], "new-owner")).rejects.toThrow(/already held/);
    // Simulate explicit recovery only AFTER an operator has confirmed all
    // inherited child processes have exited (this test worker has none).
    await releaseCrossProcessArtifactClaims(snapshot);
    expect((await inspectCrossProcessArtifactClaim(file)).locked).toBe(false);
  }, 20_000);

  it("refuses a forged/stale owner token and keeps the original claim", async () => {
    const file = identity("token.txt");
    const holder = startWorker("claim", file, "token-owner");
    const snapshot = JSON.parse(await lineStarting(holder, "CLAIM "));
    await expect(releaseCrossProcessArtifactClaims({
      jobId: snapshot.jobId,
      locks: snapshot.locks.map((lock: any) => ({ ...lock, token: "invalid" })),
    })).rejects.toThrow(/ownership mismatch/);
    expect((await inspectCrossProcessArtifactClaim(file)).locked).toBe(true);
    holder.proc.stdin.write("release\n");
    await lineStarting(holder, "RELEASED");
    await waitExit(holder.proc);
  }, 20_000);

  it("exposes only read-only lock diagnostics for authorized workspace paths", async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-lock-diagnostics-A-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-lock-diagnostics-B-"));
    try {
      const file = path.join(rootA, "output.txt");
      const identity = artifactClaimIdentity(file);
      const owner = startWorker("claim", identity, "diagnostic-owner");
      const held = JSON.parse(await lineStarting(owner, "CLAIM "));
      const status = String(await cliBridgeTool.execute({
        action: "delegate.claims", expectedArtifacts: ["output.txt"],
      }, rootA));
      expect(status).toContain("output.txt | LOCKED");
      expect(status).toContain("job=diagnostic-owner");
      expect(status).toContain("manual recovery");
      expect(status).not.toContain(held.locks[0].token);
      const denied = String(await cliBridgeTool.execute({
        action: "delegate.claims", cwd: rootA, expectedArtifacts: ["output.txt"],
      }, rootB));
      expect(denied).toMatch(/outside the authorized workspace/i);
      expect(denied).not.toContain("diagnostic-owner");
      const deniedPath = String(await cliBridgeTool.execute({
        action: "delegate.claims", expectedArtifacts: ["../private.txt"],
      }, rootA));
      expect(deniedPath).toMatch(/outside|relative/i);
      owner.proc.stdin.write("release\n");
      await lineStarting(owner, "RELEASED");
      await waitExit(owner.proc);
      const free = String(await cliBridgeTool.execute({
        action: "delegate.claims", expectedArtifacts: ["output.txt"],
      }, rootA));
      expect(free).toContain("output.txt | available");
    } finally {
      await fs.rm(rootA, { recursive: true, force: true });
      await fs.rm(rootB, { recursive: true, force: true });
    }
  }, 20_000);

  it("applies host-local claims to real CLI background delegations across two instances", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cross-job-"));
    const otherConfig = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-cross-config-"));
    try {
      const holder = startWorker("delegation", workspace, "unused", otherConfig);
      const started = JSON.parse(await lineStarting(holder, "JOB "));
      expect(started.status).toMatch(/running|starting/);
      await expect(startDelegateJob({
        cliAlias: "test", binary: process.execPath, prompt: "should not run",
        cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["output.txt"],
        args: ["-e", 'require("fs").writeFileSync("output.txt", "unsafe")'],
        timeoutMs: 5000,
      })).rejects.toThrow(/claim already held/);
      const complete = JSON.parse(await lineStarting(holder, "TERMINAL ", 15_000));
      expect(complete).toMatchObject({ status: "succeeded", completionState: "artifacts_verified" });
      await waitExit(holder.proc);
      const reuse = await startDelegateJob({
        cliAlias: "test", binary: process.execPath, prompt: "new writer",
        cwd: workspace, workspaceRoot: workspace, expectedArtifacts: ["output.txt"],
        args: ["-e", 'require("fs").writeFileSync("output.txt", "new-writer")'],
        timeoutMs: 5000,
      });
      const deadline = Date.now() + 6_000;
      let finished = await getDelegateJob(reuse.jobId);
      while (finished && ["starting", "running", "cancelling"].includes(finished.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
        finished = await getDelegateJob(reuse.jobId);
      }
      expect(finished?.completionState).toBe("artifacts_verified");
    } finally {
      await __resetDelegateJobsForTests();
      await fs.rm(workspace, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
      await fs.rm(otherConfig, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
    }
  }, 25_000);
});
