import { describe, expect, it } from "vitest";
import { createMotionProject } from "../src/core/motion/project/projectStore.js";
import { compileMotionEffectStack, changeMotionEffectStack } from "../src/core/motion/effects/effectStack.js";
import { applyMotionEdits, MotionRevisionConflict } from "../src/core/motion/project/revisions.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import type { MotionStackEntry, MotionProject } from "../src/core/motion/schema/types.js";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";

async function makeProject(): Promise<{ project: MotionProject; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "motion-stack-"));
  return { project: await createMotionProject(dir, "Stack test"), dir };
}
const fade = (id: string): MotionStackEntry => ({
  id, effectId: "entrance-fade-in", enabled: true, targetLayerId: "title", durationFrames: 50,
});
const slide = (id: string): MotionStackEntry => ({
  id, effectId: "entrance-slide-left", enabled: true, targetLayerId: "title", durationFrames: 50,
});

describe("non-destructive Motion effect stack", () => {
  it("keeps source tracks, disables and removes without losing the original animation", async () => {
    const { project, dir } = await makeProject();
    try {
      const baseline = structuredClone(project.composition);
      const added = changeMotionEffectStack(project, { type: "add", entry: slide("intro") });
      expect(added.effectStack).toHaveLength(1);
      expect(added.stackBase).toEqual(baseline);
      expect(added.layers[0].tracks).not.toEqual(baseline.layers[0].tracks);
      validateMotionProject({ ...project, composition: added });
      const withEffect = { ...project, composition: added };
      const disabled = changeMotionEffectStack(withEffect, { type: "toggle", id: "intro", enabled: false });
      expect(disabled.layers[0].tracks).toEqual(baseline.layers[0].tracks);
      expect(disabled.effectStack?.[0].enabled).toBe(false);
      const removed = changeMotionEffectStack({ ...project, composition: disabled }, { type: "remove", id: "intro" });
      expect(removed.layers).toEqual(baseline.layers);
      expect(removed.stackBase).toEqual(baseline);
      expect(project.composition).toEqual(baseline);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("supports reorder, update and rejects invalid ids/indices", async () => {
    const { project, dir } = await makeProject();
    try {
      const first = changeMotionEffectStack(project, { type: "add", entry: fade("fade") });
      const second = changeMotionEffectStack({ ...project, composition: first }, { type: "add", entry: slide("slide") });
      expect(second.effectStack?.map(item => item.id)).toEqual(["fade", "slide"]);
      const moved = changeMotionEffectStack({ ...project, composition: second }, { type: "move", id: "slide", toIndex: 0 });
      expect(moved.effectStack?.map(item => item.id)).toEqual(["slide", "fade"]);
      const adjusted = changeMotionEffectStack({ ...project, composition: moved }, { type: "update", id: "slide", changes: { durationFrames: 25 } });
      expect(adjusted.effectStack?.[0].durationFrames).toBe(25);
      expect(() => changeMotionEffectStack({ ...project, composition: adjusted }, { type: "move", id: "slide", toIndex: 10 })).toThrow();
      expect(() => changeMotionEffectStack({ ...project, composition: adjusted }, { type: "add", entry: fade("slide") })).toThrow();
      expect(() => changeMotionEffectStack({ ...project, composition: adjusted }, { type: "update", id: "slide", changes: { id: "takeover" } as any })).toThrow();
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
  it("rebases manual layer edits onto source before recompiling and respects optimistic revisions", async () => {
    const { project, dir } = await makeProject();
    try {
      const stacked = { ...project, composition: compileMotionEffectStack(project, [slide("intro")]) };
      const edited = applyMotionEdits(stacked, 1, [{ type: "set-text", layerId: "title", text: "A fresh headline" }]);
      expect(edited.revision).toBe(2);
      expect(edited.composition.stackBase?.layers[0].kind).toBe("text");
      expect((edited.composition.stackBase?.layers[0] as { text: string }).text).toBe("A fresh headline");
      expect((edited.composition.layers[0] as { text: string }).text).toBe("A fresh headline");
      const restored = applyMotionEdits(edited, 2, [{
        type: "replace-composition", composition: structuredClone(project.composition),
      }]);
      expect(restored.composition.effectStack).toBeUndefined();
      expect(restored.revision).toBe(3);
      expect(() => applyMotionEdits(stacked, 888, [{ type: "set-text", layerId: "title", text: "nope" }]))
        .toThrow(MotionRevisionConflict);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  });
});
