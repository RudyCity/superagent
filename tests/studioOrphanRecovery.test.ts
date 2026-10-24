import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject, inspectStudioStorageMigration } from "../src/core/motion/project/projectStore.js";
import { prepareMotionJob, getMotionJob, motionJobDir } from "../src/core/motion/jobs/motionJobs.js";
import { reconcileAbandonedMotionWorker } from "../src/core/motion/jobs/orphanRecovery.js";

const roots: string[] = [];
const missingPid = 2147483000;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "studio-orphan-recovery-"));
  roots.push(root);
  const project = await createMotionProject(root, "Orphan claims");
  const job = await prepareMotionJob(root, project.id, { width: 160 });
  const dir = await motionJobDir(root, "jobs");
  const at = new Date(Date.now() - 180_000).toISOString();
  await fs.writeFile(path.join(dir, job.id + ".json"), JSON.stringify({
    ...job, status: "rendering", ownerPid: missingPid, ownerStartedAt: at, updatedAt: at,
  }));
  const claim = JSON.stringify({ pid: missingPid, startedAt: at }) + "\n";
  await fs.writeFile(path.join(dir, job.id + ".runner.lock"), claim);
  await fs.writeFile(path.join(dir, job.id + ".waiting.lock"), claim);
  await fs.writeFile(path.join(dir, ".render-slot-0.lock"),
    JSON.stringify({ jobId: job.id, pid: missingPid, startedAt: at }) + "\n");
  return { root, project, job, dir };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
describe("Studio explicit abandoned worker recovery", () => {
  it("requires correct operator PID and refuses a mismatching worker claim", async () => {
    const { root, job, dir } = await fixture();
    await expect(reconcileAbandonedMotionWorker(root, job.id, missingPid - 1))
      .rejects.toThrow(/owner PID/);
    const runner = path.join(dir, job.id + ".runner.lock");
    await fs.writeFile(runner, JSON.stringify({ pid: process.pid, startedAt: job.createdAt }));
    await expect(reconcileAbandonedMotionWorker(root, job.id, missingPid))
      .rejects.toThrow(/claim PID/);
    expect((await getMotionJob(root, job.id)).status).toBe("rendering");
    expect(await fs.readFile(runner, "utf8")).toContain(String(process.pid));
  });
  it("fails closed if an artifact or partial output exists", async () => {
    const { root, job } = await fixture();
    const rendersDir = await motionJobDir(root, "renders");
    const part = path.join(rendersDir, job.id + ".partial.mp4");
    await fs.writeFile(part, "not safe to erase");
    await expect(reconcileAbandonedMotionWorker(root, job.id, missingPid))
      .rejects.toThrow(/output exists/);
    expect(await fs.readFile(part, "utf8")).toBe("not safe to erase");
  });
  it("archives exact claims and source metadata, then clears migration blockers", async () => {
    const { root, job, dir } = await fixture();
    const result = await reconcileAbandonedMotionWorker(root, job.id, missingPid);
    expect(result.job.status).toBe("interrupted");
    expect(result.archivedClaims).toHaveLength(4);
    expect((await getMotionJob(root, job.id)).status).toBe("interrupted");
    for (const name of [".render-slot-0.lock", job.id + ".runner.lock",
      job.id + ".waiting.lock", job.projectId + ".render.lock"]) {
      await expect(fs.lstat(path.join(dir, name))).rejects.toMatchObject({ code: "ENOENT" });
    }
    const archive = path.join(dir, result.evidence);
    const evidence = JSON.parse(await fs.readFile(archive, "utf8"));
    expect(evidence.previousJob.id).toBe(job.id);
    expect(Object.keys(evidence.claimHashes)).toHaveLength(4);
    expect((await inspectStudioStorageMigration(root)).blockers).toHaveLength(0);
  });
  it("rejects a live process ID without disturbing claims", async () => {
    const { root, job, dir } = await fixture();
    const at = new Date(Date.now() - 180_000).toISOString();
    await fs.writeFile(path.join(dir, job.id + ".json"), JSON.stringify({
      ...job, status: "rendering", ownerPid: process.pid, ownerStartedAt: at, updatedAt: at,
    }));
    for (const suffix of [".runner.lock", ".waiting.lock"]) {
      await fs.writeFile(path.join(dir, job.id + suffix), JSON.stringify({pid:process.pid,startedAt:at}));
    }
    await fs.writeFile(path.join(dir, ".render-slot-0.lock"),
      JSON.stringify({jobId:job.id,pid:process.pid,startedAt:at}));
    await expect(reconcileAbandonedMotionWorker(root, job.id, process.pid))
      .rejects.toThrow(/still exists/);
    expect((await getMotionJob(root, job.id)).status).toBe("rendering");
  });
});
