import { beforeEach, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildTlineCapabilityManifest } from "../src/core/channels/tlineCapabilities.js";
import { prepareTlineRetry, confirmTlineRetry, __clearTlineRetryPendingForTests,
  claimTlineRetryOnce, type RetryDeps } from "../src/core/channels/tlineTaskRetry.js";
import { jobShardPath } from "../src/core/tools/cliBridgeJobStore.js";
import type { DelegateJob } from "../src/core/tools/cliBridgeDelegateJobs.js";

const root = path.join(os.tmpdir(), "sa-tline-retry-test-" + process.pid);
const mine = path.join(root, "workspace");
const other = path.join(root, "other");
const jobId = "clj_1792480000000_deadbeef";
const input = { workspace: mine, sessionId: "sess_owner", jobId };
const instruction = "Please rebuild only the artifact under the expected path.";
const source: DelegateJob = {
  jobId, cliAlias: "codex", binary: "codex", cwd: mine,
  workspaceRoot: mine, creator: { clientMode: "tline", sessionId: "sess_owner", workspace: mine },
  expectedArtifacts: ["output.txt"], status: "verification_failed",
  artifactEvidence: [{ path: "output.txt", state: "missing" }],
  startedAt: 100, updatedAt: 200, pid: null, ownerPid: 123,
  exitCode: 1, timedOut: false, timeoutMs: 30_000, outputTail: "",
  outputBytes: 0, logPath: "private", completionState: "artifact_verification_failed",
};
function setup(): { deps: RetryDeps; launches: string[]; setSource: (v: DelegateJob) => void;
  setEnabled: (enabled: boolean) => void; setTime: (time: number) => void;
  setClaim: (value: boolean) => void; setThrow: (value: boolean) => void } {
  let job = { ...source };
  let enabled = true, now = 1000, claimed = true, shouldThrow = false;
  const launches: string[] = [];
  return {
    deps: {
      enabled: () => enabled, now: () => now,
      getJob: async () => ({ ...job }),
      claim: async () => claimed,
      launch: async (_job, workspace, session, prompt) => {
        launches.push(JSON.stringify({ workspace, session, prompt }));
        if (shouldThrow) throw new Error("ambiguous");
        return "clj_1792480000001_feedface";
      },
    },
    launches,
    setSource: value => { job = { ...value }; },
    setEnabled: value => { enabled = value; },
    setTime: value => { now = value; },
    setClaim: value => { claimed = value; },
    setThrow: value => { shouldThrow = value; },
  };
}
beforeEach(async () => {
  __clearTlineRetryPendingForTests();
  await fs.mkdir(mine, { recursive: true });
  await fs.mkdir(other, { recursive: true });
});
afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
describe("opt-in, creator-verified, fresh-instruction TLine task retry", () => {
  it("advertises only under separate explicit operator switch", () => {
    const old = process.env.SUPERAGENT_TLINE_TASK_RETRY;
    try {
      delete process.env.SUPERAGENT_TLINE_TASK_RETRY;
      expect(buildTlineCapabilityManifest("test").httpActions.some(a => a.id === "tasks.retry.prepare")).toBe(false);
      process.env.SUPERAGENT_TLINE_TASK_RETRY = "1";
      expect(buildTlineCapabilityManifest("test").httpActions.some(a => a.id === "tasks.retry.confirm")).toBe(true);
    } finally {
      if (old === undefined) delete process.env.SUPERAGENT_TLINE_TASK_RETRY;
      else process.env.SUPERAGENT_TLINE_TASK_RETRY = old;
    }
  });
  it("fails closed on disabled, foreign workspace, session, completed, unsupported and legacy jobs", async () => {
    const { deps, launches, setSource, setEnabled } = setup();
    setEnabled(false);
    expect((await prepareTlineRetry({ ...input, prompt: instruction }, deps)).status).toBe(403);
    setEnabled(true);
    expect((await prepareTlineRetry({ ...input, workspace: other, prompt: instruction }, deps)).status).toBe(403);
    expect((await prepareTlineRetry({ ...input, sessionId: "sess_other", prompt: instruction }, deps)).status).toBe(403);
    setSource({ ...source, creator: undefined });
    expect((await prepareTlineRetry({ ...input, prompt: instruction }, deps)).status).toBe(403);
    setSource({ ...source, status: "succeeded" });
    expect((await prepareTlineRetry({ ...input, prompt: instruction }, deps)).status).toBe(403);
    setSource({ ...source, cliAlias: "agy" });
    expect((await prepareTlineRetry({ ...input, prompt: instruction }, deps)).status).toBe(403);
    setSource({ ...source, status: "failed", completionState: "failed" });
    expect((await prepareTlineRetry({ ...input, prompt: instruction }, deps)).status).toBe(403);
    setSource({ ...source, expectedArtifacts: undefined });
    expect((await prepareTlineRetry({ ...input, prompt: instruction }, deps)).status).toBe(403);
    setSource({ ...source, artifactEvidence: [{ path: "output.txt", state: "updated" }] });
    expect((await prepareTlineRetry({ ...input, prompt: instruction }, deps)).status).toBe(403);
    expect(launches).toHaveLength(0);
  });
  it("rejects a changed artifact fingerprint even if old job state is unchanged", async () => {
    const m = setup();
    const prepared = await prepareTlineRetry({ ...input, prompt: instruction }, m.deps);
    expect(prepared.status).toBe(200);
    await fs.writeFile(path.join(mine, "output.txt"), "edited after first attempt");
    try {
      expect((await confirmTlineRetry({ ...input, challenge: prepared.body.challenge! }, m.deps)).status).toBe(409);
      expect(m.launches).toHaveLength(0);
    } finally { await fs.rm(path.join(mine, "output.txt"), { force: true }); }
  });
  it("launches NEW instruction once after single-use challenge; rejects replay and changed source", async () => {
    const { deps, launches, setSource } = setup();
    const prepared = await prepareTlineRetry({ ...input, prompt: instruction }, deps);
    expect(prepared.status).toBe(200);
    expect(launches).toHaveLength(0);
    const challenge = prepared.body.challenge!;
    const outcome = await confirmTlineRetry({ ...input, challenge }, deps);
    expect(outcome.status).toBe(202);
    expect(outcome.body.newJobId).toMatch(/^clj_/);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toContain(instruction);
    expect((await confirmTlineRetry({ ...input, challenge }, deps)).status).toBe(403);
    const again = await prepareTlineRetry({ ...input, prompt: instruction + " again" }, deps);
    setSource({ ...source, updatedAt: 205 });
    expect((await confirmTlineRetry({ ...input, challenge: again.body.challenge! }, deps)).status).toBe(409);
    expect(launches).toHaveLength(1);
  });
  it("consumes wrong-session/expired token and fails closed on ambiguous launch or prior claim", async () => {
    const m = setup();
    const prepared = await prepareTlineRetry({ ...input, prompt: instruction }, m.deps);
    expect((await confirmTlineRetry({
      ...input, sessionId: "sess_foreign", challenge: prepared.body.challenge!,
    }, m.deps)).status).toBe(403);
    expect((await confirmTlineRetry({ ...input, challenge: prepared.body.challenge! }, m.deps)).status).toBe(403);
    const expired = await prepareTlineRetry({ ...input, prompt: instruction }, m.deps);
    m.setTime(60_000);
    expect((await confirmTlineRetry({ ...input, challenge: expired.body.challenge! }, m.deps)).status).toBe(403);
    const another = await prepareTlineRetry({ ...input, prompt: instruction }, m.deps);
    m.setClaim(false);
    expect((await confirmTlineRetry({ ...input, challenge: another.body.challenge! }, m.deps)).status).toBe(409);
    expect(m.launches).toHaveLength(0);
    m.setClaim(true); m.setThrow(true);
    const uncertain = await prepareTlineRetry({ ...input, prompt: instruction }, m.deps);
    expect((await confirmTlineRetry({ ...input, challenge: uncertain.body.challenge! }, m.deps)).status).toBe(409);
    expect(m.launches).toHaveLength(1);
  });
  it("atomically creates one durable claim per source job, including simultaneous calls", async () => {
    const original = process.env.SUPERAGENT_CONFIG_DIR;
    const config = path.join(root, "config");
    try {
      process.env.SUPERAGENT_CONFIG_DIR = config;
      const shard = jobShardPath(path.join(config, "cli-bridge", "delegations"), jobId);
      await fs.mkdir(shard, { recursive: true });
      const results = await Promise.all(Array.from({ length: 6 }, () => claimTlineRetryOnce(source, instruction)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await claimTlineRetryOnce(source, instruction)).toBe(false);
      const text = await fs.readFile(path.join(shard, "tline-retry-once.claim"), "utf8");
      expect(text).not.toContain(instruction);
      expect(JSON.parse(text).sourceJobId).toBe(jobId);
      expect(JSON.parse(text).promptSha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      if (original === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
      else process.env.SUPERAGENT_CONFIG_DIR = original;
    }
  });
});
