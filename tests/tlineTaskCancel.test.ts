import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareTlineCancel, confirmTlineCancel, __resetTlineCancelChallengesForTests,
  type CancelJobDeps } from "../src/core/channels/tlineTaskCancel.js";
import type { DelegateJob } from "../src/core/tools/cliBridgeDelegateJobs.js";
import { buildTlineCapabilityManifest } from "../src/core/channels/tlineCapabilities.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sa-tline-operator-"));
const mine = path.join(root, "mine");
const other = path.join(root, "other");
fs.mkdirSync(mine); fs.mkdirSync(other);
const jobId = "clj_1792480000000_deadbeef";
const job: DelegateJob = {
  jobId, cliAlias: "agy", binary: "agy", cwd: mine, workspaceRoot: mine,
  pid: 99999, ownerPid: process.pid, status: "running",
  startedAt: 10, updatedAt: 11, exitCode: null, timedOut: false, timeoutMs: 10000,
  outputTail: "", outputBytes: 0, logPath: "private", completionState: "pending",
};
function mock(): { deps: CancelJobDeps; cancelled: string[]; setEnabled: (v: boolean) => void;
  setJob: (j: DelegateJob) => void; setTime: (t: number) => void; setOwned: (v: boolean) => void } {
  let current = { ...job };
  let enabled = true, now = 100, owned = true;
  const cancelled: string[] = [];
  return {
    deps: {
      getJob: async () => ({ ...current }),
      getRecovery: async () => ({ assessment: owned ? "owned_by_this_runtime" : "owner_pid_present_unverified" }),
      cancel: async id => { cancelled.push(id); return { ok: true, message: "requested" }; },
      enabled: () => enabled, now: () => now,
    }, cancelled,
    setEnabled: v => { enabled = v; },
    setJob: j => { current = { ...j }; },
    setTime: t => { now = t; },
    setOwned: v => { owned = v; },
  };
}
const scope = { workspace: mine, sessionId: "sess_mine", jobId };
describe("T-Line opt-in 2-phase CLI cancel guard", () => {
  beforeEach(() => __resetTlineCancelChallengesForTests());
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
  it("does not advertise operator mutations without explicit process opt-in", () => {
    const old = process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL;
    delete process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL;
    expect(buildTlineCapabilityManifest("test").httpActions.some(a => a.id === "tasks.cancel.prepare")).toBe(false);
    process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL = "1";
    expect(buildTlineCapabilityManifest("test").httpActions.some(a => a.id === "tasks.cancel.confirm")).toBe(true);
    if (old === undefined) delete process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL;
    else process.env.SUPERAGENT_TLINE_WORKSPACE_CANCEL = old;
  });
  it("requires operator enablement, exact workspace and a current runtime-owned process handle", async () => {
    const m = mock();
    m.setEnabled(false);
    expect((await prepareTlineCancel(scope, m.deps)).status).toBe(403);
    m.setEnabled(true);
    expect((await prepareTlineCancel({ ...scope, workspace: other }, m.deps)).status).toBe(403);
    m.setOwned(false);
    expect((await prepareTlineCancel(scope, m.deps)).status).toBe(403);
    m.setOwned(true);
    m.setJob({ ...job, ownerPid: 42 });
    expect((await prepareTlineCancel(scope, m.deps)).status).toBe(403);
    m.setJob({ ...job, status: "succeeded" });
    expect((await prepareTlineCancel(scope, m.deps)).status).toBe(403);
    expect(m.cancelled).toEqual([]);
  });
  it("demands explicit prepare and consumes the challenge before killing anything", async () => {
    const m = mock();
    const first = await prepareTlineCancel(scope, m.deps);
    expect(first.status).toBe(200);
    expect(m.cancelled).toEqual([]);
    const challenge = first.body.challenge!;
    expect((await confirmTlineCancel({ ...scope, challenge }, m.deps)).status).toBe(202);
    expect(m.cancelled).toEqual([jobId]);
    expect((await confirmTlineCancel({ ...scope, challenge }, m.deps)).status).toBe(403);
    expect(m.cancelled).toEqual([jobId]);
  });
  it("denies mismatched session and expired/forged challenges", async () => {
    const m = mock();
    const fresh = await prepareTlineCancel(scope, m.deps);
    expect((await confirmTlineCancel({ ...scope, sessionId: "sess_other", challenge: fresh.body.challenge! }, m.deps)).status).toBe(403);
    expect((await confirmTlineCancel({ ...scope, challenge: fresh.body.challenge! }, m.deps)).status).toBe(403);
    const expired = await prepareTlineCancel(scope, m.deps);
    m.setTime(31_000);
    expect((await confirmTlineCancel({ ...scope, challenge: expired.body.challenge! }, m.deps)).status).toBe(403);
    expect(m.cancelled).toEqual([]);
  });
  it("prevents cancellation on a changed PID, revision, workspace or recovered stale owner", async () => {
    const m = mock();
    const prepared = await prepareTlineCancel(scope, m.deps);
    m.setJob({ ...job, pid: 12 });
    expect((await confirmTlineCancel({ ...scope, challenge: prepared.body.challenge! }, m.deps)).status).toBe(409);
    const prepared2 = await prepareTlineCancel(scope, m.deps);
    m.setJob({ ...job, updatedAt: 13 });
    expect((await confirmTlineCancel({ ...scope, challenge: prepared2.body.challenge! }, m.deps)).status).toBe(409);
    expect(m.cancelled).toEqual([]);
  });
});
