import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { getMotionJob, prepareMotionJob, renderMotionJob, motionJobDir } from "../src/core/motion/jobs/motionJobs.js";
import { motionStorageMaintenance } from "../src/core/motion/jobs/storageMaintenance.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { acquireMotionRenderSlot } from "../src/core/motion/jobs/renderScheduler.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
const workspaces: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-retention-test-"));
  workspaces.push(root);
  const project = await createMotionProject(root, "Retention");
  return { root, project, dir: await motionJobDir(root, "jobs") };
}
async function markOld(root: string, id: string, days = 15) {
  const dir = await motionJobDir(root, "jobs");
  const file = path.join(dir, id + ".json");
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  record.updatedAt = new Date(Date.now() - days * 86_400_000).toISOString();
  await fs.writeFile(file, JSON.stringify(record));
}
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true })));
});
describe("Motion storage maintenance safety", () => {
  it("only prunes old unclaimed failed job snapshots after explicit apply", async () => {
    const { root, project, dir } = await fixture();
    const failed = await renderMotionJob(root, project.id, { width: 160, ffmpeg: "__not_a_real_encoder__" });
    expect(failed.status).toBe("failed");
    await markOld(root, failed.id);
    const snapshot = path.join(dir, failed.id + ".source.json");
    expect((await fs.stat(snapshot)).size).toBeGreaterThan(100);
    const preview = await motionStorageMaintenance(root, { minAgeDays: 7 });
    expect(preview.jobs.failed).toBe(1);
    expect(preview.maintenance.candidateIds).toEqual([failed.id]);
    expect(preview.maintenance.reclaimableBytes).toBeGreaterThan(100);
    expect((await getMotionJob(root, failed.id)).status).toBe("failed");
    const removed = await motionStorageMaintenance(root, { minAgeDays: 7, apply: true });
    expect(removed.deletedJobIds).toEqual([failed.id]);
    await expect(fs.stat(snapshot)).rejects.toThrow();
    await expect(getMotionJob(root, failed.id)).rejects.toThrow();
    expect((await motionStorageMaintenance(root)).jobs.total).toBe(0);
  });
  it("blocks claimed, young, suspicious-output and symlinked candidates, never touching completed video", async () => {
    const first = await fixture();
    const pending = await prepareMotionJob(first.root, first.project.id, { width: 160 });
    await markOld(first.root, pending.id);
    const queue = await motionStorageMaintenance(first.root, { minAgeDays: 1, apply: true });
    expect(queue.deletedJobIds).toHaveLength(0);
    expect(queue.jobs.queued).toBe(1);
    const second = await fixture();
    const job = await renderMotionJob(second.root, second.project.id, { width: 160, ffmpeg: "__missing_ffmpeg__" });
    await markOld(second.root, job.id);
    await fs.writeFile(path.join(second.dir, job.id + ".recovery.lock"), "active");
    const locked = await motionStorageMaintenance(second.root, { apply: true });
    expect(locked.maintenance.blockedIds).toContain(job.id);
    expect(locked.deletedJobIds).toEqual([]);
    await fs.rm(path.join(second.dir, job.id + ".recovery.lock"));
    const renders = await motionJobDir(second.root, "renders");
    await fs.writeFile(path.join(renders, job.id + ".partial.mp4"), "do-not-prune");
    const partial = await motionStorageMaintenance(second.root, { apply: true });
    expect(partial.maintenance.blockedIds).toContain(job.id);
    expect((await fs.readFile(path.join(renders, job.id + ".partial.mp4"), "utf8"))).toBe("do-not-prune");
    const third = await fixture();
    if (await probeFfmpeg()) {
      // A completed render must never appear as a prune candidate even if arbitrarily old.
      const source = path.join(third.root, ".superagent", "motion", "projects", third.project.id + ".json");
      const composition = structuredClone(third.project);
      composition.composition.durationFrames = 1;
      composition.composition.layers[0].tracks = [];
      await fs.writeFile(source, JSON.stringify(composition));
      const completed = await renderMotionJob(third.root, third.project.id, { width: 160 });
      expect(completed.status).toBe("completed");
      await markOld(third.root, completed.id, 40);
      const report = await motionStorageMaintenance(third.root, { apply: true });
      expect(report.maintenance.candidateIds).not.toContain(completed.id);
      expect((await fs.stat(completed.artifact!.path)).size).toBeGreaterThan(0);
    }
  }, 30000);
  it("preserves old failed jobs during renderer slot ownership and rejects symlinked snapshots", async () => {
    const { root, project, dir } = await fixture();
    const failed = await renderMotionJob(root, project.id, { width: 160, ffmpeg: "__not_a_real_encoder__" });
    await markOld(root, failed.id);
    const slot = await acquireMotionRenderSlot(dir, failed.id);
    const protectedJob = await motionStorageMaintenance(root, { apply: true });
    expect(protectedJob.maintenance.blockedIds).toContain(failed.id);
    expect((await getMotionJob(root, failed.id)).status).toBe("failed");
    await slot.release();
    const snapshot = path.join(dir, failed.id + ".source.json");
    const contents = await fs.readFile(snapshot);
    await fs.rm(snapshot);
    const real = path.join(root, "external-untrusted.json");
    await fs.writeFile(real, contents);
    try {
      await fs.symlink(real, snapshot);
      const rejected = await motionStorageMaintenance(root, { apply: true });
      expect(rejected.maintenance.blockedIds).toContain(failed.id);
      expect(rejected.deletedJobIds).toEqual([]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });
  it("validates age and requires a separate destructive CLI action", async () => {
    const { root } = await fixture();
    await expect(motionStorageMaintenance(root, { minAgeDays: 0 })).rejects.toThrow("minAgeDays");
    await expect(motionStorageMaintenance(root, { minAgeDays: 3651 })).rejects.toThrow("minAgeDays");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const preview = await handleMotionCliCommand(["storage", "--days", "7", "--workspace", root, "--json"]);
      expect(preview).toBe(0);
      const info = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(info.jobs.total).toBe(0);
      const withoutApproval = await handleMotionCliCommand(["prune", "--workspace", root, "--json"]);
      expect(withoutApproval).toBe(2);
      const blocked = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
      expect(blocked.error).toMatch(/--apply/);
      const confirmed = await handleMotionCliCommand(["prune", "--apply", "--days", "7", "--workspace", root, "--json"]);
      expect(confirmed).toBe(0);
    } finally {
      log.mockRestore(); error.mockRestore();
    }
  });
});
