import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import {
  getMotionJob, inspectMotionJob, prepareMotionJob, renderMotionJob,
  runPreparedMotionJob, startDetachedMotionJob, reconcileStaleMotionJob,
} from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";

const dirs: string[] = [];
async function fixture(frames = 30) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-detached-test-"));
  dirs.push(root);
  const project = await createMotionProject(root, "Locked Project");
  project.composition.durationFrames = frames;
  const keyframe = project.composition.layers[0].tracks[0].keyframes[1];
  keyframe.frame = Math.min(24, frames - 1);
  const file = path.join(root, ".superagent", "motion", "projects", project.id + ".json");
  await fs.writeFile(file, JSON.stringify(project));
  return { root, project, file };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("Motion Studio detached worker boundaries", () => {
  it("pins a revision before running and refuses duplicate worker execution", async () => {
    const { root, project, file } = await fixture();
    const job = await prepareMotionJob(root, project.id, { width: 160 });
    expect(job.status).toBe("queued");
    const current = JSON.parse(await fs.readFile(file, "utf8"));
    current.revision++;
    current.composition.layers[0].text = "Changed after queue";
    await fs.writeFile(file, JSON.stringify(current));
    await expect(prepareMotionJob(root, project.id, { width: 160 })).rejects.toThrow("active or unreconciled render");
    const jobsDir = path.join(root, ".superagent", "motion", "jobs");
    await fs.writeFile(path.join(jobsDir, job.id + ".runner.lock"), "external runner");
    await expect(runPreparedMotionJob(root, job.id)).rejects.toThrow("claimed by a worker");
    await fs.rm(path.join(jobsDir, job.id + ".runner.lock"));
    if (!(await probeFfmpeg())) return;
    const finished = await runPreparedMotionJob(root, job.id);
    expect(finished.status).toBe("completed");
    expect(finished.revision).toBe(1);
    expect(finished.artifact?.bytes).toBeGreaterThan(100);
    const status = await inspectMotionJob(root, job.id);
    expect(status.recovery).toBe("terminal");
    expect(status.claims.project).toBe("absent");
    expect((await fs.readdir(jobsDir)).some(name => name.endsWith(".render.lock"))).toBe(false);
  }, 30000);

  it("refuses a modified source snapshot and never publishes an untrusted video", async () => {
    const { root, project } = await fixture();
    const job = await prepareMotionJob(root, project.id, { width: 160 });
    const source = path.join(root, ".superagent", "motion", "jobs", job.id + ".source.json");
    const content = JSON.parse(await fs.readFile(source, "utf8"));
    content.composition.layers[0].text = "Tampered snapshot";
    await fs.writeFile(source, JSON.stringify(content));
    const result = await runPreparedMotionJob(root, job.id);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("hash mismatch");
    expect(result.artifact).toBeUndefined();
    expect((await getMotionJob(root, job.id)).status).toBe("failed");
  });

  it("returns read-only diagnostic state for queued jobs without claiming process death", async () => {
    const { root, project } = await fixture();
    const job = await prepareMotionJob(root, project.id, { width: 160 });
    const result = await inspectMotionJob(root, job.id);
    expect(result.recovery).toBe("queued_or_owner_unknown");
    expect(result.claims.project).toBe("owned");
    expect(result.claims.execution).toBe("absent");
    expect(result.advice).toContain("Do not kill processes");
    expect((await getMotionJob(root, job.id)).status).toBe("queued");
  });

  it("requires a stale job, missing runner, and matching claim before manual recovery", async () => {
    const { root, project } = await fixture();
    const job = await prepareMotionJob(root, project.id, { width: 160 });
    await expect(reconcileStaleMotionJob(root, job.id)).rejects.toThrow("too recent");
    const dir = path.join(root, ".superagent", "motion", "jobs");
    const file = path.join(dir, job.id + ".json");
    const old = { ...job, updatedAt: new Date(Date.now() - 180_000).toISOString() };
    await fs.writeFile(file, JSON.stringify(old));
    const runner = path.join(dir, job.id + ".runner.lock");
    await fs.writeFile(runner, 'unverified');
    await expect(reconcileStaleMotionJob(root, job.id)).rejects.toThrow("runner claim remains");
    await fs.rm(runner);
    const interrupted = await reconcileStaleMotionJob(root, job.id);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.error).toContain("Manually reconciled");
    expect((await inspectMotionJob(root, job.id)).claims.project).toBe("absent");
    expect((await fs.readdir(dir)).some(file => file.endsWith('.recovery.lock'))).toBe(false);
    const resumed = await prepareMotionJob(root, project.id, { width: 160 });
    expect(resumed.status).toBe('queued');
  });

  it("can detach from the CLI process and finish under an independent owner PID", async () => {
    if (!(await probeFfmpeg())) return;
    const { root, project } = await fixture();
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.tsx", "motion", "render", project.id, "--width", "160", "--detach", "--workspace", root, "--json"],
      { encoding: "utf8", timeout: 20000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const queued = JSON.parse(result.stdout) as { id: string; status: string };
    expect(queued.status).toBe("queued");
    let job = await getMotionJob(root, queued.id);
    for (let i = 0; i < 120 && !["completed", "failed", "cancelled"].includes(job.status); i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      job = await getMotionJob(root, queued.id);
    }
    expect(job.status, job.error).toBe("completed");
    expect(job.ownerPid).toBeGreaterThan(0);
    expect(job.ownerPid).not.toBe(process.pid);
    expect(job.artifact?.bytes).toBeGreaterThan(100);
  }, 30000);
});
