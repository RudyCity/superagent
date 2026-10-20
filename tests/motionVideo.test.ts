import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { getMotionJob, listMotionJobs, requestMotionCancellation, renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { deriveRenderProfile, probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";

const fixtures: string[] = [];
async function fixture(frames = 30) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-video-test-"));
  fixtures.push(root);
  const project = await createMotionProject(root, "Sample Story");
  project.composition.durationFrames = frames;
  const last = project.composition.layers[0].tracks[0].keyframes[1];
  last.frame = Math.min(last.frame, frames - 1);
  const projectFile = path.join(root, ".superagent", "motion", "projects", project.id + ".json");
  await fs.writeFile(projectFile, JSON.stringify(project));
  return { root, project };
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("Motion MP4 rendering and durable job records", () => {
  it("enforces even dimensions and frame budget before launching encoder", async () => {
    const { project } = await fixture();
    expect(deriveRenderProfile(project, 160)).toMatchObject({ width: 160, height: 90, frameCount: 30 });
    expect(() => deriveRenderProfile(project, 161)).toThrow(RangeError);
    expect(() => deriveRenderProfile(project, 160, 29)).toThrow(RangeError);
  });

  it("records a validated H.264 MP4 atomically with hash and workspace-scoped job metadata", async () => {
    if (!(await probeFfmpeg())) return;
    const { root, project } = await fixture();
    const job = await renderMotionJob(root, project.id, { width: 160 });
    expect(job.status).toBe("completed");
    expect(job.framesCompleted).toBe(30);
    expect(job.artifact).toBeDefined();
    const bytes = await fs.readFile(job.artifact!.path);
    expect(bytes.length).toBeGreaterThan(100);
    expect(job.artifact!.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"));
    expect((await getMotionJob(root, job.id)).status).toBe("completed");
    expect((await listMotionJobs(root)).map(item => item.id)).toContain(job.id);
    expect((await requestMotionCancellation(root, job.id)).cancellationRequested).toBe(false);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "motion-video-other-"));
    fixtures.push(other);
    await expect(getMotionJob(other, job.id)).rejects.toThrow();
  }, 30000);

  it("exports a real 1920×1080 one-frame H.264 video with validated metadata", async () => {
    if (!(await probeFfmpeg())) return;
    const { root, project } = await fixture(30);
    project.composition.durationFrames = 1;
    project.composition.layers[0].tracks = [];
    await fs.writeFile(path.join(root, ".superagent", "motion", "projects", project.id + ".json"), JSON.stringify(project));
    const job = await renderMotionJob(root, project.id, { width: 1920 });
    expect(job.status, job.error).toBe("completed");
    expect(job.profile).toMatchObject({ width: 1920, height: 1080, frameCount: 1 });
    expect((await fs.stat(job.artifact!.path)).size).toBeGreaterThan(100);
  }, 30000);

  it("records a failed render without publishing an artifact when FFmpeg is unavailable", async () => {
    const { root, project } = await fixture();
    const job = await renderMotionJob(root, project.id, { width: 160, ffmpeg: "__missing_motion_encoder__" });
    expect(job.status).toBe("failed");
    expect(job.artifact).toBeUndefined();
    expect((await getMotionJob(root, job.id)).status).toBe("failed");
    expect((await listMotionJobs(root))).toHaveLength(1);
    const dir = path.join(root, ".superagent", "motion", "renders");
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("honors AbortSignal and persists cancelled state without final output", async () => {
    const { root, project } = await fixture();
    const controller = new AbortController();
    controller.abort();
    const job = await renderMotionJob(root, project.id, { width: 160, signal: controller.signal });
    expect(job.status).toBe("cancelled");
    expect(job.artifact).toBeUndefined();
    expect((await getMotionJob(root, job.id)).status).toBe("cancelled");
  });

  it("accepts an out-of-process cancel request while a render is active", async () => {
    if (!(await probeFfmpeg())) return;
    const { root, project } = await fixture(300);
    const rendering = renderMotionJob(root, project.id, { width: 160 });
    let jobId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const jobs = await listMotionJobs(root);
      if (jobs.length) { jobId = jobs[0].id; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(jobId).toBeDefined();
    const cancellation = await requestMotionCancellation(root, jobId!);
    expect(cancellation.cancellationRequested).toBe(true);
    const job = await rendering;
    expect(job.status).toBe("cancelled");
    expect(job.artifact).toBeUndefined();
    expect((await getMotionJob(root, jobId!)).status).toBe("cancelled");
  }, 30000);
});
