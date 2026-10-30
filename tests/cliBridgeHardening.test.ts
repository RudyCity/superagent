import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cliBridgeTool } from "../src/core/tools/cliBridgeTool.js";
import { acquireCliBridgeCapacity, listCliBridgeCapacity, releaseCliBridgeCapacity } from "../src/core/tools/cliBridgeCapacity.js";
import { readBoundedLogTail, redactCliBridgeOutput, summarizedPrompt } from "../src/core/tools/cliBridgeObservability.js";
import { builtinProfiles } from "../src/core/tools/cliBridgeProfiles.js";
import * as delegateJobs from "../src/core/tools/cliBridgeDelegateJobs.js";

const homeBefore = process.env.SUPERAGENT_CONFIG_DIR;
const slotBefore = process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR;
const root = path.join(os.tmpdir(), "cli-bridge-hardening-" + process.pid);
async function completed(id: string) {
  for (let n = 0; n < 120; n++) {
    const job = await delegateJobs.getDelegateJob(id);
    if (job && !["starting", "running", "cancelling"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("job did not complete: " + id);
}
beforeAll(async () => {
  process.env.SUPERAGENT_CONFIG_DIR = path.join(root, "config");
  process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = path.join(root, "host-capacity");
  await fs.mkdir(root, { recursive: true });
});
afterEach(async () => { await delegateJobs.__resetDelegateJobsForTests(); });
afterAll(async () => {
  if (homeBefore === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = homeBefore;
  if (slotBefore === undefined) delete process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR;
  else process.env.SUPERAGENT_CLI_BRIDGE_CAPACITY_DIR = slotBefore;
  await fs.rm(root, { recursive: true, force: true });
});

describe("CLI Bridge hardened delegate behavior", () => {
  it("never configures unrestricted AGY permissions by default", () => {
    expect(builtinProfiles().agy.defaultArgs).toEqual(["--mode", "accept-edits"]);
    expect(builtinProfiles().agy.defaultArgs).not.toContain("--dangerously-skip-permissions");
  });
  it("rejects AGY mode escalation hidden in extra flags before dispatch", async () => {
    const result = await cliBridgeTool.execute({
      action: "delegate", cli: "agy", prompt: "No work",
      args: ["--dangerously-skip-permissions"], injectArtifacts: false,
    }, root);
    // When AGY is not installed, an unavailable CLI is also fail-closed.
    expect(String(result)).toMatch(/permission flags must be selected|not available/i);
  });
  it("wait=false starts a pollable background job and includes heartbeat diagnostics", async () => {
    const result = String(await cliBridgeTool.execute({
      action: "delegate", wait: false, cli: "custom", binary: process.execPath,
      args: ["-e", 'console.log("background-alive")'], prompt: "background test",
      injectArtifacts: false, skillAutoDetect: false, timeoutMs: 8_000,
    }, root));
    const id = result.match(/clj_\d+_[a-f0-9]+/)?.[0];
    expect(id).toBeTruthy();
    const finished = await completed(id!);
    expect(finished.status).toBe("succeeded");
    expect(finished.heartbeatAt).toBeGreaterThan(0);
    expect(finished.lastOutputAt).toBeGreaterThan(0);
    const status = String(await cliBridgeTool.execute({ action: "delegate.get", jobId: id }, root));
    expect(status).toContain("Bridge heartbeat:");
    expect(status).toContain("Silent for:");
    expect(status).toContain("background-alive");
  }, 20_000);
  it("idempotency key returns an existing job instead of running duplicate work", async () => {
    const task = {
      action: "delegate.start", cli: "custom", binary: process.execPath,
      args: ["-e", 'console.log("once");'], prompt: "same task",
      injectArtifacts: false, skillAutoDetect: false, timeoutMs: 8_000,
      idempotencyKey: "same-request-v1",
    };
    const first = String(await cliBridgeTool.execute(task, root));
    const id = first.match(/clj_\d+_[a-f0-9]+/)?.[0];
    expect(id).toBeTruthy();
    const repeat = String(await cliBridgeTool.execute(task, root));
    expect(repeat).toContain(id!);
    const invalid = String(await cliBridgeTool.execute({ ...task, prompt: "different task" }, root));
    expect(invalid).toMatch(/already belongs to another/i);
    expect((await completed(id!)).status).toBe("succeeded");
  }, 20_000);
  it("retry requires a fresh prompt and refuses retry while the original job is active", async () => {
    const first = String(await cliBridgeTool.execute({
      action: "delegate.start", cli: "custom", binary: process.execPath,
      args: ["-e", "setTimeout(() => console.log('one'), 600);"],
      prompt: "original", injectArtifacts: false, skillAutoDetect: false, timeoutMs: 8_000,
    }, root));
    const id = first.match(/clj_\d+_[a-f0-9]+/)?.[0]!;
    expect(String(await cliBridgeTool.execute({ action: "delegate.retry", jobId: id, prompt: "again" }, root))).toMatch(/still active/i);
    await completed(id);
    expect(String(await cliBridgeTool.execute({ action: "delegate.retry", jobId: id }, root))).toMatch(/fresh explicit prompt/i);
    const again = String(await cliBridgeTool.execute({
      action: "delegate.retry", jobId: id, prompt: "repeat with fresh instruction",
      binary: process.execPath, args: ["-e", 'console.log("two")'],
      injectArtifacts: false, skillAutoDetect: false, timeoutMs: 8_000,
    }, root));
    const another = again.match(/clj_\d+_[a-f0-9]+/)?.[0];
    expect(another).toBeTruthy();
    expect(another).not.toBe(id);
    expect((await completed(another!)).status).toBe("succeeded");
  }, 20_000);
  it("decodes incremental AGY progress into visible job stage without exposing raw data as code", async () => {
    const script = 'console.log(JSON.stringify({event:"init"}));' +
      'console.log(JSON.stringify({event:"step_update",step_update:{step_type:"tool_call",state:"ACTIVE"}}));';
    const job = await delegateJobs.startDelegateJob({
      cliAlias: "agy", binary: process.execPath, cwd: root,
      workspaceRoot: root, prompt: "progress test", args: ["-e", script], timeoutMs: 8000,
    });
    const finished = await completed(job.jobId);
    expect(finished.activityEvents).toBeGreaterThanOrEqual(2);
    expect(finished.currentStage).toBe("tool_call: ACTIVE");
    expect(finished.lastProgressAt).toBeGreaterThan(0);
    const status = String(await cliBridgeTool.execute({ action: "delegate.get", jobId: job.jobId }, root));
    expect(status).toContain("Current stage: tool_call: ACTIVE");
    expect(String(await cliBridgeTool.execute({ action: "delegate.health" }, root))).toContain("CLI Bridge project job health");
  }, 20_000);
  it("classifies bounded AGY probes and warns before terminating only stale probes", () => {
    expect(delegateJobs.classifyAgyToolCommand("echo hello")).toBe("probe");
    expect(delegateJobs.classifyAgyToolCommand("rudy --version")).toBe("probe");
    expect(delegateJobs.classifyAgyToolCommand("Get-ChildItem -Path . | Select-Object Name")).toBe("probe");
    expect(delegateJobs.classifyAgyToolCommand("rudy train.rdy --epochs 3")).toBe("general");

    const started = 1_000;
    const base = {
      cliAlias: "agy",
      activeToolName: "run_command",
      activeToolStartedAt: started,
      lastProgressAt: started,
    } as const;
    const warn = delegateJobs.assessAgyToolStall({ ...base, activeToolClass: "general" }, started + 95_000);
    expect(warn.stalled).toBe(true);
    expect(warn.terminate).toBe(false);
    const probe = delegateJobs.assessAgyToolStall({ ...base, activeToolClass: "probe" }, started + 125_000);
    expect(probe.stalled).toBe(true);
    expect(probe.terminate).toBe(true);
  });
  it("reserves slots atomically, never steals a competing slot and releases its own", async () => {
    const lease = await acquireCliBridgeCapacity(1, "a");
    expect(lease.index).toBe(0);
    expect((await listCliBridgeCapacity(1))[0].occupied).toBe(true);
    await expect(acquireCliBridgeCapacity(1, "b")).rejects.toThrow(/slots are full/);
    await expect(releaseCliBridgeCapacity({ ...lease, token: "forged" })).rejects.toThrow(/token mismatch/);
    await releaseCliBridgeCapacity(lease);
    const second = await acquireCliBridgeCapacity(1, "b");
    await releaseCliBridgeCapacity(second);
    expect((await listCliBridgeCapacity(1))[0].occupied).toBe(false);
  });
  it("does not store raw synchronous prompts and best-effort redacts common credentials", async () => {
    const prompt = "MY_PRIVATE_PROMPT SECRET_API_KEY=abcdefghijklmnopqrst";
    expect(summarizedPrompt(prompt)).not.toContain(prompt);
    expect(redactCliBridgeOutput("Authorization: Bearer abc123 xyz API_KEY=secret123"))
      .not.toContain("secret123");
    const result = String(await cliBridgeTool.execute({
      action: "delegate", cli: "custom", binary: process.execPath,
      args: ["-e", 'console.log("API_KEY=supersecretvalue")'], prompt,
      injectArtifacts: false, skillAutoDetect: false, timeoutMs: 8_000,
    }, root));
    const logPath = result.match(/Full log: ([^\r\n]+)/)?.[1];
    expect(logPath).toBeTruthy();
    const log = await fs.readFile(logPath!, "utf8");
    expect(log).not.toContain("MY_PRIVATE_PROMPT");
    expect(log).not.toContain("abcdefghijklmnopqrst");
    expect(log).not.toContain("supersecretvalue");
    expect(log).toContain("sha256=");
  }, 20_000);
  it("reads a bounded log tail without losing the last line", async () => {
    const filename = path.join(root, "large.log");
    await fs.writeFile(filename, "noisy start\n" + "x".repeat(2_000_000) + "\nlast line\n");
    const tail = await readBoundedLogTail(filename, 2, 8192);
    expect(tail).toContain("last line");
    expect(tail.length).toBeLessThan(8192);
    expect(tail).not.toContain("noisy start");
  });
});
