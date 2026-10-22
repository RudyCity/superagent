import { beforeAll, afterAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { transcodeMotionPreview } from "../src/core/motion/motionExportFormats.js";
let dir: string, mp4: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-exports-"));
  mp4 = path.join(dir, "source.mp4");
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi",
      "-i", "color=c=blue:s=160x90:r=10:d=0.5", "-an",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", mp4,
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let error = "";
    proc.stderr.on("data", chunk => { error += chunk.toString(); });
    proc.on("error", reject);
    proc.on("close", status => status === 0 ? resolve() : reject(new Error(error)));
  });
}, 15000);
afterAll(async () => { if (dir) await fs.rm(dir, { recursive: true, force: true }); });
describe("safe Motion extra format exporter", () => {
  it("transcodes a local MP4 into bounded, magic-verified GIF and WebM outputs", async () => {
    const gif = await transcodeMotionPreview(mp4, "gif", { durationSeconds: .5 });
    expect(gif.toString("ascii", 0, 3)).toBe("GIF");
    expect(gif.length).toBeLessThan(16 * 1024 * 1024);
    const webm = await transcodeMotionPreview(mp4, "webm", { durationSeconds: .5 });
    expect(webm[0]).toBe(0x1a); expect(webm[1]).toBe(0x45);
    expect(webm.length).toBeLessThan(16 * 1024 * 1024);
  }, 30000);
  it("refuses invalid formats and clips longer than the export ceiling", async () => {
    await expect(transcodeMotionPreview(mp4, "avi" as any)).rejects.toThrow();
    await expect(transcodeMotionPreview(mp4, "gif", { durationSeconds: 40 })).rejects.toThrow();
  });
});
