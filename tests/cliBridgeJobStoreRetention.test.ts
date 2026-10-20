import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DelegateJob } from "../src/core/tools/cliBridgeDelegateJobs.js";
import {
  jobShardPath, loadJobShards, persistJobShard, MAX_JOB_SNAPSHOTS_PER_JOB,
} from "../src/core/tools/cliBridgeJobStore.js";

function sample(jobId: string, cwd: string, revision: number): DelegateJob {
  const startedAt = Date.now();
  return {
    jobId, cliAlias: "fixture", binary: process.execPath, cwd, workspaceRoot: cwd,
    pid: revision === 0 ? 2000 : null, status: revision === 0 ? "running" : "succeeded",
    startedAt, updatedAt: startedAt + revision, exitCode: revision === 0 ? null : 0,
    timedOut: false, timeoutMs: 5000,
    outputTail: "checkpoint-" + revision, outputBytes: revision,
    logPath: path.join(cwd, jobId + ".log"),
    completionState: revision === 0 ? "pending" : "unverified",
  };
}
function id(): string { return "clj_" + Date.now() + "_" + crypto.randomBytes(4).toString("hex"); }
const committed = (names: string[]) =>
  names.filter(name => /^\d{13}-\d{10}-[a-f0-9]{16}\.json$/.test(name));

describe("Hermes Phase 4 immutable job snapshot retention", () => {
  it("retains a bounded recovery window and loads the most recent committed revision", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-shard-retain-"));
    try {
      const jobId = id();
      for (let revision = 0; revision < 30; revision++) {
        await persistJobShard(directory, sample(jobId, directory, revision));
      }
      const files = await fs.readdir(jobShardPath(directory, jobId));
      expect(committed(files)).toHaveLength(MAX_JOB_SNAPSHOTS_PER_JOB);
      const jobs = await loadJobShards(directory);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].outputTail).toBe("checkpoint-29");
      expect(jobs[0].status).toBe("succeeded");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("never prunes peer job snapshots or non-snapshot files when updating a different job", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-shard-peer-"));
    try {
      const ownId = id();
      const peerId = id();
      for (let revision = 0; revision < 6; revision++) {
        await persistJobShard(directory, sample(peerId, directory, revision));
      }
      const foreignDir = jobShardPath(directory, peerId);
      const before = (await fs.readdir(foreignDir)).sort();
      const ownDir = jobShardPath(directory, ownId);
      await persistJobShard(directory, sample(ownId, directory, 0));
      await fs.writeFile(path.join(ownDir, "manual.note"), "keep");
      await fs.writeFile(path.join(ownDir, "incomplete.tmp"), "keep");
      for (let revision = 1; revision < 25; revision++) {
        await persistJobShard(directory, sample(ownId, directory, revision));
      }
      expect((await fs.readdir(foreignDir)).sort()).toEqual(before);
      const own = await fs.readdir(ownDir);
      expect(committed(own)).toHaveLength(MAX_JOB_SNAPSHOTS_PER_JOB);
      expect(own).toContain("manual.note");
      expect(own).toContain("incomplete.tmp");
      const loaded = await loadJobShards(directory);
      expect(loaded.find(job => job.jobId === peerId)?.outputTail).toBe("checkpoint-5");
      expect(loaded.find(job => job.jobId === ownId)?.outputTail).toBe("checkpoint-24");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not compact when the newest committed filename is unreadable", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-shard-corrupt-"));
    try {
      const jobId = id();
      const dir = jobShardPath(directory, jobId);
      for (let revision = 0; revision < 12; revision++) {
        await persistJobShard(directory, sample(jobId, directory, revision));
      }
      const fakeNewest = path.join(dir, "9999999999999-9999999999-ffffffffffffffff.json");
      await fs.writeFile(fakeNewest, "{corrupted");
      for (let revision = 12; revision < 15; revision++) {
        await persistJobShard(directory, sample(jobId, directory, revision));
      }
      expect(committed(await fs.readdir(dir)).length).toBeGreaterThan(MAX_JOB_SNAPSHOTS_PER_JOB);
      expect((await loadJobShards(directory))[0].outputTail).toBe("checkpoint-14");
      await fs.rm(fakeNewest);
      await persistJobShard(directory, sample(jobId, directory, 15));
      expect(committed(await fs.readdir(dir))).toHaveLength(MAX_JOB_SNAPSHOTS_PER_JOB);
      expect((await loadJobShards(directory))[0].outputTail).toBe("checkpoint-15");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
