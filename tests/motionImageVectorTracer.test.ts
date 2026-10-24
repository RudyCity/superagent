import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import {
  traceImageBuffer,
  traceImageToPathLayers,
  vectorizeProjectLayer,
} from "../src/core/motion/vector/imageTracer.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { createMotionFrameRenderer } from "../src/core/motion/render/canvasFrames.js";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import { createMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { importMotionAsset } from "../src/core/motion/assets/motionAssets.js";
import { handleMotionCliCommand } from "../src/core/commands/motionCliHandler.js";
import type { MotionProject, PathLayer } from "../src/core/motion/schema/types.js";

function createCircleImage(width = 80, height = 80): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#38BDF8";
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, width / 3, 0, Math.PI * 2);
  ctx.fill();
  return canvas.toBuffer("image/png");
}

function createMultiColorImage(width = 80, height = 80): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, width, height);
  // Darker circle
  ctx.fillStyle = "#3B82F6";
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, width / 2.5, 0, Math.PI * 2);
  ctx.fill();
  // Highlight inner box
  ctx.fillStyle = "#FACC15";
  ctx.fillRect(width / 3, height / 3, width / 3, height / 3);
  return canvas.toBuffer("image/png");
}

describe("Motion Image to Vector Tracer (imageTracer)", () => {
  it("traces a raster circular image into clean SVG vector path data (silhouette mode)", async () => {
    const pngBuffer = createCircleImage(100, 100);
    const result = await traceImageBuffer(pngBuffer, {
      mode: "silhouette",
      threshold: 128,
      simplify: 1.5,
      smooth: true,
    });

    expect(result.width).toBe(100);
    expect(result.height).toBe(100);
    expect(result.paths.length).toBeGreaterThanOrEqual(1);
    expect(result.totalPoints).toBeGreaterThan(3);

    const first = result.paths[0];
    expect(first.d).toMatch(/^M\s/);
    expect(first.d).toContain("Z");
    expect(first.bounds.width).toBeGreaterThan(40);
    expect(first.bounds.height).toBeGreaterThan(40);

    expect(result.svg).toContain("<svg");
    expect(result.svg).toContain("<path");
    expect(result.svg).toContain("</svg>");
  });

  it("traces multi-tonal image into stacked vector paths (color mode)", async () => {
    const pngBuffer = createMultiColorImage(90, 90);
    const result = await traceImageBuffer(pngBuffer, {
      mode: "color",
      colorBands: 3,
      simplify: 1.0,
    });

    expect(result.paths.length).toBeGreaterThanOrEqual(2);
    expect(result.paths.some(p => p.fill && p.fill !== "none")).toBe(true);
    for (const p of result.paths) {
      expect(p.d).toMatch(/^M\s/);
    }
  });

  it("traces into outline paths with stroke line width and kinetic stroke reveal parameters", async () => {
    const pngBuffer = createCircleImage(80, 80);
    const result = await traceImageBuffer(pngBuffer, {
      mode: "outline",
      stroke: "#10B981",
      strokeWidth: 3,
    });

    expect(result.paths.length).toBeGreaterThanOrEqual(1);
    const first = result.paths[0];
    expect(first.fill).toBe("none");
    expect(first.stroke).toBe("#10B981");
    expect(first.strokeWidth).toBe(3);
  });

  it("generates validated SuperAgent Studio PathLayer instances ready for animation", async () => {
    const pngBuffer = createCircleImage(64, 64);
    const layers = await traceImageToPathLayers(pngBuffer, {
      idPrefix: "test-logo",
      x: 100,
      y: 200,
      kineticReveal: true,
      fitWidth: 128,
      fitHeight: 128,
    });

    expect(layers.length).toBeGreaterThanOrEqual(1);
    const pathLayer = layers[0];
    expect(pathLayer.kind).toBe("path");
    expect(pathLayer.id).toMatch(/^test-logo-\d+$/);
    expect(pathLayer.x).toBeGreaterThanOrEqual(100);
    expect(pathLayer.y).toBeGreaterThanOrEqual(200);
    expect(pathLayer.strokeDasharray).toBeDefined();

    const dummyProject: MotionProject = {
      schemaVersion: 1,
      id: "studio-11111111111111111111",
      workspaceRoot: "/workspace",
      name: "Vector Test",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      composition: {
        width: 1920,
        height: 1080,
        fps: { numerator: 30, denominator: 1 },
        durationFrames: 60,
        background: "#0B0F19",
        layers: [pathLayer],
      },
    };

    expect(() => validateMotionProject(dummyProject)).not.toThrow();
  });

  it("renders PathLayer seamlessly via canvas and frame SVG", async () => {
    const pathLayer: PathLayer = {
      kind: "path",
      id: "vector-shape",
      x: 100,
      y: 100,
      width: 120,
      height: 120,
      rotation: 45,
      opacity: 0.9,
      fill: "#38BDF8",
      stroke: "#FFFFFF",
      strokeWidth: 2,
      strokeDasharray: [10, 5],
      strokeDashoffset: 2,
      fillRule: "evenodd",
      d: "M 0 0 L 60 0 L 60 60 L 0 60 Z",
      tracks: [],
    };

    const project: MotionProject = {
      schemaVersion: 1,
      id: "studio-22222222222222222222",
      workspaceRoot: "/workspace",
      name: "Render Vector Test",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      composition: {
        width: 640,
        height: 360,
        fps: { numerator: 30, denominator: 1 },
        durationFrames: 30,
        background: "#0B0F19",
        layers: [pathLayer],
      },
    };

    // Canvas frame render
    const renderer = createMotionFrameRenderer(project, 320, 180);
    const frameBuffer = renderer(0);
    expect(Buffer.isBuffer(frameBuffer)).toBe(true);
    expect(frameBuffer.length).toBeGreaterThan(0);

    // Frame SVG export
    const svg = renderMotionSvg(project, 0);
    expect(svg).toContain("<path d=\"M 0 0 L 60 0 L 60 60 L 0 60 Z\"");
    expect(svg).toContain("fill=\"#38BDF8\"");
    expect(svg).toContain("stroke=\"#FFFFFF\"");
    expect(svg).toContain("stroke-width=\"2\"");
  });

  it("vectorizes an existing ImageLayer in a project replacing it with PathLayer", async () => {
    const pngBuffer = createCircleImage(60, 60);
    const initialProject: MotionProject = {
      schemaVersion: 1,
      id: "studio-33333333333333333333",
      workspaceRoot: "/workspace",
      name: "Replace Image Test",
      revision: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      composition: {
        width: 1280,
        height: 720,
        fps: { numerator: 30, denominator: 1 },
        durationFrames: 60,
        background: "#0B0F19",
        layers: [
          {
            kind: "image",
            id: "logo-raster",
            assetId: "asset-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            x: 200,
            y: 150,
            width: 100,
            height: 100,
            rotation: 0,
            opacity: 1,
            fill: "#FFFFFF",
            tracks: [],
          },
        ],
      },
    };

    const { project: vectorized, newLayers } = await vectorizeProjectLayer(
      initialProject,
      "logo-raster",
      pngBuffer,
      { mode: "silhouette" },
    );

    expect(vectorized.revision).toBe(2);
    expect(vectorized.composition.layers.some(l => l.id === "logo-raster")).toBe(false);
    expect(newLayers.length).toBeGreaterThanOrEqual(1);
    expect(vectorized.composition.layers.some(l => l.kind === "path")).toBe(true);
    expect(() => validateMotionProject(vectorized)).not.toThrow();
  });

  it("executes CLI studio trace-image and vectorize commands end-to-end", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-trace-cli-"));
    try {
      const pngBuffer = createCircleImage(50, 50);
      const imagePath = path.join(tmpDir, "logo.png");
      await fs.writeFile(imagePath, pngBuffer);

      // CLI: trace-image
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        const exitTrace = await handleMotionCliCommand([
          "trace-image",
          "--file",
          "logo.png",
          "--mode",
          "silhouette",
          "--workspace",
          tmpDir,
          "--json",
        ]);
        expect(exitTrace).toBe(0);
        const traceOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? "{}"));
        expect(traceOutput.width).toBe(50);
        expect(traceOutput.paths.length).toBeGreaterThanOrEqual(1);

        // CLI: project with image layer, then vectorize
        const asset = await importMotionAsset(tmpDir, pngBuffer);
        const project = await createMotionProject(tmpDir, "Vectorize CLI Project");
        await updateMotionProject(tmpDir, project.id, project.revision, [
          {
            type: "add-layer",
            layer: {
              kind: "image",
              id: "hero-img",
              assetId: asset.id,
              x: 100,
              y: 100,
              width: 80,
              height: 80,
              rotation: 0,
              opacity: 1,
              fill: "#FFFFFF",
              tracks: [],
            },
          },
        ]);

        const exitVec = await handleMotionCliCommand([
          "vectorize",
          project.id,
          "--layer",
          "hero-img",
          "--mode",
          "outline",
          "--workspace",
          tmpDir,
          "--json",
        ]);
        expect(exitVec).toBe(0);
        const vecOutput = JSON.parse(String(log.mock.calls.at(-1)?.[0] ?? "{}"));
        expect(vecOutput.projectId).toBe(project.id);
        expect(vecOutput.newLayers.length).toBeGreaterThanOrEqual(1);
      } finally {
        log.mockRestore();
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
