import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderStudioReactComponent } from "../src/core/motion/code/studioReactCodeExporter.js";
import { extractStudioReactOfflineHtml } from "../src/core/motion/code/studioBrowserVideoRenderer.js";
import { readStudioCodeVideo, renderStudioBrowserVideo } from "../src/core/motion/code/studioBrowserVideoRenderer.js";

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map(item => fs.rm(item, { force: true, recursive: true })));
});
async function workspace() {
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), "studio-code-to-video-"));
  workspaces.push(ws);
  return ws;
}
const html = '<!doctype html><html><head><style>body{margin:0;background:#111}' +
  '.ball{width:80px;height:80px;background:orange;animation:move 1s linear both}' +
  '@keyframes move{from{transform:translateX(0)}to{transform:translateX(320px)}}</style>' +
  '</head><body><div class="ball"></div></body></html>';

describe("Code-to-Video Chromium+FFmpeg developer preview", () => {
  it("rejects remote/file assets, active external sources, invalid profiles and missing trust paths", async () => {
    const ws = await workspace();
    for (const source of [
      '<html><script src="https://evil.example/app.js"></script></html>',
      '<!doctype html><html><iframe src="about:blank"></iframe></html>',
      '<!doctype html><html><img src="file:///c:/secret"></html>',
      '<!doctype html><html><link href="//evil.example/main.css" rel="stylesheet"></html>',
      '<!doctype html><html><script>new WebSocket("socket")</script></html>',
    ]) await expect(renderStudioBrowserVideo(ws, { html: source }, { fps: 5 })).rejects.toThrow();
    await expect(renderStudioBrowserVideo(ws, { html }, {
      width: 321, height: 360, fps: 5, durationSeconds: 1,
    })).rejects.toThrow(/Code-to-Video requires/);
    await expect(renderStudioBrowserVideo(ws, { html }, {
      width: 640, height: 360, fps: 30, durationSeconds: 12,
    })).rejects.toThrow(/Code-to-Video requires/);
    await expect(readStudioCodeVideo(ws, "../outside")).rejects.toThrow(/Invalid code video ID/);
  });

  it("renders distinct CSS keyframes into an offline H.264 MP4", async () => {
    const ws = await workspace();
    const result = await renderStudioBrowserVideo(ws, { html }, {
      width: 640, height: 360, fps: 5, durationSeconds: 1,
    });
    expect(result).toMatchObject({ source: "html", fps: 5, frameCount: 5, width: 640, height: 360 });
    expect(result.bytes).toBeGreaterThan(1500);
    const data = await readStudioCodeVideo(ws, result.id);
    expect(data.length).toBe(result.bytes);
    const output = execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", result.file, "-f", "framemd5", "-",
    ], { windowsHide: true, timeout: 18000 }).toString();
    const lines = output.split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
    expect(lines).toHaveLength(5);
    expect(new Set(lines.map(line => line.split(",").at(-1)?.trim())).size).toBe(5);
    expect(data.includes(Buffer.from("ftyp"))).toBe(true);
  }, 65000);

  it("converts generated React TSX wrappers without compiling or executing arbitrary React", async () => {
    const ws = await workspace();
    const project = await createMotionProject(ws, "React code to video");
    const tsx = renderStudioReactComponent(project);
    expect(extractStudioReactOfflineHtml(tsx)).toContain('id="studio-stage"');
    expect(() => extractStudioReactOfflineHtml('export default function Dangerous(){ return null; }'))
      .toThrow(/only Studio-generated/);
    const video = await renderStudioBrowserVideo(ws, { reactTsx: tsx }, {
      width: 640, height: 360, fps: 4, durationSeconds: 1,
    });
    expect(video.source).toBe("studio-react");
    expect(video.bytes).toBeGreaterThan(1500);
  }, 65000);

  it("renders a first-party Studio project and retains private workspace ownership", async () => {
    const ws = await workspace();
    const project = await createMotionProject(ws, "Code video test");
    const result = await renderStudioBrowserVideo(ws, { project }, {
      width: 640, height: 360, fps: 4, durationSeconds: 1,
    });
    expect(result).toMatchObject({ source: "studio", frameCount: 4 });
    const other = await workspace();
    await expect(readStudioCodeVideo(other, result.id)).rejects.toThrow();
  }, 65000);
});
