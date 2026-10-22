import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { effectRegistry } from "../src/core/motion/effects/index.js";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import { createMotionFrameRenderer } from "../src/core/motion/render/canvasFrames.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { probeFfmpeg } from "../src/core/motion/render/ffmpegEncoder.js";
import { renderMotionJob } from "../src/core/motion/jobs/motionJobs.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

const fixtures: string[] = [];
async function createFixtureWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-effects-test-"));
  fixtures.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function createAspectProject(aspect: "16:9" | "1:1" | "9:16"): MotionProject {
  const dims = aspect === "16:9"
    ? { width: 1920, height: 1080 }
    : aspect === "1:1"
    ? { width: 1080, height: 1080 }
    : { width: 1080, height: 1920 };

  return {
    schemaVersion: 1,
    id: `motion-aspect-${aspect.replace(":", "-")}-0000000000`,
    workspaceRoot: "/test",
    name: `Aspect ${aspect} Project`,
    revision: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    composition: {
      width: dims.width,
      height: dims.height,
      fps: { numerator: 30, denominator: 1 },
      durationFrames: 30,
      background: "#18181B",
      layers: [
        {
          id: "card",
          kind: "rect",
          x: Math.round(dims.width * 0.1),
          y: Math.round(dims.height * 0.1),
          width: Math.round(dims.width * 0.8),
          height: Math.round(dims.height * 0.2),
          rotation: 0,
          opacity: 1,
          fill: "#2563EB",
          tracks: [],
        },
      ],
    },
  };
}

describe("Motion Studio Effects Engine - Multi-Aspect Ratio Adaptation", () => {
  const aspectRatios: Array<"16:9" | "1:1" | "9:16"> = ["16:9", "1:1", "9:16"];

  for (const aspect of aspectRatios) {
    it(`adapts background and transition effects properly to ${aspect}`, () => {
      const base = createAspectProject(aspect);
      validateMotionProject(base);

      // Apply background effect
      const withBg = effectRegistry.applyToProject(base, {
        effectId: "bg-cyber-scanlines",
        params: { cycleFrames: 35, beamThickness: 3 },
      });
      validateMotionProject(withBg);

      // Apply transition effect
      const withTransition = effectRegistry.applyToProject(withBg, {
        effectId: "transition-flash-black",
        durationFrames: 12,
        params: { dipDuration: 8 },
      });
      validateMotionProject(withTransition);

      // Verify layers span the full width and height of the specific aspect ratio
      const overlayLayer = withTransition.composition.layers.find(l => l.id.includes("dip-black"));
      expect(overlayLayer).toBeDefined();
      expect(overlayLayer?.width).toBe(base.composition.width);
      expect(overlayLayer?.height).toBe(base.composition.height);
    });
  }
});

describe("Motion Studio Effects Engine - Canvas / SVG Rendering Parity", () => {
  it("renders identical geometry and colors in Canvas RGBA and SVG previews with effects", async () => {
    const project: MotionProject = {
      schemaVersion: 1,
      id: "motion-parity-test-0000000000",
      workspaceRoot: "/test",
      name: "Effect Parity Scene",
      revision: 1,
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      composition: {
        width: 160,
        height: 90,
        fps: { numerator: 30, denominator: 1 },
        durationFrames: 20,
        background: "#0F172A",
        layers: [
          {
            id: "hero-rect",
            kind: "rect",
            x: 20,
            y: 20,
            width: 120,
            height: 50,
            rotation: 0,
            opacity: 1,
            fill: "#3B82F6",
            tracks: [],
          },
        ],
      },
    };

    // Apply entrance fade
    const withEntrance = effectRegistry.applyToProject(project, {
      effectId: "entrance-fade-in",
      targetLayerId: "hero-rect",
      startFrame: 0,
      durationFrames: 15,
    });
    validateMotionProject(withEntrance);

    const renderRgba = createMotionFrameRenderer(withEntrance, 160, 90);

    for (const frame of [0, 7, 14]) {
      const actual = renderRgba(frame);
      const svg = renderMotionSvg(withEntrance, frame);
      const image = await loadImage(Buffer.from(svg));
      const canvas = createCanvas(160, 90);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 160, 90);
      const expected = context.getImageData(0, 0, 160, 90).data;

      let changedPixels = 0;
      let worstChannelDifference = 0;
      for (let index = 0; index < expected.length; index += 4) {
        let different = false;
        for (let channel = 0; channel < 4; channel++) {
          const delta = Math.abs(expected[index + channel] - actual[index + channel]);
          worstChannelDifference = Math.max(worstChannelDifference, delta);
          if (delta > 2) different = true;
        }
        if (different) changedPixels++;
      }

      // Parity check: minimal rasterization drift at boundaries
      expect(changedPixels, `Frame ${frame} pixel drift`).toBeLessThan(160);
      expect(worstChannelDifference, `Frame ${frame} channel drift`).toBeLessThan(10);
    }
  });
});

