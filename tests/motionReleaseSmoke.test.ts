import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { compileMotionTypography } from "../src/core/motion/motionTypography.js";
import { compileMotionParticles } from "../src/core/motion/motionParticles.js";
import { renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
describe("Motion Studio production-format smoke with real FFmpeg", () => {
  it("renders saved typography+particles and serves verified MP4 ranges, GIF and WebM over Motion HTTP", async () => {
    // Do NOT silently skip the release smoke on a machine without the actual encoder.
    expect(await probeFfmpeg(), "FFmpeg must be installed for a Motion release smoke").toBe(true);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-release-smoke-"));
    roots.push(root);
    let server: http.Server | undefined;
    try {
      const created = await createMotionProject(root, "Actual Motion export");
      const source = structuredClone(created);
      source.composition.durationFrames = 30; // one second at 30 FPS
      source.composition.width = 160;
      source.composition.height = 90;
      const original = source.composition.layers[0];
      original.tracks = [];
      original.x = 12; original.y = 24; original.width = 128; original.height = 28;
      if (original.kind === "text") { original.fontSize = 17; original.text = "Motion QA"; }
      const type = compileMotionTypography(source, {
        targetLayerId: original.id, style: "word-rise", durationFrames: 24,
      });
      const final = compileMotionParticles({ ...source, composition: type }, {
        kind: "confetti", count: 6, color: "#F97316",
      });
      const saved = await updateMotionProject(root, created.id, 1, [
        { type: "replace-composition", composition: final },
      ]);
      expect(saved.revision).toBe(2);
      const job = await renderMotionJob(root, created.id, { width: 160 });
      expect(job.status, job.error).toBe("completed");
      expect(job.framesCompleted).toBe(30);
      expect(job.artifact?.bytes).toBeGreaterThan(500);
      const mp4 = await fs.readFile(job.artifact!.path);
      expect(mp4.toString("ascii", 4, 8)).toBe("ftyp");
      expect(crypto.createHash("sha256").update(mp4).digest("hex")).toBe(job.artifact!.sha256);

      server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        void handleMotionHttpRoute(req, res, url.pathname, url, {
          resolveWorkspacePath: () => root,
          sendJSON: (r, status, body) => {
            r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(body));
          },
        }).catch(error => { if (!res.headersSent) { res.writeHead(500); res.end(String(error)); } });
      });
      await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("Failed to bind loopback server");
      const base = "http://127.0.0.1:" + addr.port + "/api/motion/jobs/" + job.id;
      const head = await fetch(base + "/artifact", { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("video/mp4");
      expect(Number(head.headers.get("content-length"))).toBe(mp4.length);
      const ranged = await fetch(base + "/artifact", { headers: { Range: "bytes=0-63" } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe("bytes 0-63/" + mp4.length);
      expect(Buffer.from(await ranged.arrayBuffer())).toEqual(mp4.subarray(0, 64));
      const invalidRange = await fetch(base + "/artifact", { headers: { Range: "bytes=999999999-" } });
      expect(invalidRange.status).toBe(416);
      // Conversions for a single immutable artifact are intentionally serialized.
      const gif = await fetch(base + "/exports/gif");
      expect(gif.status).toBe(200);
      expect(gif.headers.get("content-type")).toBe("image/gif");
      const gifBytes = Buffer.from(await gif.arrayBuffer());
      expect(gifBytes.subarray(0, 3).toString("ascii")).toBe("GIF");
      expect(gifBytes.length).toBeGreaterThan(100);
      const webm = await fetch(base + "/exports/webm");
      expect(webm.status).toBe(200);
      expect(webm.headers.get("content-type")).toBe("video/webm");
      const webmBytes = Buffer.from(await webm.arrayBuffer());
      expect(webmBytes.subarray(0, 4)).toEqual(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
      expect(webmBytes.length).toBeGreaterThan(100);
      expect((await fetch(base + "/exports/avi")).status).toBe(404);
      // Concurrent requests may serialize or reject the extra request.
      // A deliberate load limiter must never surface as HTTP 500.
      const simultaneous = await Promise.all([
        fetch(base + "/exports/gif"), fetch(base + "/exports/webm"),
      ]);
      expect(simultaneous.map(r => r.status)).toContain(200);
      for (const response of simultaneous) {
        expect([200, 503]).toContain(response.status);
        if (response.status === 503) {
          expect((await response.json() as { error: string }).error).toMatch(/converter busy/i);
        } else await response.arrayBuffer();
      }
    } finally {
      if (server) await new Promise<void>((resolve, reject) =>
        server!.close(error => error ? reject(error) : resolve()));
    }
  }, 90000);
});
