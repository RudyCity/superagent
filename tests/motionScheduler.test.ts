import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { motionJobDir, getMotionJob, prepareMotionJob, requestMotionCancellation, runPreparedMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { MOTION_QUEUE_LIMIT, acquireMotionRenderSlot, assertMotionQueueCapacity, inspectMotionSlots } from "../src/core/motion/jobs/renderScheduler.js";

const roots: string[] = [];
const previous = process.env.SUPERAGENT_MOTION_MAX_RENDERERS;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-slot-test-"));
  roots.push(root);
  const project = await createMotionProject(root, "Render slots");
  return { root, project };
}
afterEach(async () => {
  if (previous === undefined) delete process.env.SUPERAGENT_MOTION_MAX_RENDERERS;
  else process.env.SUPERAGENT_MOTION_MAX_RENDERERS = previous;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const jobId = (n: number) => "motionjob-" + n.toString(16).padStart(24, "0");

describe("Motion render scheduler across processes", () => {
  it("claims a single shared slot and waits instead of running workers concurrently", async () => {
    process.env.SUPERAGENT_MOTION_MAX_RENDERERS = "1";
    const { root } = await fixture();
    const dir = await motionJobDir(root, "jobs");
    const first = await acquireMotionRenderSlot(dir, jobId(1));
    expect((await inspectMotionSlots(dir))[0]).toMatchObject({ slot: 0, jobId: jobId(1), state: "claimed_unverified" });
    let acquired = false;
    const waiting = acquireMotionRenderSlot(dir, jobId(2), { maxWaitMs: 3000 }).then(slot => { acquired = true; return slot; });
    await new Promise(resolve => setTimeout(resolve, 240));
    expect(acquired).toBe(false);
    await first.release();
    const second = await waiting;
    expect(acquired).toBe(true);
    expect((await inspectMotionSlots(dir))[0].jobId).toBe(jobId(2));
    await second.release();
    expect((await inspectMotionSlots(dir))[0].state).toBe("free");
  });

  it("enforces the 12-job queue limit under an atomic admission boundary", async () => {
    const { root, project } = await fixture();
    const dir = await motionJobDir(root, "jobs");
    for (let i = 0; i < MOTION_QUEUE_LIMIT; i++) {
      await fs.writeFile(path.join(dir, jobId(i) + ".json"), JSON.stringify({ status: "queued" }));
    }
    await expect(assertMotionQueueCapacity(dir)).rejects.toThrow("queue full");
    await expect(prepareMotionJob(root, project.id)).rejects.toThrow("queue full");
    const files = await fs.readdir(dir);
    expect(files.some(file => file.endsWith(".render.lock"))).toBe(false);
    expect(files).not.toContain(".admission.lock");
  });

  it("cancels an admitted job while it waits for the slot and releases its project claim", async () => {
    process.env.SUPERAGENT_MOTION_MAX_RENDERERS = "1";
    const { root, project } = await fixture();
    const dir = await motionJobDir(root, "jobs");
    const blocker = await acquireMotionRenderSlot(dir, jobId(50));
    const job = await prepareMotionJob(root, project.id, { width: 160 });
    const running = runPreparedMotionJob(root, job.id);
    let waiting = false;
    for (let attempt = 0; attempt < 35; attempt++) {
      waiting = await fs.access(path.join(dir, job.id + ".waiting.lock")).then(() => true, () => false);
      if (waiting) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(waiting).toBe(true);
    await requestMotionCancellation(root, job.id);
    const cancelled = await running;
    expect(cancelled.status).toBe("cancelled");
    expect((await getMotionJob(root, job.id)).status).toBe("cancelled");
    expect((await fs.readdir(dir)).some(file => file.endsWith(".render.lock") || file.endsWith(".waiting.lock"))).toBe(false);
    await blocker.release();
    expect((await inspectMotionSlots(dir))[0].state).toBe("free");
  });

  it("times out safely and preserves ownership of another worker's slot", async () => {
    process.env.SUPERAGENT_MOTION_MAX_RENDERERS = "1";
    const { root } = await fixture();
    const dir = await motionJobDir(root, "jobs");
    const first = await acquireMotionRenderSlot(dir, jobId(3));
    await expect(acquireMotionRenderSlot(dir, jobId(4), { maxWaitMs: 0 })).rejects.toThrow("timed out");
    expect((await inspectMotionSlots(dir))[0].jobId).toBe(jobId(3));
    await first.release();
  });
});
