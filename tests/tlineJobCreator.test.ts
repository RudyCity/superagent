import { describe, expect, it, afterAll, beforeAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWithTrustedTlineCreator, getTlineCreatorForJob } from "../src/core/channels/tlineJobCreator.js";
import { canonicalCliWorkspace } from "../src/core/tools/cliBridgeWorkspaceScope.js";

const root = path.join(os.tmpdir(), "sa-tline-provenance-" + process.pid);
const work = path.join(root, "work");
const other = path.join(root, "other");
const originalConfig = process.env.SUPERAGENT_CONFIG_DIR;
beforeAll(async () => {
  await fs.mkdir(work, { recursive: true });
  await fs.mkdir(other, { recursive: true });
  process.env.SUPERAGENT_CONFIG_DIR = path.join(root, "config");
});
afterAll(async () => {
  if (originalConfig === undefined) delete process.env.SUPERAGENT_CONFIG_DIR;
  else process.env.SUPERAGENT_CONFIG_DIR = originalConfig;
  await fs.rm(root, { recursive: true, force: true });
});
describe("trusted creator context for CLI Bridge jobs", () => {
  it("never treats tool args or unrelated caller workspaces as an owner", async () => {
    expect(getTlineCreatorForJob(work)).toBeNull();
    await runWithTrustedTlineCreator({
      clientMode: "tline", sessionId: "sess_creator", workspace: work,
    }, async () => {
      expect(getTlineCreatorForJob(work)?.sessionId).toBe("sess_creator");
      expect(getTlineCreatorForJob(other)).toBeNull();
      await Promise.resolve();
      expect(getTlineCreatorForJob(work)?.sessionId).toBe("sess_creator");
    });
    expect(getTlineCreatorForJob(work)).toBeNull();
    expect(() => runWithTrustedTlineCreator({
      clientMode: "tline", sessionId: "../session", workspace: work,
    }, () => "bad")).toThrow();
  });
  it("keeps parallel asynchronous TLine session identities separated", async () => {
    const run = async (sessionId: string, delay: number) =>
      runWithTrustedTlineCreator({ clientMode: "tline", sessionId, workspace: work },
        async () => {
          await new Promise<void>(resolve => setTimeout(resolve, delay));
          return getTlineCreatorForJob(work)?.sessionId;
        });
    expect(await Promise.all([run("sess_a", 25), run("sess_b", 2)]))
      .toEqual(["sess_a", "sess_b"]);
  });
  it("attaches creator only when a background delegation starts under a trusted session", async () => {
    const { startDelegateJob, getDelegateJob, __resetDelegateJobsForTests } =
      await import("../src/core/tools/cliBridgeDelegateJobs.js");
    const args = {
      cliAlias: "test-node", binary: process.execPath, prompt: "safe test",
      cwd: work, workspaceRoot: work,
      args: ["-e", "console.log('done')"], timeoutMs: 15_000,
    };
    try {
      const started = await runWithTrustedTlineCreator({
        clientMode: "tline", sessionId: "sess_verified", workspace: work,
      }, () => startDelegateJob(args));
      expect(started.creator).toEqual({
        clientMode: "tline", sessionId: "sess_verified", workspace: canonicalCliWorkspace(work),
      });
      const fetched = await getDelegateJob(started.jobId);
      expect(fetched?.creator?.sessionId).toBe("sess_verified");
      const { loadJobShards } = await import("../src/core/tools/cliBridgeJobStore.js");
      const shards = await loadJobShards(path.join(process.env.SUPERAGENT_CONFIG_DIR!,
        "cli-bridge", "delegations"));
      expect(shards.find(job => job.jobId === started.jobId)?.creator?.sessionId).toBe("sess_verified");
      const unscoped = await startDelegateJob(args);
      expect(unscoped.creator).toBeUndefined();
    } finally { await __resetDelegateJobsForTests(); }
  }, 25_000);
});
