import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { ensureServerAuthToken, isRequestAuthorized } from "../src/core/utils/serverSecurity.js";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import { createCanvas } from "@napi-rs/canvas";

const cleanups: Array<() => Promise<void>> = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-route-test-"));
  const token = ensureServerAuthToken();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!isRequestAuthorized(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    await handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: request => {
        const requested = request.headers["x-workspace-path"];
        return requested === undefined || requested === root ? root : null;
      },
      sendJSON: (response, status, data) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(data));
      },
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const url = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  const request = (endpoint: string, init: RequestInit = {}) => fetch(url + endpoint, {
    ...init, headers: { Authorization: "Bearer " + token, "x-workspace-path": root, ...init.headers },
  });
  return { root, request, url };
}
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe("Motion HTTP and artifact transport", () => {
  it("keeps routes behind the existing server authentication gate", async () => {
    const { request, url } = await fixture();
    expect((await fetch(url + "/api/motion")).status).toBe(401);
    expect((await fetch(url + "/api/motion/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Promo Laris" }),
    })).status).toBe(401);
    const invalidPrompt = await request("/api/motion/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "" }),
    });
    expect(invalidPrompt.status).toBe(400);
    const invalidRevision = await request("/api/motion/projects/motion-" + "a".repeat(20) + "/revise", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "x".repeat(2500) }),
    });
    expect(invalidRevision.status).toBe(400);
    const missingAsset = await request("/api/motion/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Buat promo dengan gambar saya", imageAssetId: "asset-" + "e".repeat(64),
      }),
    });
    expect(missingAsset.status).toBe(404);
    const invalidGain = await request("/api/motion/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Video dengan musik", audioGain: 1.7 }),
    });
    expect(invalidGain.status).toBe(400);
    const invalidSceneImages = await request("/api/motion/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "3 products", sceneImageAssetIds: ["invalid-id"] }),
    });
    expect(invalidSceneImages.status).toBe(400);
    const invalidAudioLoop = await request("/api/motion/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Loop WAV", audioLoop: true }),
    });
    expect(invalidAudioLoop.status).toBe(400);
    const voiceoverUnavailable = await request("/api/motion/generate", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Local narration", voiceoverText: "Halo semua" }),
    });
    if (!process.env.SUPERAGENT_MOTION_PIPER_BIN) expect(voiceoverUnavailable.status).toBe(503);
    const result = await request("/api/motion");
    expect(result.status).toBe(200);
    const info = await result.json();
    expect(info.apiVersion).toBe(1);
    expect(info.capabilities.renderWidthMax).toBe(3840);
    expect(info.capabilities.upscale).toBe(true);
    expect(info.capabilities.aiSceneImagesMax).toBe(3);
    expect(info.capabilities.aiAudioLoop).toBe(true);
    expect(typeof info.capabilities.localVoiceoverConfigured).toBe("boolean");
    expect(info.capabilities.nativeTLineEditor).toBe("external-not-verified");
    const recovery = await request("/api/motion/queue-recovery");
    expect(recovery.status).toBe(200);
    expect((await recovery.json()).queued).toBe(0);
    expect((await request("/api/motion/queue-recovery", { method: "POST" })).status).toBe(404);
    const storage = await request("/api/motion/storage");
    expect(storage.status).toBe(200);
    expect((await storage.json()).maintenance.minAgeDays).toBe(7);
    const supervisor = await request("/api/motion/supervisor");
    expect(supervisor.status).toBe(200);
    expect((await supervisor.json())).toMatchObject({ mode: "opt-in-fifo", queuedSupervised: 0 });
    expect((await request("/api/motion/supervisor", { method: "POST" })).status).toBe(404);
    const scheduler = await request("/api/motion/scheduler");
    expect(scheduler.status).toBe(200);
    const capacity = await scheduler.json();
    expect(capacity.queueLimit).toBe(12);
    expect(capacity.maxConcurrentRenders).toBeGreaterThanOrEqual(1);
    expect(capacity.slots).toHaveLength(capacity.maxConcurrentRenders);
    expect((await request("/api/motion", { headers: { "x-workspace-path": "/not-authorized" } })).status).toBe(403);
  });

  it("creates, edits and rejects stale HTTP revision updates", async () => {
    const { request } = await fixture();
    const make = await request("/api/motion/projects", {
      method: "POST", body: JSON.stringify({ name: "HTTP Motion" }), headers: { "Content-Type": "application/json" },
    });
    expect(make.status).toBe(201);
    const created = await make.json();
    const quality = await request("/api/motion/projects/" + created.id + "/quality");
    expect(quality.status).toBe(200);
    expect((await quality.json())).toMatchObject({ passed: true, issues: [{
      code: "no-director-scenes", severity: "warning",
    }] });
    expect((await request("/api/motion/projects/" + created.id + "/quality", {
      method: "POST",
    })).status).toBe(404);
    const caption = await request("/api/motion/projects/" + created.id + "/captions.srt");
    expect(caption.status).toBe(200);
    expect(caption.headers.get("content-type")).toContain("application/x-subrip");
    expect((await caption.text()).length).toBe(0);
    expect((await request("/api/motion/projects/" + created.id + "/captions.srt", {
      method: "POST",
    })).status).toBe(404);
    expect((await request("/api/motion/projects/" + created.id + "/captions.srt", {
      headers: { "x-workspace-path": "/foreign" },
    })).status).toBe(403);
    const badVisionReview = await request("/api/motion/projects/" + "motion-" + "a".repeat(20) +
      "/vision-review", { method: "POST", body: "{}" });
    expect(badVisionReview.status).toBe(404);
    expect((await request("/api/motion/projects/" + created.id + "/vision-review", {
      method: "GET",
    })).status).toBe(404);
    expect((await request("/api/motion/projects/" + created.id + "/vision-review", {
      method: "POST", body: "{}", headers: { "x-workspace-path": "/foreign" },
    })).status).toBe(403);
    expect((await request("/api/motion/projects/" + created.id + "/vision-repair", {
      method: "POST", body: JSON.stringify({ baseRevision: "invalid" }),
    })).status).toBe(400);
    expect((await request("/api/motion/projects/" + created.id + "/vision-repair", {
      method: "GET",
    })).status).toBe(404);
    const frame = await request("/api/motion/projects/" + created.id + "/frames/0.png");
    expect(frame.status).toBe(200);
    expect(frame.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await frame.arrayBuffer());
    expect(png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))).toBe(true);
    expect((await request("/api/motion/projects/" + created.id + "/frames/999999.png")).status).toBe(400);
    expect((await request("/api/motion/projects/" + created.id + "/frames/0.png", { method: "POST" })).status).toBe(404);
    expect((await request("/api/motion/projects/" + created.id + "/frames/0.png", {
      headers: { "x-workspace-path": "/not-authorized" },
    })).status).toBe(403);
    const inspect = await request("/api/motion/projects/" + created.id);
    expect((await inspect.json()).revision).toBe(1);
    const edit = async (baseRevision: number) => request("/api/motion/projects/" + created.id + "/edits", {
      method: "POST",
      body: JSON.stringify({ baseRevision, edits: [{ type: "set-text", layerId: "title", text: "HTTP Changed" }] }),
      headers: { "Content-Type": "application/json" },
    });
    expect((await edit(1)).status).toBe(200);
    expect((await edit(1)).status).toBe(409);
    const listed = await request("/api/motion/projects");
    expect((await listed.json()).some((project: any) => project.id === created.id)).toBe(true);
    const queued = await request("/api/motion/projects/" + created.id + "/render", {
      method: "POST", body: JSON.stringify({ width: 160, supervised: true }),
      headers: { "Content-Type": "application/json" },
    });
    expect(queued.status).toBe(202);
    const queuedRecord = await queued.json();
    expect(queuedRecord).toMatchObject({ status: "queued", dispatchMode: "supervised" });
    const persisted = await request("/api/motion/jobs/" + queuedRecord.id);
    expect((await persisted.json()).status).toBe("queued");

  });

  it("imports and serves authenticated workspace PCM16 audio", async () => {
    const { request, url } = await fixture();
    const samples = 1600;
    const bytes = Buffer.alloc(44 + samples * 2);
    bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write("WAVEfmt ", 8); bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24);
    bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
    const endpoint = "/api/motion/audio";
    const imported = await request(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64: bytes.toString("base64") }),
    });
    expect(imported.status).toBe(201);
    const metadata = await imported.json();
    expect(metadata).toMatchObject({ channels: 1, sampleRate: 16000, seconds: 0.1 });
    expect(metadata.id).toMatch(/^audio-[a-f0-9]{64}$/);
    const urlPath = endpoint + "/" + metadata.id;
    const waveform = await request(urlPath + "/waveform");
    expect(waveform.status).toBe(200);
    const summary = await waveform.json();
    expect(summary.peaks).toHaveLength(96);
    expect(summary).toMatchObject({ seconds: 0.1, sampleRate: 16000, channels: 1 });
    expect((await fetch(url + urlPath + "/waveform")).status).toBe(401);
    expect((await request(urlPath + "/waveform", { headers: { "x-workspace-path": "/foreign" } })).status).toBe(403);
    const read = await request(urlPath);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("audio/wav");
    expect(Buffer.from(await read.arrayBuffer())).toEqual(bytes);
    expect((await request(urlPath, { method: "HEAD" })).status).toBe(200);
    expect((await fetch(url + urlPath)).status).toBe(401);
    expect((await request(endpoint, {
      method: "POST", body: JSON.stringify({ base64: Buffer.from("<svg/>").toString("base64") }),
      headers: { "Content-Type": "application/json" },
    })).status).toBe(400);
    expect((await request(endpoint + "/audio-" + "b".repeat(64))).status).toBe(404);
  });

  it("imports a bounded workspace image over authenticated JSON and serves only owned PNG bytes", async () => {
    const { request, url } = await fixture();
    const canvas = createCanvas(10, 10);
    canvas.getContext("2d").fillRect(0, 0, 10, 10);
    const bytes = canvas.toBuffer("image/png");
    const upload = await request("/api/motion/assets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64: bytes.toString("base64") }),
    });
    expect(upload.status).toBe(201);
    const saved = await upload.json();
    expect(saved.id).toMatch(/^asset-[a-f0-9]{64}$/);
    const get = await request("/api/motion/assets/" + saved.id);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await get.arrayBuffer())).toEqual(bytes);
    const head = await request("/api/motion/assets/" + saved.id, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get("content-length"))).toBe(bytes.length);
    expect((await fetch(url + "/api/motion/assets/" + saved.id)).status).toBe(401);
    const evil = await request("/api/motion/assets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base64: Buffer.from("<svg>bad</svg>").toString("base64") }),
    });
    expect(evil.status).toBe(400);
    expect((await request("/api/motion/assets/" + "asset-" + "a".repeat(64))).status).toBe(404);
  });

  it("streams authenticated MP4 HEAD, full GET and byte ranges with ownership checks", async () => {
    if (!(await probeFfmpeg())) return;
    const { root, request } = await fixture();
    const project = await createMotionProject(root, "Streaming");
    project.composition.durationFrames = 30;
    await fs.writeFile(path.join(root, ".superagent", "studio", "projects", project.id + ".json"), JSON.stringify(project));
    const job = await renderMotionJob(root, project.id, { width: 160 });
    expect(job.status).toBe("completed");
    const endpoint = "/api/motion/jobs/" + job.id + "/artifact";
    const head = await request(endpoint, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("video/mp4");
    expect(Number(head.headers.get("content-length"))).toBe(job.artifact!.bytes);
    const partial = await request(endpoint, { headers: { Range: "bytes=0-31" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 0-31/" + job.artifact!.bytes);
    expect((await partial.arrayBuffer()).byteLength).toBe(32);
    const invalidRange = await request(endpoint, { headers: { Range: "bytes=9999999-" } });
    expect(invalidRange.status).toBe(416);
    const full = await request(endpoint);
    expect(full.status).toBe(200);
    expect((await full.arrayBuffer()).byteLength).toBe(job.artifact!.bytes);
    expect((await request("/api/motion/jobs/motionjob-aaaaaaaaaaaaaaaaaaaaaaaa/artifact")).status).toBe(404);
  }, 30000);

  it("upscales motion projects and retrieves available targets via HTTP API", async () => {
    const { root, request } = await fixture();
    const project = await createMotionProject(root, "Upscale API");

    const targetsRes = await request("/api/motion/projects/" + project.id + "/upscale/targets");
    expect(targetsRes.status).toBe(200);
    const targets = await targetsRes.json();
    expect(targets.availableTargets.length).toBeGreaterThan(0);
    expect(targets.availableTargets.map((t: any) => t.target)).toContain("4k");

    const previewRes = await request("/api/motion/projects/" + project.id + "/upscale/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: project.revision, target: "1080p" }),
    });
    expect(previewRes.status).toBe(200);
    const previewData = await previewRes.json();
    expect(previewData.composition.width).toBe(1920);

    const commitRes = await request("/api/motion/projects/" + project.id + "/upscale", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: project.revision, target: "4k" }),
    });
    expect(commitRes.status).toBe(200);
    const commitData = await commitRes.json();
    expect(commitData.composition.width).toBe(3840);
    expect(commitData.revision).toBe(project.revision + 1);
  });
});
