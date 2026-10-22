import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";

let server: http.Server, base: string, workspace: string;
beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-template-http-"));
  server = http.createServer((req, res) => {
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMotionHttpRoute(req, res, parsed.pathname, parsed, {
      resolveWorkspacePath: () => workspace,
      sendJSON: (r, status, body) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(body)); },
    }).catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server address unavailable");
  base = "http://127.0.0.1:" + address.port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await fs.rm(workspace, { recursive: true, force: true });
});
const send = async (url: string, body: unknown) => fetch(base + url, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
describe("Motion template and Brand Kit HTTP API", () => {
  it("serves six safe templates, persists workspace brand settings and rejects revision conflict", async () => {
    const gallery = await (await fetch(base + "/api/motion/templates")).json() as any;
    expect(gallery.templates).toHaveLength(6);
    const original = await (await fetch(base + "/api/motion/brand-kit")).json() as any;
    expect(original.revision).toBe(0);
    const brand = { name: "Laris", primary: "#123456", accent: "#ff9900",
      background: "#101010", textColor: "#eeeeee", fontFamily: "Arial" };
    const response = await send("/api/motion/brand-kit", { baseRevision: 0, brand });
    expect(response.status).toBe(200);
    expect((await response.json() as any).revision).toBe(1);
    expect((await send("/api/motion/brand-kit", { baseRevision: 0, brand })).status).toBe(409);
    expect((await send("/api/motion/brand-kit", { baseRevision: 1, brand: { ...brand, accent: "invalid" } })).status).toBe(400);
  });
  it("compiles preview without a commit and saves a template with optimistic locking", async () => {
    const p = await createMotionProject(workspace, "Template HTTP");
    const endpoint = "/api/motion/projects/" + p.id + "/templates";
    const body = { baseRevision: 1, templateId: "saas-feature",
      headline: "New feature", subtitle: "Ship faster" };
    const preview = await send(endpoint + "/preview", body);
    expect(preview.status).toBe(200);
    const rendered = await preview.json() as any;
    expect(rendered.composition.background).toBe("#101010");
    expect(rendered.composition.layers.some((item: any) => item.kind === "text" && item.text === body.headline)).toBe(true);
    expect((await getMotionProject(workspace, p.id)).revision).toBe(1);
    const applied = await send(endpoint, body);
    expect(applied.status).toBe(200);
    expect((await applied.json() as any).revision).toBe(2);
    expect((await send(endpoint, body)).status).toBe(409);
    expect((await send(endpoint + "/preview", { ...body, baseRevision: 2, templateId: "unsafe" })).status).toBe(400);
    expect((await send(endpoint, { ...body, baseRevision: 2, headline: "X".repeat(300) })).status).toBe(400);
  });
});
