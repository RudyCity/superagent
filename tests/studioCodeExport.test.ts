import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { renderStudioCodeHtml } from "../src/core/motion/code/studioCodeExporter.js";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

let workspace = "", project: MotionProject, server: http.Server, base = "";
beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "studio-code-test-"));
  const created = await createMotionProject(workspace, "Interactive <svg> & GSAP");
  project = await getMotionProject(workspace, created.id);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: () => workspace,
      sendJSON(r, status, data) {
        r.writeHead(status, { "Content-Type": "application/json" });
        r.end(JSON.stringify(data));
      },
    }).then(handled => {
      if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
    }).catch(error => {
      if (!res.headersSent) { res.writeHead(500); res.end(String(error)); }
    });
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("Test server binding unavailable");
  base = "http://127.0.0.1:" + addr.port;
});
afterAll(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

function svgProject() {
  return structuredClone(project);
}

describe("Studio to Code deterministic vector export", () => {
  it.each(["autoplay", "scroll", "click", "hover"] as const)(
    "generates parsed SVG + GSAP timeline for %s", trigger => {
      const html = renderStudioCodeHtml(svgProject(), trigger);
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('id="studio-stage"');
      expect(html).toContain('data-studio-id="title"');
      expect(html).toContain('gsap@3.15.0/dist/gsap.min.js');
      expect(html).toContain('"trigger":"' + trigger + '"');
      expect(html).not.toContain('<video');
      expect(html).not.toContain('/api/motion/jobs');
      const match = html.match(/<script>([\s\S]+?)<\/script>/);
      expect(match).not.toBeNull();
      expect(() => new vm.Script(match![1])).not.toThrow();
      expect(html.includes("ScrollTrigger.min.js")).toBe(trigger === "scroll");
    });
  it("escapes user-supplied text and code injection from markup + JSON payload", () => {
    const p = svgProject();
    p.name = "Injected <script>alert(1)</script>";
    const text = p.composition.layers.find(l => l.kind === "text");
    if (!text || text.kind !== "text") throw new Error("Fixture lacks text");
    text.text = '</script><img src=x onerror=alert("bad")> &';
    const html = renderStudioCodeHtml(p);
    expect(html).toContain('&lt;/script&gt;&lt;img');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html.match(/<script(?:\s|>)/g)?.length).toBe(2);
    expect(() => new vm.Script(html.match(/<script>([\s\S]+?)<\/script>/)![1])).not.toThrow();
  });
  it("rejects raster, video, and audio instead of omitting unsupported source data", () => {
    const p = svgProject();
    const original = p.composition.layers[0];
    if (original.kind !== "text") throw new Error("Fixture lacks text");
    const { text: _text, fontSize: _fontSize, fontFamily: _fontFamily, ...base } = original;
    p.composition.layers[0] = {
      ...base, kind: "image", assetId: "asset-" + "a".repeat(64),
    };
    expect(() => renderStudioCodeHtml(p)).toThrow(/vector\/text-only/);
    const q = svgProject();
    q.composition.audioTracks = [{
      assetId: "audio-" + "a".repeat(64), startFrame: 0, volume: 1,
    }];
    expect(() => renderStudioCodeHtml(q)).toThrow(/does not yet export audio/);
  });
  it("returns a downloadable HTML document over both authorized route aliases", async () => {
    for (const prefix of ["/api/studio", "/api/motion"]) {
      const url = base + prefix + "/projects/" + project.id + "/code.html?trigger=scroll";
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain("attachment;");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(await response.text()).toContain("ScrollTrigger.min.js");
    }
  });
  it("rejects invalid triggers and unknown project identifiers", async () => {
    const route = base + "/api/studio/projects/" + project.id + "/code.html";
    expect((await fetch(route + "?trigger=evil")).status).toBe(400);
    expect((await fetch(base + "/api/studio/projects/studio-" + "b".repeat(20) + "/code.html")).status).toBe(404);
  });
});
