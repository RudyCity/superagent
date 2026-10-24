import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { resizeMotionComposition } from "../src/core/motion/motionResize.js";
import { compileMotionEffectStack } from "../src/core/motion/effects/effectStack.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";

describe("Motion smart resize", () => {
  it("reframes source keyframes to 9:16 and 1:1 with preserved timing", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-resize-"));
    try {
      const original = await createMotionProject(workspace, "Resize test");
      const portrait = resizeMotionComposition(original, "9:16");
      expect([portrait.width, portrait.height]).toEqual([720, 1280]);
      expect(portrait.durationFrames).toBe(original.composition.durationFrames);
      expect(portrait.layers[0].tracks[0].keyframes.map(k => k.frame))
        .toEqual(original.composition.layers[0].tracks[0].keyframes.map(k => k.frame));
      validateMotionProject({ ...original, composition: portrait });
      const square = resizeMotionComposition(original, "1:1");
      expect([square.width, square.height]).toEqual([1080, 1080]);
      expect(() => resizeMotionComposition(original, "16:9", 191)).toThrow();
      expect(() => resizeMotionComposition(original, "9:16", 3840)).toThrow();
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });
  it("preserves an editable effect stack and recompiles from resized source", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "motion-resize-stack-"));
    try {
      const original = await createMotionProject(workspace, "Resize stack");
      const stack = [{ id: "fx-intro", effectId: "entrance-fade-in", enabled: true, targetLayerId: "title", durationFrames: 25 }];
      const source = { ...original, composition: compileMotionEffectStack(original, stack) };
      const resized = resizeMotionComposition(source, "9:16");
      expect(resized.effectStack).toEqual(stack);
      expect(resized.stackBase?.width).toBe(720);
      validateMotionProject({ ...source, composition: resized });
      expect(source.composition.width).toBe(1920);
    } finally { await fs.rm(workspace, { recursive: true, force: true }); }
  });
});
