import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMotionProject, updateMotionProject } from "../src/core/motion/project/projectStore.js";
import { compileMotionParticles } from "../src/core/motion/motionParticles.js";
import { compileMotionEffectStack } from "../src/core/motion/effects/effectStack.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
describe("bounded deterministic Motion CPU particle overlay", () => {
  it("adds animated safe primitives across three particle types, without changing the source", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-particles-"));
    try {
      const p = await createMotionProject(dir, "Particle field");
      const source = JSON.stringify(p.composition);
      for (const kind of ["confetti", "sparks", "snow"] as const) {
        const result = compileMotionParticles(p, { kind, count: 12 });
        expect(result.layers.filter(l => l.id.startsWith("motion-particle-"))).toHaveLength(12);
        expect(result).toEqual(compileMotionParticles(p, { kind, count: 12 }));
        validateMotionProject({ ...p, composition: result });
        expect(evaluateFrame({ ...p, composition: result }, 15).layers).toHaveLength(13);
      }
      expect(JSON.stringify(p.composition)).toEqual(source);
      const saved = await updateMotionProject(dir, p.id, 1, [{
        type: "replace-composition", composition: compileMotionParticles(p, { kind: "confetti" }),
      }]);
      expect(saved.revision).toBe(2);
      expect(compileMotionParticles(saved, { kind: "snow" }).layers
        .filter(l => l.id.startsWith("motion-particle-"))).toHaveLength(20);
    } finally { await fs.rm(dir, { force: true, recursive: true }); }
  });
  it("preserves a non-destructive effect stack and rejects invalid particle inputs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-particle-stack-"));
    try {
      const p = await createMotionProject(dir, "Particle stack");
      const stacked = { ...p, composition: compileMotionEffectStack(p, [{
        id: "fx-intro", effectId: "entrance-fade-in", enabled: true,
        targetLayerId: "title", durationFrames: 25,
      }]) };
      const result = compileMotionParticles(stacked, { kind: "sparks", count: 6 });
      expect(result.effectStack?.length).toBe(1);
      expect(result.stackBase?.layers.filter(l => l.id.startsWith("motion-particle-"))).toHaveLength(6);
      validateMotionProject({ ...stacked, composition: result });
      expect(() => compileMotionParticles(p, { kind: "fire" as any })).toThrow();
      expect(() => compileMotionParticles(p, { kind: "snow", count: 100 })).toThrow();
      expect(() => compileMotionParticles(p, { kind: "snow", color: "red" })).toThrow();
    } finally { await fs.rm(dir, { force: true, recursive: true }); }
  });
});
