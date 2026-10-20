import { describe, expect, it } from "vitest";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import { createMotionFrameRenderer } from "../src/core/motion/render/canvasFrames.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

const project: MotionProject = {
  schemaVersion: 1, id: "motion-aaaaaaaaaaaaaaaaaaaa", workspaceRoot: "/test",
  name: "Geometry Parity", revision: 1,
  createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z",
  composition: {
    width: 160, height: 90, fps: { numerator: 30, denominator: 1 },
    durationFrames: 30, background: "#171B28",
    layers: [
      {
        id: "background-card", kind: "rect", x: 15, y: 10, width: 90, height: 32,
        rotation: 0, opacity: 1, fill: "#4488CC",
        tracks: [{ property: "x", keyframes: [{ frame: 0, value: 15 }, { frame: 29, value: 35 }] }],
      },
      {
        id: "fade-card", kind: "rect", x: 32, y: 50, width: 40, height: 20,
        rotation: 0, opacity: 0.5, fill: "#F7D05F",
        tracks: [{ property: "opacity", keyframes: [{ frame: 0, value: 0.2 }, { frame: 29, value: 0.8 }] }],
      },
    ],
  },
};

describe("Motion SVG preview / MP4 canvas source parity", () => {
  it("uses identical geometry and color output for deterministic rectangle scenes", async () => {
    validateMotionProject(project);
    const renderRgba = createMotionFrameRenderer(project, 160, 90);
    for (const frame of [0, 14, 29]) {
      const actual = renderRgba(frame);
      const svg = renderMotionSvg(project, frame);
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
      // Platform rasterizers can differ at subpixel boundaries, but cannot drift far.
      expect(changedPixels, "frame " + frame + " pixel geometry drift").toBeLessThan(160);
      expect(worstChannelDifference, "frame " + frame + " channel drift").toBeLessThan(10);
    }
  });
});