describe("Motion Studio Effects Engine - H.264 MP4 Export", () => {
  it("renders an authentic H.264 MP4 containing composite scene effects", async () => {
    if (!(await probeFfmpeg())) {
      console.log("FFmpeg not available; skipping H264 MP4 render test.");
      return;
    }

    const ws = await createFixtureWorkspace();
    const project = await createMotionProject(ws, "MP4 Effects Demo");
    project.composition.durationFrames = 15;
    project.composition.width = 160;
    project.composition.height = 90;
    project.composition.layers[0].width = 120;
    project.composition.layers[0].height = 40;
    project.composition.layers[0].x = 20;
    project.composition.layers[0].y = 25;
    project.composition.layers[0].fontSize = 20;
    project.composition.layers[0].tracks = [];

    // Apply entrance effect
    const withEntrance = effectRegistry.applyToProject(project, {
      effectId: "entrance-fade-in",
      targetLayerId: project.composition.layers[0].id,
      startFrame: 0,
      durationFrames: 10,
    });

    // Apply kinetic pulse
    const withKinetic = effectRegistry.applyToProject(withEntrance, {
      effectId: "kinetic-pulse-impact",
      targetLayerId: project.composition.layers[0].id,
      startFrame: 0,
      durationFrames: 15,
      params: { intensity: 10, cycleFrames: 8 },
    });

    // Apply graphic accent
    const withAccent = effectRegistry.applyToProject(withKinetic, {
      effectId: "accent-kinetic-underline",
      targetLayerId: project.composition.layers[0].id,
      params: { color: "#38BDF8", thickness: 4 },
    });

    const projectFile = path.join(ws, ".superagent", "studio", "projects", project.id + ".json");
    await fs.writeFile(projectFile, JSON.stringify(withAccent, null, 2), "utf8");

    const job = await renderMotionJob(ws, project.id, { width: 160 });
    expect(job.status).toBe("completed");
    expect(job.framesCompleted).toBe(15);
    expect(job.artifact).toBeDefined();

    const videoBytes = await fs.readFile(job.artifact!.path);
    expect(videoBytes.length).toBeGreaterThan(100);
    expect(job.artifact!.sha256).toBe(crypto.createHash("sha256").update(videoBytes).digest("hex"));
  }, 45000);
});

describe("Motion Studio Effects Engine - CLI Command Integration", () => {
  it("executes effects listing, inspects effect info, and applies effect via CLI handler", async () => {
    const ws = await createFixtureWorkspace();
    const project = await createMotionProject(ws, "CLI Project");

    // 1. List effects
    const codeList = await handleMotionCliCommand(["effects", "--category", "entrance", "--json", "--workspace", ws]);
    expect(codeList).toBe(0);

    // 2. Inspect effect info
    const codeInfo = await handleMotionCliCommand(["effect-info", "entrance-fade-in", "--json", "--workspace", ws]);
    expect(codeInfo).toBe(0);

    // 3. Apply effect to project
    const codeApply = await handleMotionCliCommand([
      "apply-effect",
      project.id,
      "--base-revision",
      "1",
      "--effect",
      "accent-kinetic-underline",
      "--layer",
      project.composition.layers[0].id,
      "--params-json",
      JSON.stringify({ color: "#22C55E", thickness: 6 }),
      "--workspace",
      ws,
      "--json",
    ]);
    expect(codeApply).toBe(0);

    // 4. Verify updated project file
    const projectFile = path.join(ws, ".superagent", "studio", "projects", project.id + ".json");
    const updatedContent = JSON.parse(await fs.readFile(projectFile, "utf8"));
    expect(updatedContent.revision).toBe(2);
    expect(updatedContent.composition.layers.length).toBeGreaterThan(1);
    validateMotionProject(updatedContent);
  });
});
