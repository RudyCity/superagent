import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import { effectRegistry } from "../src/core/motion/effects/index.js";

let server: http.Server;
let urlBase: string;
let workspace: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-effects-http-"));
  server = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMotionHttpRoute(req, res, parsed.pathname, parsed, {
      resolveWorkspacePath: () => workspace,
      sendJSON: (reply, status, body) => {
        reply.writeHead(status, { "Content-Type": "application/json" });
        reply.end(JSON.stringify(body));
      },
    }).catch(error => {
      res.writeHead(500); res.end(JSON.stringify({ error: String(error) }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP port unavailable");
  urlBase = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});
describe("Motion effects catalog HTTP contract", () => {
  it("paginates 224 effect definitions and exposes filtered totals", async () => {
    const first = await fetch(urlBase + "/api/motion/effects?limit=5&offset=0");
    expect(first.status).toBe(200);
    const page = await first.json() as any;
    expect(page.count).toBe(5);
    expect(page.total).toBe(effectRegistry.count());
    expect(page.filteredTotal).toBe(effectRegistry.count());
    expect(page.hasMore).toBe(true);
    const second = await (await fetch(urlBase + "/api/motion/effects?limit=5&offset=5")).json() as any;
    expect(second.effects[0].id).not.toBe(page.effects[0].id);
    const filtered = await (await fetch(urlBase + "/api/motion/effects?category=entrance&limit=3")).json() as any;
    expect(filtered.effects).toHaveLength(3);
    expect(filtered.effects.every((effect: any) => effect.category === "entrance")).toBe(true);
  });
  it("rejects invalid filter pagination instead of silently treating it as a search miss", async () => {
    expect((await fetch(urlBase + "/api/motion/effects?limit=1000")).status).toBe(400);
    expect((await fetch(urlBase + "/api/motion/effects?category=unknown")).status).toBe(400);
    expect((await fetch(urlBase + "/api/motion/effects?offset=-1")).status).toBe(400);
    expect((await fetch(urlBase + "/api/motion/effects?targetKind=bogus")).status).toBe(400);
  });
  it("applies effects with revision control and rejects unknown/invalid parameters without mutations", async () => {
    const project = await createMotionProject(workspace, "HTTP effects project");
    const endpoint = urlBase + "/api/motion/projects/" + project.id + "/effects";
    const send = async (body: unknown) => fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect((await send({ effectId: "entrance-fade-in", baseRevision: 1,
      targetLayerId: project.composition.layers[0].id, params: { imaginary: 1 } })).status).toBe(400);
    expect((await send({ effectId: "entrance-fade-in", baseRevision: 1,
      targetLayerId: project.composition.layers[0].id, startFrame: "0" })).status).toBe(400);
    expect((await getMotionProject(workspace, project.id)).revision).toBe(1);
    const ok = await send({ effectId: "entrance-fade-in", baseRevision: 1,
      targetLayerId: project.composition.layers[0].id });
    expect(ok.status).toBe(200);
    const updated = await ok.json() as any;
    expect(updated.revision).toBe(2);
    expect((await send({ effectId: "entrance-fade-in", baseRevision: 1,
      targetLayerId: project.composition.layers[0].id })).status).toBe(409);
  });
});
