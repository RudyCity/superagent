import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject, updateMotionProject, getMotionProject } from "../src/core/motion/project/projectStore.js";
import { compileMotionTypography } from "../src/core/motion/motionTypography.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { compileMotionEffectStack } from "../src/core/motion/effects/effectStack.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";

describe("safe advanced motion typography compiler", () => {
  it("supports grapheme-safe letter animation and per-word rise without editing the source", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-typography-"));
    try {
      const project = await createMotionProject(dir, "Hello 🌟 motion");
      const original = structuredClone(project.composition);
      for (const style of ["letter-reveal", "word-rise"] as const) {
        const result = compileMotionTypography(project, { targetLayerId: "title", style });
        validateMotionProject({ ...project, composition: result });
        expect(result.layers.every(layer => layer.kind === "text")).toBe(true);
        expect(result.layers.length).toBeGreaterThan(style === "word-rise" ? 1 : 5);
        expect(result).toEqual(compileMotionTypography(project, { targetLayerId: "title", style }));
        const view = evaluateFrame({ ...project, composition: result }, 24);
        expect(view.layers.length).toBe(result.layers.length);
      }
      expect(project.composition).toEqual(original);
      const saved = await updateMotionProject(dir, project.id, 1, [{
        type: "replace-composition", composition: compileMotionTypography(project, { targetLayerId: "title", style: "word-rise" }),
      }]);
      expect(saved.revision).toBe(2);
      expect((await getMotionProject(dir, project.id)).revision).toBe(2);
    } finally { await fs.rm(dir, { force: true, recursive: true }); }
  });
  it("validates bounds and safely keeps effect stack source while replacing text layer", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-typography-stack-"));
    try {
      const p = await createMotionProject(dir, "Stack typing");
      const stacked = { ...p, composition: compileMotionEffectStack(p, [{
        id: "fx-fade", effectId: "entrance-fade-in", enabled: true, targetLayerId: "title",
        durationFrames: 25,
      }]) };
      // Applied effects target original layer IDs, so removing that layer
      // cannot be done without explicitly clearing or rebasing its stack.
      expect(() => compileMotionTypography(stacked, {
        targetLayerId: "title", style: "letter-reveal",
      })).toThrow();
      expect(() => compileMotionTypography(p, { targetLayerId: "title", style: "bad" as any })).toThrow();
      expect(() => compileMotionTypography(p, { targetLayerId: "title", style: "letter-reveal", startFrame: 600 })).toThrow();
    } finally { await fs.rm(dir, { force: true, recursive: true }); }
  });
});
