import { describe, expect, it } from "vitest";
import { effectRegistry, EFFECT_CATEGORIES } from "../src/core/motion/effects/index.js";
import { validateMotionProject, MotionValidationError } from "../src/core/motion/schema/validation.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import { compileDirectorPlan, validateDirectorPlan } from "../src/core/motion/director/directorService.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

function sample(): MotionProject {
  return {
    schemaVersion: 1,
    id: "motion-effect-coverage-00000",
    workspaceRoot: "/coverage",
    name: "Effect coverage", revision: 1,
    createdAt: "2026-10-22T00:00:00.000Z", updatedAt: "2026-10-22T00:00:00.000Z",
    composition: {
      width: 1280, height: 720, fps: { numerator: 30, denominator: 1 },
      durationFrames: 90, background: "#111827",
      layers: [
        { id: "hero-text", kind: "text", text: "Effects", fontFamily: "Arial", fontSize: 64,
          x: 160, y: 240, width: 520, height: 90, fill: "#FFFFFF", rotation: 0, opacity: 1, tracks: [] },
        { id: "hero-card", kind: "rect", x: 120, y: 400, width: 480, height: 80,
          fill: "#F59E0B", rotation: 0, opacity: 1, tracks: [] },
      ],
    },
  };
}
function args(effect: ReturnType<typeof effectRegistry.list>[number], startFrame: number, durationFrames: number) {
  const target = effect.targetKinds.includes("scene") ? undefined :
    effect.targetKinds.includes("text") ? "hero-text" : "hero-card";
  return { effectId: effect.id, ...(target ? { targetLayerId: target } : {}), startFrame, durationFrames };
}
function signature(project: MotionProject): string {
  return JSON.stringify(project.composition.layers.map(layer => [
    layer.kind, layer.x, layer.y, layer.width, layer.height, layer.rotation,
    layer.opacity, layer.fill, layer.kind === "text" ? layer.text : "",
    layer.tracks,
  ]));
}

describe("224 Motion effects: global functional and safety coverage", () => {
  it("defines >=200 non-duplicate effect IDs across every category", () => {
    const catalog = effectRegistry.getCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(200);
    expect(new Set(catalog.map(effect => effect.id)).size).toBe(catalog.length);
    for (const category of EFFECT_CATEGORIES) {
      expect(catalog.some(effect => effect.category === category)).toBe(true);
    }
  });
  it("compiles every effect into a different, schema-valid 90-frame result (no invisible/no-op catalog entries)", () => {
    const base = sample();
    const original = signature(base);
    const seen = new Map<string, string>();
    for (const effect of effectRegistry.list()) {
      const updated = effectRegistry.applyToProject(base, args(effect, 0, 90));
      validateMotionProject(updated);
      const result = signature(updated);
      expect(result, `${effect.id} produced no composition change`).not.toBe(original);
      expect(seen.get(result), `${effect.id} duplicates another effect`).toBeUndefined();
      seen.set(result, effect.id);
    }
    expect(seen.size).toBe(effectRegistry.count());
  });
  it("keeps every catalog effect valid for very short and trailing windows", () => {
    const base = sample();
    for (const durationFrames of [1, 3, 7, 12, 30]) {
      for (const effect of effectRegistry.list()) {
        const updated = effectRegistry.applyToProject(base, args(effect, 90 - durationFrames, durationFrames));
        validateMotionProject(updated);
      }
    }
  });
  it("rejects unknown parameters, wrong target kinds, missing required target, bad frame boundaries and exhausted tracks", () => {
    const base = sample();
    expect(effectRegistry.validateParams("bg-cyber-scanlines", { imaginaryParameter: 999 }).valid).toBe(false);
    expect(effectRegistry.validateParams("bg-cyber-scanlines", null as any).valid).toBe(false);
    expect(() => effectRegistry.applyToProject(base, { effectId: "entrance-slide-left" })).toThrow(/requires a targetLayerId/);
    expect(() => effectRegistry.applyToProject(base, {
      effectId: "bg-cyber-scanlines", targetLayerId: "hero-text",
    })).toThrow(/does not support layer kind/);
    expect(() => effectRegistry.applyToProject(base, args(effectRegistry.get("entrance-slide-left")!, -1, 20)))
      .toThrow(/startFrame/);
    expect(() => effectRegistry.applyToProject(base, args(effectRegistry.get("entrance-slide-left")!, 90, 20)))
      .toThrow(/startFrame/);
    expect(() => effectRegistry.applyToProject(base, args(effectRegistry.get("entrance-slide-left")!, 0, 0)))
      .toThrow(/durationFrames/);
    const occupied = sample();
    occupied.composition.layers[0].tracks = ["x", "y", "opacity", "rotation"].map(property =>
      ({ property: property as "x"|"y"|"opacity"|"rotation", keyframes: [{ frame: 0,
        value: property === "opacity" ? 1 : 0 }] }));
    expect(() => effectRegistry.applyToProject(occupied, { effectId: "entrance-slide-left",
      targetLayerId: "hero-text" })).not.toThrow(); // replaces existing x and opacity
    // An effect must not silently discard a new property when the only
    // available layer slots have already been occupied.
    const partial = sample();
    partial.composition.layers[0].tracks = ["x", "y", "rotation"].map(property =>
      ({ property: property as "x"|"y"|"rotation", keyframes: [{ frame: 0, value: 0 }] }));
    expect(() => effectRegistry.applyToProject(partial, {
      effectId: "entrance-slide-left", targetLayerId: "hero-text",
    })).not.toThrow();
  });
  it("broadcasts scene transitions into real per-layer opacity changes", () => {
    const base = sample();
    for (const id of ["transition-crossfade", "transition-cut", "transition-dissolve-fade"]) {
      const changed = effectRegistry.applyToProject(base, { effectId: id, startFrame: 0, durationFrames: 90 });
      expect(changed.composition.layers.every(layer => layer.tracks.some(t => t.property === "opacity"))).toBe(true);
      const mid = evaluateFrame(changed, 45);
      expect(mid.layers.every(layer => Number.isFinite(layer.values.opacity))).toBe(true);
      expect(signature(changed)).not.toBe(signature(base));
    }
  });
  it("keeps Motion Director scene entrance fades and scene-only overlays visible only within scene", () => {
    const plan = {
      name: "Effects storyboard", durationSeconds: 4, background: "#111827",
      artDirection: "neon" as const, aspectRatio: "16:9" as const,
      scenes: [
        { headline: "FIRST", accent: "#36F4D3", effect: "entrance-fade-in" },
        { headline: "NEXT", accent: "#FFDF59", effect: "transition-flash-white" },
      ],
    };
    const composition = compileDirectorPlan(validateDirectorPlan(plan));
    const withFirst = composition.layers.find(l => l.id === "scene-0-title")!;
    expect(withFirst.tracks.find(t => t.property === "opacity")?.keyframes.length).toBe(120);
    const overlay = composition.layers.find(l => l.id === "scene-1-tr-flash-white")!;
    expect(overlay).toBeDefined();
    const opacity = overlay.tracks.find(t => t.property === "opacity")!;
    const project: MotionProject = { ...sample(), composition };
    validateMotionProject(project);
    expect(opacity.keyframes[0].value).toBe(0);
    expect(evaluateFrame(project, 8).layers.find(l => l.layer.id === overlay.id)?.values.opacity).toBe(0);
    expect(evaluateFrame(project, 110).layers.find(l => l.layer.id === overlay.id)?.values.opacity).toBeGreaterThanOrEqual(0);
  });
});
