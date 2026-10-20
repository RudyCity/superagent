import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { getMotionJob, motionJobDir, prepareMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { inspectMotionQueueRecovery, dispatchOrphanedMotionQueue } from "../src/core/motion/jobs/queueRecovery.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-queue-recovery-"));
  roots.push(root);
  const project = await createMotionProject(root, "Persisted work");
  // Render one frame for worker spawn test without invalidating the source keyframes.
  const saved = path.join(root, ".superagent", "motion", "projects", project.id + ".json");
  project.composition.durationFrames = 1;
  project.composition.layers[0].tracks = [];
  await fs.writeFile(saved, JSON.stringify(project));
  const job = await prepareMotionJob(root, project.id, { width: 160 });
  const dir = await motionJobDir(root, "jobs");
  return { root, job, dir };
}
async function makeOld(dir: string, id: string, seconds = 360) {
  const file = path.join(dir, id + ".json");
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  data.updatedAt = new Date(Date.now() - seconds * 1000).toISOString();
  await fs.writeFile(file, JSON.stringify(data));
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
describe("Operator-safe Motion queued job redispatch", () => {
  it("reports an old orphan candidate without modifying or spawning jobs", async () => {
    const { root, dir, job } = await fixture();
    expect((await inspectMotionQueueRecovery(root)).items).toMatchObject([{ jobId: job.id, state: "blocked" }]);
    await makeOld(dir, job.id);
    const report = await inspectMotionQueueRecovery(root);
    expect(report).toMatchObject({ eligible: 1, queued: 1, blocked: 0 });
    expect(report.items[0]).toMatchObject({ jobId: job.id, state: "eligible" });
    expect((await getMotionJob(root, job.id)).status).toBe("queued");
    await expect(dispatchOrphanedMotionQueue(root, { apply: false })).rejects.toThrow("--apply");
    expect(await fs.readdir(dir)).not.toContain(job.id + ".dispatch.lock");
  });
  it("rejects jobs with existing worker claims or modified immutable source", async () => {
    const { root, dir, job } = await fixture();
    await makeOld(dir, job.id);
    const waiting = path.join(dir, job.id + ".waiting.lock");
    await fs.writeFile(waiting, "unverified");
    const blocked = await inspectMotionQueueRecovery(root);
    expect(blocked.items[0].reason).toMatch(/claim/);
    await fs.rm(waiting);
    const snapshot = path.join(dir, job.id + ".source.json");
    const modified = JSON.parse(await fs.readFile(snapshot, "utf8"));
    modified.composition.background = "#ABCDEF";
    await fs.writeFile(snapshot, JSON.stringify(modified));
    const changed = await inspectMotionQueueRecovery(root);
    expect(changed.items[0].reason).toMatch(/snapshot/);
    const replay = await dispatchOrphanedMotionQueue(root, { apply: true });
    expect(replay.results).toHaveLength(0);
    expect((await getMotionJob(root, job.id)).status).toBe("queued");
  });
  it("refuses foreign and ambiguous project lock, runner claims, and prior dispatch", async () => {
    const { root, dir, job } = await fixture();
    await makeOld(dir, job.id);
    const projectClaim = path.join(dir, job.projectId + ".render.lock");
    await fs.writeFile(projectClaim, "foreign-motionjob");
    expect((await inspectMotionQueueRecovery(root)).items[0].reason).toMatch(/project claim/);
    await fs.writeFile(projectClaim, job.id + "\n");
    for (const suffix of [".runner.lock", ".dispatch.lock", ".cancel"]) {
      const filename = path.join(dir, job.id + suffix);
      await fs.writeFile(filename, "unverified");
      expect((await inspectMotionQueueRecovery(root)).items[0].state).toBe("blocked");
      await fs.rm(filename);
    }
    const other = await fixture();
    await makeOld(other.dir, other.job.id);
    expect((await inspectMotionQueueRecovery(root)).items).toHaveLength(1);
    expect((await inspectMotionQueueRecovery(other.root)).items).toHaveLength(1);
    await expect(dispatchOrphanedMotionQueue(root, { apply: true, minAgeSeconds: 0 })).rejects.toThrow("minAgeSeconds");
  });
  it("requires CLI confirmation and preserves the no-op read-only path", async () => {
    const { root, dir, job } = await fixture();
    await makeOld(dir, job.id);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const preview = await handleMotionCliCommand(["queue-recovery", "--workspace", root, "--json"]);
      expect(preview).toBe(0);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0])).eligible).toBe(1);
      const blocked = await handleMotionCliCommand(["dispatch-queue", "--workspace", root, "--json"]);
      expect(blocked).toBe(2);
      expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0])).error).toMatch(/--apply/);
      expect((await getMotionJob(root, job.id)).status).toBe("queued");
    } finally { logs.mockRestore(); errors.mockRestore(); }
  });
  it("redispatches an orphaned queued snapshot to a detached worker only once", async () => {
    if (!await probeFfmpeg()) return;
    const { root, dir, job } = await fixture();
    await makeOld(dir, job.id);
    const [first, second] = await Promise.all([
      dispatchOrphanedMotionQueue(root, { apply: true, limit: 1, minAgeSeconds: 10 }),
      dispatchOrphanedMotionQueue(root, { apply: true, limit: 1, minAgeSeconds: 10 }),
    ]);
    const outcomes = [...first.results, ...second.results];
    expect(outcomes.filter(x => x.status === "acknowledged")).toHaveLength(1);
    let current = await getMotionJob(root, job.id);
    for (let n = 0; n < 120 && current.status !== "completed" && current.status !== "failed"; n++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      current = await getMotionJob(root, job.id);
    }
    expect(current.status, current.error).toBe("completed");
    expect(current.artifact?.bytes).toBeGreaterThan(100);
    expect(await fs.readdir(dir)).not.toContain(job.id + ".dispatch.lock");
    const after = await inspectMotionQueueRecovery(root);
    expect(after.queued).toBe(0);
  }, 40000);
});
