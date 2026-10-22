import { beforeAll, afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
let workspace: string, server: http.Server, base: string;
beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-type-route-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: () => workspace,
      sendJSON: (r, status, value) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(value)); },
    }).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("invalid socket");
  base = "http://127.0.0.1:" + addr.port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(workspace, { force: true, recursive: true });
});
const send = (endpoint: string, data: unknown) => fetch(base + endpoint, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
});
describe("advanced typography HTTP", () => {
  it("previews without persistence and applies only with current revision", async () => {
    const source = await createMotionProject(workspace, "New feature");
    const path = "/api/motion/projects/" + source.id + "/typography";
    const options = { baseRevision: 1, targetLayerId: "title",
      style: "letter-reveal", startFrame: 0, durationFrames: 25 };
    const temporary = await send(path + "/preview", options);
    expect(temporary.status).toBe(200);
    expect((await temporary.json() as any).composition.layers.length).toBeGreaterThan(1);
    expect((await getMotionProject(workspace, source.id)).revision).toBe(1);
    const saved = await send(path, options);
    expect(saved.status).toBe(200);
    expect((await saved.json() as any).revision).toBe(2);
    expect((await send(path, options)).status).toBe(409);
    expect((await send(path, { ...options, baseRevision: 2, style: "raw-css" })).status).toBe(400);
  });
});
