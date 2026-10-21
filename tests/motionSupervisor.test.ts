import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { enqueueSupervisedMotionJob, getMotionJob, motionJobDir, prepareMotionJob, requestMotionCancellation } from "../src/core/motion/jobs/motionJobs.js";
import { inspectMotionSupervisor, runMotionSupervisorOnce, runMotionSupervisorWatch } from "../src/core/motion/jobs/motionSupervisor.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";

const roots: string[] = [];
const previous = process.env.SUPERAGENT_MOTION_MAX_RENDERERS;
const idPattern = /^motionjob-[a-f0-9]{24}$/;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-supervisor-"));
  roots.push(root);
  const create = async (name: string) => {
    const project = await createMotionProject(root, name);
    const file = path.join(root, ".superagent", "motion", "projects", project.id + ".json");
    project.composition.durationFrames = 1;
    project.composition.layers[0].tracks = [];
    await fs.writeFile(file, JSON.stringify(project));
    return project;
  };
  const first = await create("First");
  const second = await create("Second");
  const dir = await motionJobDir(root, "jobs");
  return { root, first, second, dir };
}
const waitJob = async (root: string, id: string) => {
  for (let i = 0; i < 100; i++) {
    const job = await getMotionJob(root, id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  return getMotionJob(root, id);
};
afterEach(async () => {
  if (previous === undefined) delete process.env.SUPERAGENT_MOTION_MAX_RENDERERS;
  else process.env.SUPERAGENT_MOTION_MAX_RENDERERS = previous;
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
describe("Motion opt-in durable FIFO supervisor", () => {
  it("persists queued snapshots without spawning until a supervisor starts", async () => {
    const { root, first, dir } = await fixture();
    const queued = await enqueueSupervisedMotionJob(root, first.id, { width: 160 });
    expect(queued.id).toMatch(idPattern);
    expect(queued.dispatchMode).toBe("supervised");
    expect((await getMotionJob(root, queued.id)).status).toBe("queued");
    expect(await fs.readdir(dir)).not.toContain(queued.id + ".waiting.lock");
    const status = await inspectMotionSupervisor(root);
    expect(status).toMatchObject({ queuedSupervised: 1, occupied: 0, maxConcurrentRenders: 2, leader: "free" });
    expect(status.oldestWaitingJobId).toBe(queued.id);
  });
  it("starts jobs in FIFO order under one renderer and preserves legacy queued jobs", async () => {
    if (!await probeFfmpeg()) return;
    process.env.SUPERAGENT_MOTION_MAX_RENDERERS = "1";
    const { root, first, second } = await fixture();
    const legacy = await prepareMotionJob(root, first.id, { width: 160 });
    const fifo = await enqueueSupervisedMotionJob(root, second.id, { width: 160 });
    // Old immediate-render API remains untouched and is not auto dispatched.
    const cycle = await runMotionSupervisorOnce(root);
    expect(cycle.attempts).toHaveLength(1);
    expect(cycle.attempts[0]).toMatchObject({ jobId: fifo.id, status: "acknowledged" });
    expect((await getMotionJob(root, legacy.id)).status).toBe("queued");
    expect((await waitJob(root, fifo.id)).status).toBe("completed");
    expect((await getMotionJob(root, legacy.id)).status).toBe("queued");
    const repeat = await runMotionSupervisorOnce(root);
    expect(repeat.attempts).toHaveLength(0);
  }, 40000);
  it("cancels a queued supervised job without a worker and frees its project claim", async () => {
    const { root, first, dir } = await fixture();
    const queued = await enqueueSupervisedMotionJob(root, first.id, { width: 160 });
    const cancel = await requestMotionCancellation(root, queued.id);
    expect(cancel.cancellationRequested).toBe(true);
    expect((await getMotionJob(root, queued.id)).status).toBe("cancelled");
    expect(await fs.readdir(dir)).not.toContain(first.id + ".render.lock");
    expect((await runMotionSupervisorOnce(root)).attempts).toHaveLength(0);
    expect((await enqueueSupervisedMotionJob(root, first.id, { width: 160 })).status).toBe("queued");
  });
  it("holds younger jobs behind an unverified older FIFO record", async () => {
    const { root, first, second, dir } = await fixture();
    const a = await enqueueSupervisedMotionJob(root, first.id, { width: 160 });
    await new Promise(resolve => setTimeout(resolve, 20));
    const b = await enqueueSupervisedMotionJob(root, second.id, { width: 160 });
    await fs.writeFile(path.join(dir, a.id + ".cancel"), "cancel");
    const cycle = await runMotionSupervisorOnce(root);
    expect(cycle.attempts[0]).toMatchObject({ jobId: a.id, status: "skipped" });
    expect((await getMotionJob(root, b.id)).status).toBe("queued");
    expect(await fs.readdir(dir)).not.toContain(b.id + ".waiting.lock");
  });
  it("respects a persistent supervisor claim and never steals ambiguous ownership", async () => {
    const { root, dir } = await fixture();
    const claim = path.join(dir, ".supervisor.lock");
    await fs.writeFile(claim, JSON.stringify({ token: "foreign", pid: 123456 }));
    await expect(runMotionSupervisorOnce(root)).rejects.toThrow(/already claimed/);
    expect((await fs.readFile(claim, "utf8"))).toContain("foreign");
    await fs.rm(claim);
    expect((await runMotionSupervisorOnce(root)).attempts).toHaveLength(0);
    expect(await fs.readdir(dir)).not.toContain(".supervisor.lock");
  });
  it("watch holds leadership until cooperative shutdown, releases it and validates interval", async () => {
    const { root, dir } = await fixture();
    expect(() => runMotionSupervisorWatch(root, { intervalMs: 1 })).toThrow(/intervalMs/);
    const controller = new AbortController();
    let cycleObserved = false;
    const running = runMotionSupervisorWatch(root, {
      intervalMs: 500, signal: controller.signal,
      onCycle: () => { cycleObserved = true; },
    });
    let seen = false;
    for (let n = 0; n < 30; n++) {
      seen = (await fs.readdir(dir)).includes(".supervisor.lock");
      if (seen) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(seen).toBe(true);
    await expect(runMotionSupervisorOnce(root)).rejects.toThrow(/already claimed/);
    // Bun may schedule the abort before the first awaited tick finishes.
    // Wait for an actual completed cycle instead of assuming lock acquisition
    // implies that one already completed.
    for (let n = 0; n < 100 && !cycleObserved; n++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(cycleObserved).toBe(true);
    controller.abort();
    expect((await running).cycles).toBeGreaterThan(0);
    expect(await fs.readdir(dir)).not.toContain(".supervisor.lock");
  });
  it("CLI creates a supervised job and refuses running supervisor without an explicit mode", async () => {
    const { root, first } = await fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const queued = await handleMotionCliCommand(["render", first.id, "--supervised", "--width", "160", "--workspace", root, "--json"]);
      expect(queued).toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).dispatchMode).toBe("supervised");
      expect(await handleMotionCliCommand(["supervisor", "--workspace", root, "--json"])).toBe(2);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).error).toMatch(/--once|--watch/);
      expect(await handleMotionCliCommand(["supervisor-status", "--workspace", root, "--json"])).toBe(0);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).queuedSupervised).toBe(1);
      expect(await handleMotionCliCommand(["render", first.id, "--supervised", "--detach", "--workspace", root, "--json"])).toBe(2);
    } finally { log.mockRestore(); err.mockRestore(); }
  });
});
