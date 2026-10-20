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
    const result = await request("/api/motion");
    expect(result.status).toBe(200);
    expect((await result.json()).apiVersion).toBe(1);
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
    await fs.writeFile(path.join(root, ".superagent", "motion", "projects", project.id + ".json"), JSON.stringify(project));
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
});
