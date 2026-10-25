import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { queueStudioCodeVideo, inspectStudioCodeVideo, listStudioCodeVideos, cancelStudioCodeVideo } from "../src/core/motion/code/studioCodeVideoJobs.js";
import { readStudioCodeVideoJob, saveStudioCodeVideoJob, listStudioCodeVideoJobs } from "../src/core/motion/code/studioCodeVideoJobStore.js";
const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(dir => fs.rm(dir, { force: true, recursive: true }))));
async function ws() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "studio-code-job-durable-"));
  roots.push(dir);
  return dir;
}
const html = '<!doctype html><html><head><style>body{background:#111}' +
  'p{color:white;animation:move .5s linear both}@keyframes move{from{transform:translateX(0)}' +
  'to{transform:translateX(50px)}}</style></head><body><p>Hello</p></body></html>';
async function finished(workspace: string, id: string) {
  for (let i = 0; i < 200; i++) {
    const status = await inspectStudioCodeVideo(workspace, id);
    if (["completed", "failed", "cancelled"].includes(status.status)) return status;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for code-video job");
}
describe("Durable workspace-only Code-to-Video job history", () => {
  it("survives process restart without leaking source/absolute paths and retains MP4 ID", async () => {
    const workspace = await ws();
    const created = await queueStudioCodeVideo(workspace, { html },
      { width: 640, height: 360, fps: 4, durationSeconds: 1 });
    const terminal = await finished(workspace, created.id);
    expect(terminal.status).toBe("completed");
    const file = path.join(workspace, ".superagent", "studio", "code", "jobs", created.id + ".json");
    const serialized = await fs.readFile(file, "utf8");
    expect(serialized).not.toContain("Hello");
    expect(serialized).not.toContain(workspace);
    expect(serialized).not.toContain("temporary.wav");
    expect(serialized).not.toContain("<html");
    expect(serialized).not.toContain("<style");
    const child = String.raw`import {inspectStudioCodeVideo} from "./src/core/motion/code/studioCodeVideoJobs.ts";
import {listStudioCodeVideos} from "./src/core/motion/code/studioCodeVideoJobs.ts";
const x=await inspectStudioCodeVideo(process.argv[1],process.argv[2]);
const l=await listStudioCodeVideos(process.argv[1]);
console.log(JSON.stringify({job:x,ids:l.map(v=>v.id)}));`;
    const stdout = execFileSync("bun", ["-e", child, workspace, created.id],
      { cwd: process.cwd(), windowsHide: true, timeout: 20000 }).toString();
    const other = JSON.parse(stdout);
    expect(other.job.status).toBe("completed");
    expect(other.job.result.id).toBe(terminal.result!.id);
    expect(other.ids).toContain(created.id);
    const foreign = await ws();
    await expect(readStudioCodeVideoJob(foreign, created.id)).resolves.toBeNull();
    expect(await listStudioCodeVideoJobs(foreign)).toEqual([]);
  }, 45000);

  it("fails closed on stale in-progress metadata without starting any renderer", async () => {
    const workspace = await ws();
    const id = "codejob-" + "b".repeat(24);
    await saveStudioCodeVideoJob(workspace, {
      id, status: "running", queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(), frameCount: 120, framesCompleted: 30,
    });
    const recovered = await inspectStudioCodeVideo(workspace, id);
    expect(recovered.status).toBe("interrupted");
    expect(recovered.result).toBeUndefined();
    expect(recovered.error).toMatch(/Renderer process stopped/);
    expect((await readStudioCodeVideoJob(workspace, id))?.status).toBe("interrupted");
    expect((await listStudioCodeVideos(workspace)).some(item=>item.id===id)).toBe(true);
  });

  it("listing job history cannot convert this process's active render into an interruption", async () => {
    const workspace = await ws();
    const running = await queueStudioCodeVideo(workspace, { html }, {
      width: 1024, height: 576, fps: 25, durationSeconds: 7,
    });
    const records = await listStudioCodeVideos(workspace);
    expect(records.some(item => item.id === running.id)).toBe(true);
    const file = path.join(workspace, ".superagent", "studio", "code", "jobs", running.id + ".json");
    const persisted = JSON.parse(await fs.readFile(file, "utf8")) as {status:string};
    expect(persisted.status).not.toBe("interrupted");
    await cancelStudioCodeVideo(workspace, running.id);
    const terminal = await finished(workspace, running.id);
    // Under parallel CI load Chromium may fail before the cancel request is
    // processed. This test protects active history, not Chrome launch.
    expect(["cancelled", "failed"]).toContain(terminal.status);
    expect(terminal.status).not.toBe("interrupted");
    expect(terminal.result).toBeUndefined();
  }, 48000);

  it("rejects malformed/symlink job manifests without leaking foreign data", async () => {
    const workspace = await ws();
    const id = "codejob-" + "c".repeat(24);
    await saveStudioCodeVideoJob(workspace, {
      id, status: "cancelled", queuedAt: new Date().toISOString(),
      framesCompleted: 0, frameCount: 0, finishedAt: new Date().toISOString(),
    });
    const dir = path.join(workspace, ".superagent", "studio", "code", "jobs");
    const file = path.join(dir, id + ".json");
    await fs.writeFile(file, '{"schemaVersion":1,"id":"'+id+'","status":"completed","queuedAt":"2026-10-25T00:00:00Z","framesCompleted":0,"frameCount":0,"result":{"id":"../../outside","bytes":1000}}');
    await expect(readStudioCodeVideoJob(workspace, id)).rejects.toThrow(/Invalid Studio/);
    const fake = path.join(workspace, "external.json");
    await fs.writeFile(fake, "{}");
    await fs.rm(file);
    await fs.symlink(fake, file, "file");
    await expect(readStudioCodeVideoJob(workspace, id)).rejects.toThrow(/Unsafe Studio/);
  });
});
