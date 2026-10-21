import { describe, expect, it } from "vitest";
import { applyCompoundPreset, getCompoundPreset, listCompoundPresets } from "../src/core/motion/effects/compoundPresets.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

function project(aspect: "16:9" | "1:1" | "9:16" = "16:9", durationFrames = 150): MotionProject {
  const [width, height] = aspect === "9:16" ? [720, 1280] : aspect === "1:1" ? [720, 720] : [1280, 720];
  return {
    schemaVersion: 1, id: "motion-compound-coverage-000", workspaceRoot: "/test",
    name: "Compound demo", revision: 1,
    createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
    composition: {
      width, height, background: "#111827", fps: { numerator: 30, denominator: 1 },
      durationFrames, layers: [
        { id: "compound-title", kind: "text", x: 160, y: 230, width: 420, height: 85,
          rotation: 0, opacity: 1, fill: "#FFFFFF", tracks: [], text: "Live", fontSize: 64, fontFamily: "Arial" },
        { id: "compound-bg", kind: "rect", x: 0, y: 0, width: 500, height: 40,
          rotation: 0, opacity: 1, fill: "#36F4D3", tracks: [] },
      ],
    },
  };
}
describe("Motion Studio compound presets", () => {
  it("registers 16 genuinely different three-phase visual recipes", () => {
    const presets = listCompoundPresets();
    expect(presets.length).toBe(16);
    expect(new Set(presets.map(recipe => recipe.id)).size).toBe(presets.length);
    expect(listCompoundPresets("neon")).toHaveLength(1);
    for (const p of presets) {
      expect(p.entrance.startsWith("entrance-")).toBe(true);
      expect(p.emphasis.startsWith("kinetic-")).toBe(true);
      expect(p.exit.startsWith("exit-")).toBe(true);
      expect(getCompoundPreset(p.id)).toEqual(p);
    }
  });
  it.each(["16:9", "1:1", "9:16"] as const)("compiles all presets in %s, with distinct keyframes and no collisions", aspect => {
    for (const recipe of listCompoundPresets()) {
      const original = project(aspect);
      const output = applyCompoundPreset(original, { presetId: recipe.id,
        targetLayerId: "compound-title", durationFrames: 120 });
      validateMotionProject(output);
      expect(original.composition.layers[0].tracks.length).toBe(0);
      const title = output.composition.layers.find(l => l.id === "compound-title")!;
      expect(title.tracks.length).toBeGreaterThan(0);
      expect(title.tracks.map(track => track.property).length)
        .toBe(new Set(title.tracks.map(track => track.property)).size);
      expect(title.tracks.every(track => track.keyframes.every(kf =>
        kf.frame >= 0 && kf.frame < 150))).toBe(true);
      expect(new Set(output.composition.layers.map(l => l.id)).size)
        .toBe(output.composition.layers.length);
      const beginning = evaluateFrame(output, 0).layers.find(l => l.layer.id === title.id)!;
      const middle = evaluateFrame(output, 60).layers.find(l => l.layer.id === title.id)!;
      const ending = evaluateFrame(output, 119).layers.find(l => l.layer.id === title.id)!;
      const changed = [beginning, middle, ending].some(frame =>
        frame.values.x !== title.x || frame.values.y !== title.y ||
        frame.values.opacity !== title.opacity || frame.values.rotation !== title.rotation);
      expect(changed, recipe.id + " is visually inert").toBe(true);
    }
  });
  it("merges original opacity and nonzero timeline without destroying exterior animation", () => {
    const input = project();
    input.composition.layers[0].tracks.push({ property: "x", keyframes: [
      { frame: 0, value: 130 }, { frame: 149, value: 170 },
    ] });
    const output = applyCompoundPreset(input, {
      presetId: "neon-impact", targetLayerId: "compound-title",
      startFrame: 20, durationFrames: 90, intensity: 1.4,
    });
    const before = evaluateFrame(output, 10).layers.find(l => l.layer.id === "compound-title")!;
    const after = evaluateFrame(output, 140).layers.find(l => l.layer.id === "compound-title")!;
    expect(before.values.x).toBeCloseTo(130 + 40 * (10/149), 1);
    expect(after.values.x).toBeCloseTo(130 + 40 * (140/149), 1);
    expect(output.composition.layers.length).toBeGreaterThan(input.composition.layers.length);
  });
  it("validates bad IDs, bounds, intensity, and non-text targets without mutation", () => {
    const original = project();
    const asInput = (presetId: string, targetLayerId = "compound-title") => ({ presetId, targetLayerId });
    expect(() => applyCompoundPreset(original, asInput("not-a-real-preset"))).toThrow(/Unknown compound/);
    expect(() => applyCompoundPreset(original, asInput("neon-impact", "compound-bg"))).toThrow(/text layer/);
    expect(() => applyCompoundPreset(original, { ...asInput("neon-impact"), durationFrames: 11 })).toThrow(/12-420/);
    expect(() => applyCompoundPreset(original, { ...asInput("neon-impact"), startFrame: 140, durationFrames: 30 })).toThrow(/12-420/);
    expect(() => applyCompoundPreset(original, { ...asInput("neon-impact"), intensity: 25 })).toThrow(/0.25/);
    expect(original.composition.layers[0].tracks).toEqual([]);
  });
  it("allows applying another compound preset without overwriting unique layer IDs", () => {
    const first = applyCompoundPreset(project(), {
      presetId: "editorial-reveal", targetLayerId: "compound-title", durationFrames: 65,
    });
    const second = applyCompoundPreset(first, {
      presetId: "editorial-reveal", targetLayerId: "compound-title", startFrame: 65, durationFrames: 65,
    });
    validateMotionProject(second);
    expect(new Set(second.composition.layers.map(layer => layer.id)).size).toBe(second.composition.layers.length);
  });
});
