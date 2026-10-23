import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";

let workspace: string, server: http.Server, origin: string;
beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "studio-api-migration-"));
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: () => workspace,
      sendJSON: (r, status, payload) => {
        r.writeHead(status, { "Content-Type": "application/json" });
        r.end(JSON.stringify(payload));
      },
    }).then(handled => { if (!handled && !res.headersSent) { res.writeHead(404); res.end(); } })
      .catch(e => { if (!res.headersSent) res.writeHead(500); res.end(String(e)); });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Binding failed");
  origin = "http://127.0.0.1:" + address.port;
});
afterAll(async () => {
  if (server.listening) {
    server.closeAllConnections();
    try {
      await new Promise<void>((done, reject) => server.close(e => {
        if (!e || /server is not running/i.test(String(e))) done();
        else reject(e);
      }));
    } catch (error) {
      if (!/server is not running/i.test(String(error))) throw error;
    }
  }
  await fs.rm(workspace, { recursive: true, force: true });
});

describe("Canonical Studio HTTP API with legacy Motion compatibility", () => {
  it("reads the same saved project through both namespaces and uses Studio storage", async () => {
    const created = await createMotionProject(workspace, "Compatibility scene");
    for (const route of ["/api/studio", "/api/motion"]) {
      const capabilities = await fetch(origin + route);
      expect(capabilities.status).toBe(200);
      expect((await capabilities.json() as { capabilities: { productDisplayName: string } })
        .capabilities.productDisplayName).toBe("SuperAgent Studio");
      const list = await fetch(origin + route + "/projects");
      expect(list.status).toBe(200);
      expect((await list.json() as Array<{ id: string }>)[0].id).toBe(created.id);
      const inspect = await fetch(origin + route + "/projects/" + created.id);
      expect(inspect.status).toBe(200);
      expect((await inspect.json() as { id: string }).id).toBe(created.id);
    }
    expect((await getMotionProject(workspace, created.id)).revision).toBe(1);
    expect(await fs.stat(path.join(workspace, ".superagent", "studio", "projects", created.id + ".json")))
      .toMatchObject({ isFile: expect.any(Function) });
  });
  it("does not accept a similar-looking unrelated API prefix", async () => {
    expect((await fetch(origin + "/api/studio-not-authorized")).status).toBe(404);
    expect((await fetch(origin + "/api/motion-not-authorized")).status).toBe(404);
  });
});
