import { beforeAll, afterAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
let workspace: string, server: http.Server, base: string;
beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-particles-route-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: () => workspace,
      sendJSON: (response, status, body) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      },
    }).catch(cause => { res.writeHead(500); res.end(JSON.stringify({ error: String(cause) })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Invalid socket");
  base = "http://127.0.0.1:" + addr.port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(workspace, { force: true, recursive: true });
});
const send = (url: string, body: unknown) => fetch(base + url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
describe("Motion CPU particles HTTP", () => {
  it("previews without persistence and applies revision-guarded source changes", async () => {
    const p = await createMotionProject(workspace, "Confetti");
    const endpoint = "/api/motion/projects/" + p.id + "/particles";
    const body = { baseRevision: 1, kind: "confetti", count: 8, color: "#F97316" };
    const preview = await send(endpoint + "/preview", body);
    expect(preview.status).toBe(200);
    const temporary = await preview.json() as any;
    expect(temporary.composition.layers).toHaveLength(9);
    expect((await getMotionProject(workspace, p.id)).composition.layers).toHaveLength(1);
    const applied = await send(endpoint, body);
    expect(applied.status).toBe(200);
    expect((await applied.json() as any).revision).toBe(2);
    expect((await send(endpoint, body)).status).toBe(409);
    expect((await send(endpoint + "/preview", { ...body, baseRevision: 2, kind: "untrusted-script" })).status).toBe(400);
    expect((await send(endpoint + "/preview", { ...body, baseRevision: 2, count: 100 })).status).toBe(400);
  });
});
