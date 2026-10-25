import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderStudioReactComponent } from "../src/core/motion/code/studioReactCodeExporter.js";

describe("studio code-video authenticated workspace routes", () => {
  it("rejects untrusted HTML, renders Studio project and serves private MP4", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "studio-code-video-http-"));
    const server = http.createServer((req, res) => {
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
    try {
      const project = await createMotionProject(workspace, "Code video HTTP");
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing test server address");
      const base = "http://127.0.0.1:" + address.port + "/api/studio";
      const post = async (input: unknown) => fetch(base + "/code-to-video", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const html = '<!doctype html><html><body><style>body{background:#123}</style>' +
        '<h1>Demo</h1></body></html>';
      expect((await post({ html, width: 640, height: 360, fps: 4, durationSeconds: 1 })).status)
        .toBe(400);
      expect((await post({ projectId: "../outside", width: 640, height: 360, fps: 4,
        durationSeconds: 1 })).status).toBe(400);
      const request = await post({ projectId: project.id, width: 640, height: 360,
        fps: 4, durationSeconds: 1 });
      expect(request.status).toBe(201);
      const value = await request.json() as { id: string; bytes: number; file?: string; frameCount: number };
      expect(value.id).toMatch(/^codevideo-[a-f0-9]{24}$/);
      expect(value.file).toBeUndefined();
      expect(value.frameCount).toBe(4);
      const response = await fetch(base + "/code-videos/" + value.id + ".mp4");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await response.arrayBuffer()).includes(Buffer.from("ftyp"))).toBe(true);
      expect((await fetch(base + "/code-videos/../../outside.mp4")).status).not.toBe(200);
      const htmlResult = await post({ html, trustLocalHtml: true, width: 640, height: 360,
        fps: 4, durationSeconds: 1 });
      expect(htmlResult.status).toBe(201);
      const reactResult = await post({
        reactTsx: renderStudioReactComponent(project), trustLocalHtml: true,
        width: 640, height: 360, fps: 4, durationSeconds: 1,
      });
      expect(reactResult.status).toBe(201);
      const reactBody = await reactResult.json() as { source: string; file?: string };
      expect(reactBody.source).toBe("studio-react");
      expect(reactBody.file).toBeUndefined();
      const queuedResponse = await fetch(base + "/code-to-video/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, width: 640, height: 360,
          fps: 6, durationSeconds: 1 }),
      });
      expect(queuedResponse.status).toBe(202);
      const submitted = await queuedResponse.json() as { id: string; status: string };
      expect(submitted.id).toMatch(/^codejob-[a-f0-9]{24}$/);
      let polled: { status: string; framesCompleted: number; result?: { id: string; file?: string } } |
        undefined;
      for (let retry = 0; retry < 150; retry++) {
        const status = await fetch(base + "/code-to-video/jobs/" + submitted.id);
        expect(status.status).toBe(200);
        polled = await status.json() as typeof polled;
        if (polled?.status === "completed" || polled?.status === "failed") break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(polled?.status).toBe("completed");
      expect(polled?.framesCompleted).toBe(6);
      expect(polled?.result?.file).toBeUndefined();
      const mp4 = await fetch(base + "/code-videos/" + polled!.result!.id + ".mp4");
      expect(mp4.status).toBe(200);
      expect(mp4.headers.get("content-type")).toBe("video/mp4");
      const cancelCompleted = await fetch(base + "/code-to-video/jobs/" + submitted.id + "/cancel", {
        method: "POST",
      });
      expect(cancelCompleted.status).toBe(200);
      expect((await cancelCompleted.json() as { status: string }).status).toBe("completed");
      const fakeId = "codejob-" + "f".repeat(24);
      expect((await fetch(base + "/code-to-video/jobs/" + fakeId)).status).toBe(404);

    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(workspace, { recursive: true, force: true });
    }
  }, 65000);
});
