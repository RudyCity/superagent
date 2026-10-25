import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createCanvas } from "@napi-rs/canvas";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { listMotionProjects } from "../src/core/motion/project/projectStore.js";

const run = promisify(execFile);

describe("Studio multi reconstruction HTTP workflow (behind global auth gate)", () => {
  it("uploads a bounded video, creates two layers and serves a private review image", async () => {
    const ws = await fs.mkdtemp(path.join(os.tmpdir(), "studio-multi-http-"));
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      void handleMotionHttpRoute(req, res, url.pathname, url, {
        resolveWorkspacePath: () => ws,
        sendJSON(r, status, data) {
          r.writeHead(status, { "Content-Type": "application/json" });
          r.end(JSON.stringify(data));
        },
      }).then(handled => {
        if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
      }).catch(err => {
        if (!res.headersSent) { res.writeHead(500); res.end(String(err)); }
      });
    });
    try {
      for (let f = 0; f < 30; f++) {
        const canvas = createCanvas(160, 90);
        const context = canvas.getContext("2d");
        context.fillStyle = "#000";
        context.fillRect(0, 0, 160, 90);
        context.fillStyle = "#ffffff";
        context.fillRect(15 + f, 15, 20, 19);
        context.fillStyle = "#fff0ab";
        context.fillRect(95 + Math.floor(f / 5), 50, 20, 18);
        await fs.writeFile(path.join(ws, "f" + String(f).padStart(3, "0") + ".png"),
          await canvas.encode("png"));
      }
      await run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-framerate", "10",
        "-i", path.join(ws, "f%03d.png"), "-y", "-c:v", "libx264",
        "-pix_fmt", "yuv420p", path.join(ws, "clip.mp4"),
      ], { timeout: 25000, maxBuffer: 4096, windowsHide: true });
      const input = await fs.readFile(path.join(ws, "clip.mp4"));
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No test listener");
      const base = "http://127.0.0.1:" + address.port + "/api/studio";
      const rejected = await fetch(base + "/videos", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64: Buffer.alloc(60, 42).toString("base64") }),
      });
      expect(rejected.status).toBe(400);
      const upload = await fetch(base + "/videos", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64: input.toString("base64") }),
      });
      expect(upload.status).toBe(201);
      const media = await upload.json() as { id: string };
      expect(media.id).toMatch(/^video-[a-f0-9]{64}$/);
      const invalid = await fetch(base + "/reconstruct/multi", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: "../../outside" }),
      });
      expect(invalid.status).toBe(400);
      expect(await listMotionProjects(ws)).toHaveLength(0);
      const rebuilt = await fetch(base + "/reconstruct/multi", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: media.id }),
      });
      expect(rebuilt.status).toBe(201);
      const body = await rebuilt.json() as {
        projectId: string; revision: number; objects: unknown[];
        measuredForegroundIoU: number[]; interpolationCheckIoU: number[];
        timelineValidation: {status: string; minimumForegroundIoU: number;
          meanForegroundIoU: number; minIdentityGap: number; note: string;
          checks: Array<{frame:number; identityGap:number; foregroundIoU:number}> };
        parityReport: Array<{ frame:number; sampleType:string;
          foregroundIoU:number; foregroundPrecision:number;
          foregroundRecall:number; foregroundF1:number; rgbMeanAbsoluteError:number }>;
      };
      expect((body as Record<string, unknown>).reviewPng).toBeUndefined();
      expect((body as Record<string, unknown>).diffPng).toBeUndefined();
      expect(body.objects).toHaveLength(2);
      expect(body.measuredForegroundIoU).toHaveLength(3);
      expect(body.interpolationCheckIoU).toHaveLength(2);
      expect(body.timelineValidation.status).toBe("passed-sampled");
      expect(body.timelineValidation.checks.length).toBeGreaterThanOrEqual(14);
      expect(body.timelineValidation.checks.length).toBeLessThanOrEqual(20);
      expect(body.timelineValidation.minimumForegroundIoU).toBeGreaterThanOrEqual(.38);
      expect(body.timelineValidation.minIdentityGap).toBeGreaterThan(.045);
      expect(body.timelineValidation.checks.every(c=>c.identityGap>.045 && c.foregroundIoU>=.38))
        .toBe(true);
      expect(body.parityReport).toHaveLength(5);
      expect(body.parityReport.filter(frame=>frame.sampleType==='holdout')).toHaveLength(2);
      expect(body.parityReport.map(frame=>frame.frame)).toEqual(
        [...body.parityReport.map(frame=>frame.frame)].sort((a,b)=>a-b));
      expect(body.parityReport.every(frame=>frame.foregroundIoU>=.38 &&
        frame.foregroundPrecision>0 && frame.foregroundRecall>0 &&
        frame.foregroundF1>0 && frame.rgbMeanAbsoluteError>=0)).toBe(true);
      const url = base + "/projects/" + body.projectId +
        "/reconstruction-review.png?revision=" + body.revision;
      const preview = await fetch(url);
      expect(preview.status).toBe(200);
      expect(preview.headers.get("content-type")).toBe("image/png");
      expect(preview.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await preview.arrayBuffer()).subarray(0, 8).toString("hex"))
        .toBe("89504e470d0a1a0a");
      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      expect((await fetch(url + "999")).status).toBe(400);
      const difference = await fetch(base + "/projects/" + body.projectId +
        "/reconstruction-diff.png?revision=" + body.revision);
      expect(difference.status).toBe(200);
      expect(difference.headers.get("content-type")).toBe("image/png");
      expect(difference.headers.get("cache-control")).toBe("private, no-store");
      expect(Buffer.from(await difference.arrayBuffer()).subarray(0,8).toString("hex"))
        .toBe("89504e470d0a1a0a");
      const diffHead = await fetch(base + "/projects/" + body.projectId +
        "/reconstruction-diff.png?revision=" + body.revision, { method: "HEAD" });
      expect(diffHead.status).toBe(200);
      expect((await diffHead.arrayBuffer()).byteLength).toBe(0);
      expect((await fetch(base + "/projects/" + body.projectId +
        "/reconstruction-diff.png?revision=999999999")).status).toBe(400);
      const original = await fetch(base + "/projects/" + body.projectId);
      expect(original.status).toBe(200);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(ws, { recursive: true, force: true });
    }
  }, 65000);
});
