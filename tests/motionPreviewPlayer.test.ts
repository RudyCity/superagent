import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderMotionPlayerHtml } from "../src/core/motion/render/motionPreviewHtml.js";
import { handleMotionHttpRoute } from "../src/core/motion/motionRoutes.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import { ensureServerAuthToken, isRequestAuthorized } from "../src/core/utils/serverSecurity.js";
import { createMotionProject, studioStorageRoot } from "../src/core/motion/project/projectStore.js";
import { MOTION_CAPABILITIES } from "../src/core/motion/motionCapabilities.js";
import type { MotionJob } from "../src/core/motion/jobs/motionJobs.js";

const cleanups: Array<() => Promise<void>> = [];

async function createTestFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "motion-preview-test-"));
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

describe("Standalone Web Browser Player & Preview", () => {
  it("advertises standaloneBrowserPlayer capability", () => {
    expect(MOTION_CAPABILITIES.standaloneBrowserPlayer).toBe(true);
  });

  it("renders self-contained offline HTML player with zero external CDN dependencies", async () => {
    const { root } = await createTestFixture();
    const project = await createMotionProject(root, "Cyberpunk Promo");

    const html = renderMotionPlayerHtml(project);

    // Basic structure
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Cyberpunk Promo — Superagent Studio Player</title>");
    expect(html).toContain(project.id);
    expect(html).toContain("Cyberpunk Promo");

    // Zero external CDN scripts or remote stylesheets
    expect(html).not.toMatch(/<script\s+src=["']http/i);
    expect(html).not.toMatch(/<link\s+[^>]*href=["']http/i);

    // Audio/video scrubber & UI components
    expect(html).toContain('id="frameSlider"');
    expect(html).toContain('id="btnPlayPause"');
    expect(html).toContain('id="btnNextFrame"');
    expect(html).toContain('id="btnPrevFrame"');
    expect(html).toContain('id="timecodeText"');
    expect(html).toContain('id="layerList"');

    // Scrubber fallback mode when artifact is not yet rendered
    expect(html).toContain("/api/motion/projects/");
    expect(html).toContain("/frames/");
  });

  it("embeds rendered MP4 artifact URL when latestJob is completed", async () => {
    const { root } = await createTestFixture();
    const project = await createMotionProject(root, "Rendered Project");

    const mockJob: MotionJob = {
      id: "studiojob-112233445566778899aabbcc",
      projectId: project.id,
      status: "completed",
      queuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      width: 1280,
      artifact: {
        path: "/path/to/rendered.mp4",
        bytes: 1048576,
      },
    };

    const html = renderMotionPlayerHtml(project, mockJob);
    expect(html).toContain("/api/motion/jobs/studiojob-112233445566778899aabbcc/artifact");
    expect(html).toContain('id="videoPlayer"');
    expect(html).toContain("Export WebM");
    expect(html).toContain("Export GIF");
  });

  it("serves HTML player via HTTP endpoint /api/motion/projects/:id/player and /preview", async () => {
    const { root, request } = await createTestFixture();
    const project = await createMotionProject(root, "HTTP Player Project");

    // Test /player route
    const resPlayer = await request(`/api/motion/projects/${project.id}/player`);
    expect(resPlayer.status).toBe(200);
    expect(resPlayer.headers.get("content-type")).toContain("text/html");
    const bodyPlayer = await resPlayer.text();
    expect(bodyPlayer).toContain("<!DOCTYPE html>");
    expect(bodyPlayer).toContain(project.id);
    expect(bodyPlayer).toContain("HTTP Player Project");

    // Test /preview alias route
    const resPreview = await request(`/api/motion/projects/${project.id}/preview`);
    expect(resPreview.status).toBe(200);
    expect(resPreview.headers.get("content-type")).toContain("text/html");
    const bodyPreview = await resPreview.text();
    expect(bodyPreview).toContain("<!DOCTYPE html>");
    expect(bodyPreview).toContain(project.id);
  });

  it("returns 404 for player endpoint if project ID is not found", async () => {
    const { request } = await createTestFixture();
    const fakeId = "motion-ffffffffffffffffffff";
    const res = await request(`/api/motion/projects/${fakeId}/player`);
    expect(res.status).toBe(404);
  });

  it("generates static preview HTML file via CLI `superagent studio preview PROJECT_ID`", async () => {
    const { root } = await createTestFixture();
    const project = await createMotionProject(root, "CLI Preview Test");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      const exitCode = await handleMotionCliCommand([
        "preview",
        project.id,
        "--workspace",
        root,
        "--json",
      ]);
      expect(exitCode).toBe(0);

      const payload = JSON.parse(logs[logs.length - 1]);
      expect(payload.status).toBe("ready");
      expect(payload.projectId).toBe(project.id);
      expect(payload.hasRenderedVideo).toBe(false);

      // Verify static HTML file was created in studioStorageRoot/previews/
      const storageRoot = await studioStorageRoot(root);
      const expectedFile = path.join(storageRoot, "previews", `preview-${project.id}.html`);
      expect(payload.previewFile).toBe(expectedFile);

      const fileStat = await fs.stat(expectedFile);
      expect(fileStat.size).toBeGreaterThan(500);

      const content = await fs.readFile(expectedFile, "utf8");
      expect(content).toContain("<!DOCTYPE html>");
      expect(content).toContain("CLI Preview Test");
    } finally {
      console.log = origLog;
    }
  });

  it("handles preview CLI command with --open flag non-fatally", async () => {
    const { root } = await createTestFixture();
    const project = await createMotionProject(root, "CLI Open Test");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => logs.push(String(msg));

    try {
      // --open flag executes without throwing (browser spawn is wrapped in non-fatal catch)
      const exitCode = await handleMotionCliCommand([
        "preview",
        project.id,
        "--workspace",
        root,
        "--open",
        "--json",
      ]);
      expect(exitCode).toBe(0);

      const payload = JSON.parse(logs[logs.length - 1]);
      expect(payload.status).toBe("ready");
      expect(payload.projectId).toBe(project.id);
    } finally {
      console.log = origLog;
    }
  });
});
