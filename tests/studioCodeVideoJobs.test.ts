import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  queueStudioCodeVideo, inspectStudioCodeVideo, cancelStudioCodeVideo,
} from "../src/core/motion/code/studioCodeVideoJobs.js";
import { readStudioCodeVideo } from "../src/core/motion/code/studioBrowserVideoRenderer.js";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))));
async function ws() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-code-job-"));
  roots.push(dir);
  return dir;
}
const html = '<!doctype html><html><head><style>body{background:black}' +
  'p{color:white;animation:move 2s linear both}@keyframes move{from{transform:translateX(0)}' +
  'to{transform:translateX(120px)}}</style></head><body><p>Hello</p></body></html>';

async function terminal(workspace: string, id: string, deadlineMs = 30000) {
  const expire = Date.now() + deadlineMs;
  for (;;) {
    const job = await inspectStudioCodeVideo(workspace, id);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    if (Date.now() >= expire) throw Error("Render job did not terminate");
    await new Promise(resolve => setTimeout(resolve, 40));
  }
}

describe("Code-to-Video bounded queue, progress and cancellation", () => {
  it("runs jobs to completion while only exposing opaque metadata", async () => {
    const workspace = await ws();
    const created = await queueStudioCodeVideo(workspace, { html },
      { width: 640, height: 360, fps: 5, durationSeconds: 1 });
    expect(created.id).toMatch(/^codejob-[a-f0-9]{24}$/);
    const finished = await terminal(workspace, created.id);
    expect(finished.status).toBe("completed");
    expect(finished.framesCompleted).toBe(5);
    expect(finished.frameCount).toBe(5);
    expect(finished.result?.bytes).toBeGreaterThan(1500);
    expect((finished.result as any)?.file).toBeUndefined();
    expect((await readStudioCodeVideo(workspace, finished.result!.id)).length).toBe(finished.result!.bytes);
    expect((await cancelStudioCodeVideo(workspace, finished.id)).status).toBe("completed");
  }, 45000);

  it("rejects cross-workspace job status and cancellation", async () => {
    const workspace = await ws();
    const outsider = await ws();
    const job = await queueStudioCodeVideo(workspace, { html },
      { width: 640, height: 360, fps: 4, durationSeconds: 1 });
    await expect(inspectStudioCodeVideo(outsider, job.id)).rejects.toThrow(/not found/);
    await expect(cancelStudioCodeVideo(outsider, job.id)).rejects.toThrow(/not found/);
    await expect(inspectStudioCodeVideo(workspace, "../secret")).rejects.toThrow(/Invalid/);
    expect((await terminal(workspace, job.id)).status).toBe("completed");
  }, 45000);

  it("cancels an active job and queued jobs without publishing MP4", async () => {
    const workspace = await ws();
    const active = await queueStudioCodeVideo(workspace, { html },
      { width: 1024, height: 576, fps: 25, durationSeconds: 8 });
    const pending = await queueStudioCodeVideo(workspace, { html },
      { width: 640, height: 360, fps: 5, durationSeconds: 1 });
    expect((await cancelStudioCodeVideo(workspace, pending.id)).status).toBe("cancelled");
    await cancelStudioCodeVideo(workspace, active.id);
    const finish = await terminal(workspace, active.id, 40000);
    expect(finish.status).toBe("cancelled");
    expect(finish.result).toBeUndefined();
    expect((await inspectStudioCodeVideo(workspace, pending.id)).status).toBe("cancelled");
  }, 48000);

  it("limits admission when four jobs are already active/queued", async () => {
    const workspace = await ws();
    const jobs = [];
    for (let i = 0; i < 4; i++) jobs.push(await queueStudioCodeVideo(workspace, { html },
      { width: 1024, height: 576, fps: 25, durationSeconds: 6 }));
    await expect(queueStudioCodeVideo(workspace, { html },
      { width: 640, height: 360, fps: 4, durationSeconds: 1 })).rejects.toThrow(/queue full/);
    for (const job of jobs) await cancelStudioCodeVideo(workspace, job.id);
    for (const job of jobs) expect((await terminal(workspace, job.id, 40000)).status).toBe("cancelled");
  }, 48000);
});
