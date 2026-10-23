import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { ensureServerAuthToken, isRequestAuthorized } from "../src/core/utils/serverSecurity.js";
import { createMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { MOTION_CAPABILITIES } from "../src/core/motion/motionCapabilities.js";
import { TLINE_HTTP_ACTIONS, TLINE_STREAM_ACTIONS } from "../src/core/channels/tlineCapabilities.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { createMotionFrameRenderer } from "../src/core/motion/render/canvasFrames.js";
import { emitMotionStudioEvent, subscribeMotionStudioEvents } from "../src/core/motion/motionEvents.js";
import { exportMotionDeliverablesBundle, getMotionDeliverablesBundleManifest } from "../src/core/motion/motionBundleExport.js";
import { createCanvas, type Image } from "@napi-rs/canvas";

const cleanups: Array<() => Promise<void>> = [];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-tline-bundle-test-"));
  const token = ensureServerAuthToken();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!isRequestAuthorized(req, url)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    await handleMotionHttpRoute(req, res, url.pathname, url, {
      resolveWorkspacePath: request => {
        const requested = request.headers["x-workspace-path"];
        return requested === undefined || requested === root ? root : null;
      },
      sendJSON: (response, status, data) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(data));
      },
    });
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP listener");
  const url = `http://127.0.0.1:${address.port}`;

  cleanups.push(async () => {
    await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    await fs.rm(root, { recursive: true, force: true });
  });

  const request = (endpoint: string, init: RequestInit = {}) =>
    fetch(url + endpoint, {
      ...init,
      headers: {
        Authorization: "Bearer " + token,
        "x-workspace-path": root,
        ...init.headers,
      },
    });

  return { root, request, url };
}

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe("T-Line Bridge, Video Media Engine & Export Deliverables Bundle", () => {
  describe("Component 1: T-Line Desktop Integration & Live Event Stream", () => {
    it("advertises bridge-ready and live event stream capabilities", () => {
      expect(MOTION_CAPABILITIES.tlineStudioBridge).toBe(true);
      expect(MOTION_CAPABILITIES.studioLiveEventStream).toBe(true);
    });

    it("registers studio HTTP and stream actions in TLINE capability manifest", () => {
      const httpActionIds = TLINE_HTTP_ACTIONS.map(a => a.id);
      expect(httpActionIds).toContain("studio.status");
      expect(httpActionIds).toContain("studio.projects");
      expect(httpActionIds).toContain("studio.bundle");

      const streamActionIds = TLINE_STREAM_ACTIONS.map(a => a.id);
      expect(streamActionIds).toContain("studio.events");
    });

    it("serves /api/motion/tline-bridge status endpoint", async () => {
      const { request } = await fixture();
      const res = await request("/api/motion/tline-bridge");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ready).toBe(true);
      expect(data.channel).toBe("sse");
      expect(typeof data.activeStreamSubscribers).toBe("number");
    });

    it("publishes and receives live studio events via event bus", async () => {
      const { root } = await fixture();
      const received: any[] = [];
      const unsubscribe = subscribeMotionStudioEvents(root, event => {
        received.push(event);
      });

      emitMotionStudioEvent({
        type: "project.created",
        workspace: root,
        projectId: "studio-testproject0001",
        revision: 1,
      });

      expect(received.length).toBe(1);
      expect(received[0].type).toBe("project.created");
      expect(received[0].projectId).toBe("studio-testproject0001");
      expect(received[0].timestamp).toBeDefined();

      unsubscribe();
    });
  });

  describe("Component 2: Video Engine Trimming & Speed Ramping", () => {
    it("advertises video trimming and speed ramping capabilities", () => {
      expect(MOTION_CAPABILITIES.videoTrimming).toBe(true);
      expect(MOTION_CAPABILITIES.videoSpeedRamping).toBe(true);
    });

    it("validates VideoLayer with trimInSeconds, trimOutSeconds, and speedMultiplier", async () => {
      const { root } = await fixture();
      const project = await createMotionProject(root, "Video Trim Test");

      const validVideoLayer = {
        kind: "video" as const,
        id: "video-bg",
        assetId: "video-" + "a".repeat(64),
        x: 0,
        y: 0,
        width: 1280,
        height: 720,
        rotation: 0,
        opacity: 1,
        fill: "#000000",
        tracks: [],
        startFrame: 0,
        trimInSeconds: 1.5,
        trimOutSeconds: 4.5,
        speedMultiplier: 1.5,
        loop: true,
      };

      const validComposition = {
        ...project.composition,
        layers: [validVideoLayer],
      };

      expect(() => validateMotionProject({ ...project, composition: validComposition })).not.toThrow();

      // Inverted trim range: trimIn >= trimOut
      const invertedTrim = {
        ...validVideoLayer,
        trimInSeconds: 5.0,
        trimOutSeconds: 3.0,
      };
      expect(() =>
        validateMotionProject({
          ...project,
          composition: { ...project.composition, layers: [invertedTrim] },
        }),
      ).toThrow("trimInSeconds must be strictly less than trimOutSeconds");

      // Invalid speedMultiplier: negative or out of bounds (0.1 to 10.0)
      const invalidSpeed = {
        ...validVideoLayer,
        speedMultiplier: 15.0,
      };
      expect(() =>
        validateMotionProject({
          ...project,
          composition: { ...project.composition, layers: [invalidSpeed] },
        }),
      ).toThrow("invalid video speedMultiplier");
    });

    it("evaluates canvas frame renderer with video speedMultiplier and trimming", async () => {
      const { root } = await fixture();
      const baseProject = await createMotionProject(root, "Speed Multiplier Project");
      const project = {
        ...baseProject,
        composition: {
          width: 320,
          height: 240,
          fps: { numerator: 30, denominator: 1 },
          durationFrames: 60,
          background: "#000000",
          layers: [
            {
              kind: "video" as const,
              id: "v1",
              assetId: "video-" + "b".repeat(64),
              x: 0,
              y: 0,
              width: 320,
              height: 240,
              rotation: 0,
              opacity: 1,
              fill: "#000000",
              tracks: [],
              speedMultiplier: 2.0, // 2x fast-forward
              trimInSeconds: 0,
              trimOutSeconds: 2,
            },
          ],
        },
      };

      // Mock canvas frame image map
      const dummyCanvas = createCanvas(320, 240);
      const dummyImage = dummyCanvas as unknown as Image;
      const videoMap = new Map<number, Image>();
      videoMap.set(0, dummyImage);
      videoMap.set(10, dummyImage);
      videoMap.set(20, dummyImage);

      const videoFrames = new Map<string, Map<number, Image>>();
      videoFrames.set("v1", videoMap);

      const render = createMotionFrameRenderer(project, 320, 240, new Map(), videoFrames);
      const buffer = render(5);
      expect(buffer).toBeDefined();
      expect(buffer.length).toBe(320 * 240 * 4);
    });
  });

  describe("Component 3: All-in-One Deliverables Export Bundle", () => {
    it("advertises deliverablesBundleExport capability", () => {
      expect(MOTION_CAPABILITIES.deliverablesBundleExport).toBe(true);
    });

    it("generates MP4, WebM, GIF, SRT and manifest.json in an export bundle", async () => {
      const { root, request } = await fixture();
      const project = await createMotionProject(root, "Bundle Export Project");

      // Render a fast 1-second test clip (width: 320, 30 frames)
      const composition = {
        ...project.composition,
        width: 320,
        height: 240,
        durationFrames: 30,
        layers: [
          {
            kind: "text" as const,
            id: "headline",
            text: "Deliverables Bundle Test",
            fontSize: 24,
            fontFamily: "Space Grotesk",
            x: 20,
            y: 100,
            width: 280,
            height: 40,
            rotation: 0,
            opacity: 1,
            fill: "#FFFFFF",
            tracks: [],
          },
        ],
      };
      await updateMotionProject(root, project.id, 1, [{ type: "replace-composition", composition }]);

      // Render video job
      const job = await renderMotionJob(root, project.id, { width: 320 });
      expect(job.status).toBe("completed");

      // Export bundle via programmatic API
      const manifest = await exportMotionDeliverablesBundle(root, project.id);
      expect(manifest.bundleVersion).toBe(1);
      expect(manifest.projectId).toBe(project.id);
      expect(manifest.files.mp4.fileName).toBe("video.mp4");
      expect(manifest.files.mp4.bytes).toBeGreaterThan(500);
      expect(manifest.files.webm.fileName).toBe("video.webm");
      expect(manifest.files.webm.bytes).toBeGreaterThan(100);
      expect(manifest.files.gif.fileName).toBe("preview.gif");
      expect(manifest.files.gif.bytes).toBeGreaterThan(100);
      expect(manifest.files.srt.fileName).toBe("captions.srt");

      // Verify files exist on disk
      const mp4Stat = await fs.stat(manifest.files.mp4.path);
      expect(mp4Stat.isFile()).toBe(true);
      const webmStat = await fs.stat(manifest.files.webm.path);
      expect(webmStat.isFile()).toBe(true);
      const gifStat = await fs.stat(manifest.files.gif.path);
      expect(gifStat.isFile()).toBe(true);
      const srtStat = await fs.stat(manifest.files.srt.path);
      expect(srtStat.isFile()).toBe(true);

      // Verify manifest retrieval via HTTP GET
      const resGet = await request(`/api/motion/projects/${project.id}/bundle`);
      expect(resGet.status).toBe(200);
      const fetchedManifest = await resGet.json();
      expect(fetchedManifest.projectId).toBe(project.id);
      expect(fetchedManifest.files.mp4.sha256).toBe(manifest.files.mp4.sha256);

      // Verify CLI export-bundle command
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (msg: unknown) => logs.push(String(msg));
      try {
        const exitCode = await handleMotionCliCommand([
          "export-bundle",
          project.id,
          "--workspace",
          root,
          "--json",
        ]);
        expect(exitCode).toBe(0);
        const cliManifest = JSON.parse(logs[logs.length - 1]);
        expect(cliManifest.bundleVersion).toBe(1);
        expect(cliManifest.projectId).toBe(project.id);
      } finally {
        console.log = origLog;
      }
    });
  });
});
