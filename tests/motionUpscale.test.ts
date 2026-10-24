import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import {
  upscaleMotionComposition,
  getAvailableUpscaleTargets,
} from "../src/core/motion/motionUpscale.js";
import { compileMotionEffectStack } from "../src/core/motion/effects/effectStack.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import type { MotionLayer } from "../src/core/motion/schema/types.js";

describe("Motion upscale suite", () => {
  it("upscales composition from 1280x720 to 1080p, 2K, and 4K UHD", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-upscale-"));
    try {
      const original = await createMotionProject(workspace, "Upscale test");
      // Add a path layer and custom tracks to test comprehensive scaling
      const pathLayer: MotionLayer = {
        id: "vector-star",
        kind: "path",
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        rotation: 0,
        opacity: 1,
        fill: "#ff0055",
        d: "M 10 10 L 90 10 L 50 90 Z",
        stroke: "#00f0ff",
        strokeWidth: 4,
        strokeDasharray: [10, 5],
        strokeDashoffset: 2,
        tracks: [
          {
            property: "x",
            keyframes: [
              { frame: 0, value: 100, easing: "easeInOut" },
              { frame: 30, value: 300, easing: "easeInOut" },
            ],
          },
          {
            property: "strokeDashoffset",
            keyframes: [
              { frame: 0, value: 2, easing: "linear" },
              { frame: 30, value: 20, easing: "linear" },
            ],
          },
          {
            property: "opacity",
            keyframes: [
              { frame: 0, value: 0, easing: "easeOut" },
              { frame: 15, value: 1, easing: "easeOut" },
            ],
          },
        ],
      };

      original.composition.layers.push(pathLayer);

      // 1. Upscale by 2x factor
      const upscaled2x = upscaleMotionComposition(original, { scale: 2 });
      expect(upscaled2x.width).toBe(original.composition.width * 2);
      expect(upscaled2x.height).toBe(original.composition.height * 2);
      expect(upscaled2x.durationFrames).toBe(original.composition.durationFrames);

      const upscaledPath = upscaled2x.layers.find(l => l.id === "vector-star") as MotionLayer & {
        strokeWidth: number;
        strokeDasharray: number[];
        strokeDashoffset: number;
      };
      expect(upscaledPath.x).toBe(200);
      expect(upscaledPath.y).toBe(200);
      expect(upscaledPath.width).toBe(400);
      expect(upscaledPath.height).toBe(400);
      expect(upscaledPath.strokeWidth).toBe(8);
      expect(upscaledPath.strokeDasharray).toEqual([20, 10]);
      expect(upscaledPath.strokeDashoffset).toBe(4);

      // Keyframes
      const xTrack = upscaledPath.tracks.find(t => t.property === "x");
      expect(xTrack?.keyframes[0].value).toBe(200);
      expect(xTrack?.keyframes[1].value).toBe(600);

      const dashTrack = upscaledPath.tracks.find(t => t.property === "strokeDashoffset");
      expect(dashTrack?.keyframes[0].value).toBe(4);
      expect(dashTrack?.keyframes[1].value).toBe(40);

      const opTrack = upscaledPath.tracks.find(t => t.property === "opacity");
      expect(opTrack?.keyframes[0].value).toBe(0);
      expect(opTrack?.keyframes[1].value).toBe(1);

      validateMotionProject({ ...original, composition: upscaled2x });

      // 2. Upscale to 4K UHD preset
      const upscaled4k = upscaleMotionComposition(original, { target: "4k" });
      expect(upscaled4k.width).toBe(3840);
      expect(upscaled4k.height).toBe(2160);
      validateMotionProject({ ...original, composition: upscaled4k });

      // 3. Upscale to 2K preset
      const upscaled2k = upscaleMotionComposition(original, { target: "2k" });
      expect(upscaled2k.width).toBe(2560);
      expect(upscaled2k.height).toBe(1440);
      validateMotionProject({ ...original, composition: upscaled2k });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves and recompiles effect stack during upscale", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-upscale-stack-"));
    try {
      const original = await createMotionProject(workspace, "Upscale stack");
      const stack = [{ id: "fx-fade", effectId: "entrance-fade-in", enabled: true, targetLayerId: "title", durationFrames: 20 }];
      const source = { ...original, composition: compileMotionEffectStack(original, stack) };

      const upscaled = upscaleMotionComposition(source, { target: "1080p" });
      expect(upscaled.effectStack).toEqual(stack);
      expect(upscaled.width).toBe(1920);
      expect(upscaled.height).toBe(1080);
      expect(upscaled.stackBase?.width).toBe(1920);
      validateMotionProject({ ...source, composition: upscaled });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it("calculates available upscale targets accurately", () => {
    const landscapeTargets = getAvailableUpscaleTargets(1280, 720);
    expect(landscapeTargets).toHaveLength(3);
    expect(landscapeTargets[0]).toMatchObject({ target: "1080p", width: 1920, height: 1080, scaleFactor: 1.5 });
    expect(landscapeTargets[1]).toMatchObject({ target: "2k", width: 2560, height: 1440, scaleFactor: 2 });
    expect(landscapeTargets[2]).toMatchObject({ target: "4k", width: 3840, height: 2160, scaleFactor: 3 });

    const squareTargets = getAvailableUpscaleTargets(1080, 1080);
    expect(squareTargets[0]).toMatchObject({ target: "1080p", width: 1080, height: 1080 });
    expect(squareTargets[1]).toMatchObject({ target: "2k", width: 1440, height: 1440 });
    expect(squareTargets[2]).toMatchObject({ target: "4k", width: 2160, height: 2160 });
  });

  it("validates boundary conditions and throws on invalid inputs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-upscale-err-"));
    try {
      const original = await createMotionProject(workspace, "Upscale error");
      expect(() => upscaleMotionComposition(original, { scale: 0.5 })).toThrow("scale factor must be between 1 and 8");
      expect(() => upscaleMotionComposition(original, { scale: 10 })).toThrow("scale factor must be between 1 and 8");
      expect(() => upscaleMotionComposition(original, { targetWidth: 100 })).toThrow("targetWidth must be an even integer between 160 and 3840");
      expect(() => upscaleMotionComposition(original, { targetWidth: 4000 })).toThrow("targetWidth must be an even integer between 160 and 3840");
      expect(() => upscaleMotionComposition(original, { targetWidth: 1921 })).toThrow("targetWidth must be an even integer between 160 and 3840");
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
