import { beforeAll, afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { importMotionAudio } from "../src/core/motion/assets/motionAudio.js";

let server: http.Server; let base: string; let workspace: string;
const sample = () => {
  const hz = 8000, count = hz * 2, wav = Buffer.alloc(44 + count * 2);
  wav.write("RIFF", 0, "ascii"); wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii"); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(hz, 24); wav.writeUInt32LE(hz * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii"); wav.writeUInt32LE(count * 2, 40);
  for (const moment of [.2, .6, 1.0, 1.4]) {
    const offset = Math.round(moment * hz);
    for (let i = offset; i < offset + 320; i++) wav.writeInt16LE(
      Math.round(Math.sin((i - offset) * .12) * 18000), 44 + i * 2);
  }
  return wav;
};
beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "beat-route-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: () => workspace,
      sendJSON: (r, status, body) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(body)); },
    }).catch(cause => { res.writeHead(500); res.end(JSON.stringify({ error: String(cause) })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Invalid address");
  base = "http://127.0.0.1:" + addr.port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});
const request = (url: string, body: unknown) => fetch(base + url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
describe("Motion beat sync HTTP", () => {
  it("previews without saving, applies through revision checked project edits", async () => {
    const sound = await importMotionAudio(workspace, sample());
    const project = await createMotionProject(workspace, "Beat preview");
    const withWav = await updateMotionProject(workspace, project.id, 1, [
      { type: "set-audio-tracks", audioTracks: [{ assetId: sound.id, startFrame: 0, volume: 1 }] },
    ]);
    const endpoint = "/api/motion/projects/" + project.id + "/beat-sync";
    const body = { baseRevision: 2, targetLayerId: "title", intensity: .4 };
    const preview = await request(endpoint + "/preview", body);
    expect(preview.status).toBe(200);
    const simulated = await preview.json() as any;
    expect(simulated.onsetFrames.length).toBeGreaterThanOrEqual(3);
    expect(simulated.project.revision).toBe(2);
    expect((await getMotionProject(workspace, project.id)).composition.layers[0].tracks)
      .toEqual(withWav.composition.layers[0].tracks);
    const applied = await request(endpoint, body);
    expect(applied.status).toBe(200);
    expect((await applied.json() as any).project.revision).toBe(3);
    expect((await request(endpoint, body)).status).toBe(409);
    expect((await request(endpoint + "/preview", {
      baseRevision: 3, targetLayerId: "missing",
    })).status).toBe(400);
  });
});
