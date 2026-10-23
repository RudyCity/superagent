import { describe, expect, it } from "vitest";
import type { MotionDirectorPlan } from "../src/core/motion/director/directorService.js";
import { compileDirectorPlan, validateDirectorPlan } from "../src/core/motion/director/directorService.js";
import { inspectMotionQuality } from "../src/core/motion/director/motionQuality.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

const example: MotionDirectorPlan = {
  name: "QA scene presets", durationSeconds: 6, background: "#171B28", transition: "crossfade",
  motion: "slide-left",
  scenes: [
    { headline: "Launch your next idea", subtitle: "Made for creators", accent: "#FFCA32" },
    { headline: "Build with confidence", subtitle: "Available today", accent: "#0ADEE8" },
    { headline: "Start now", accent: "#FFC450" },
  ],
};
const project = (plan: MotionDirectorPlan): MotionProject => ({
  schemaVersion: 1, id: "motion-preview", workspaceRoot: "/temporary", name: plan.name, revision: 1,
  createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
  composition: compileDirectorPlan(plan),
});

describe("Phase B Motion Studio creative presets and deterministic quality lint", () => {
  it.each(["slide-left", "slide-up", "tilt", "fade"] as const)(
    "compiles and visually separates scene instances with preset %s", preset => {
      const plan = { ...example, motion: preset };
      const p = project(plan);
      expect(() => validateMotionProject(p)).not.toThrow();
      const layers = p.composition.layers.filter(item => item.id === "scene-1-title");
      expect(layers).toHaveLength(1);
      const props = layers[0].tracks.map(item => item.property);
      if (preset !== "fade") expect(props).toContain(
        preset === "slide-left" ? "x" : preset === "slide-up" ? "y" : "rotation");
      else expect(props).toEqual(["opacity"]);
      const report = inspectMotionQuality(p);
      expect(report.passed, JSON.stringify(report.issues)).toBe(true);
      expect(report.samples).toHaveLength(3);
      report.samples.forEach((sample, i) => {
        expect(sample.visibleHeadlines).toContain(plan.scenes[i].headline);
      });
    },
  );
  it("applies per-scene presets over the global preset and draws explicit overlap for crossfade", () => {
    const p = project({ ...example, motion: "slide-left",
      scenes: example.scenes.map((scene, i) => i === 1 ? { ...scene, motion: "tilt" as const } : scene),
    });
    const rotating = p.composition.layers.find(layer => layer.id === "scene-1-title")!;
    expect(rotating.tracks.some(track => track.property === "rotation")).toBe(true);
    const frame = evaluateFrame(p, 60);
    const a = frame.layers.find(item => item.layer.id === "scene-0-title")!;
    const b = frame.layers.find(item => item.layer.id === "scene-1-title")!;
    expect(a.values.opacity).toBeGreaterThan(0);
    expect(b.values.opacity).toBeGreaterThan(0);
  });
  it("cut transitions do not show future scenes early or stale scenes late", () => {
    const p = project({ ...example, transition: "cut" });
    const first = evaluateFrame(p, 0);
    const middle = evaluateFrame(p, 75);
    const last = evaluateFrame(p, 179);
    expect(first.layers.find(item => item.layer.id === "scene-0-title")?.values.opacity).toBe(1);
    expect(first.layers.find(item => item.layer.id === "scene-1-title")?.values.opacity).toBe(0);
    expect(middle.layers.find(item => item.layer.id === "scene-1-title")?.values.opacity).toBe(1);
    expect(last.layers.find(item => item.layer.id === "scene-0-title")?.values.opacity).toBe(0);
    expect(last.layers.find(item => item.layer.id === "scene-2-title")?.values.opacity).toBe(1);
  });
  it("chooses readable foreground on bright scenes and fits long titles when possible", () => {
    const p = project({ ...example, background: "#F8F9FC",
      scenes: [{ headline: "Build the future of digital customer engagement today", accent: "#212121" }],
    });
    const title = p.composition.layers.find(layer => layer.id === "scene-0-title");
    expect(title?.fill).toBe("#000000");
    expect(title?.kind === "text" ? title.fontSize : 0).toBeLessThan(78);
    expect(inspectMotionQuality(p).passed).toBe(true);
  });
  it("reports actionable issues without claiming to run vision AI", () => {
    const p = project({ ...example, scenes: [example.scenes[0]] });
    const title = p.composition.layers.find(layer => layer.id === "scene-0-title");
    if (!title || title.kind !== "text") throw new Error("fixture missing title");
    title.fill = "#171B28";
    title.text = "Long ".repeat(130);
    title.tracks = [{ property: "opacity", keyframes: [{ frame: 0, value: 0 }] }];
    const report = inspectMotionQuality(p);
    expect(report.passed).toBe(false);
    expect(report.issues.map(item => item.code)).toEqual(expect.arrayContaining([
      "title-not-visible", "low-contrast-title", "text-overflow",
    ]));
    expect(report.samples).toHaveLength(1);
  });
  it("rejects arbitrary preset/easing fields from untrusted model output", () => {
    expect(() => validateDirectorPlan({ ...example, transition: "ffmpeg-code" as any })).toThrow(/invalid|unsupported/);
    expect(() => validateDirectorPlan({ ...example, motion: "arbitrary-js" as any })).toThrow(/invalid|unsupported/);
    expect(() => validateDirectorPlan({ ...example,
      scenes: [{ ...example.scenes[0], motion: "bad" as any }] })).toThrow(/invalid|unsupported/);
  });
  it.each(["scale-pop", "zoom-in", "bounce-drop", "elastic-scale"] as const)(
    "compiles and evaluates scale preset %s with verified quality pass", preset => {
      const plan = { ...example, motion: preset };
      const p = project(plan);
      expect(() => validateMotionProject(p)).not.toThrow();
      const title = p.composition.layers.find(l => l.id === "scene-0-title")!;
      const props = title.tracks.map(t => t.property);
      if (preset === "scale-pop" || preset === "zoom-in") {
        expect(props).toContain("scale");
      } else if (preset === "bounce-drop") {
        expect(props).toContain("y");
        expect(props).toContain("scale");
      } else if (preset === "elastic-scale") {
        expect(props).toContain("scaleX");
        expect(props).toContain("scaleY");
      }
      expect(inspectMotionQuality(p).passed).toBe(true);
    },
  );
  it.each(["slide-left", "slide-right", "zoom", "wipe"] as const)(
    "compiles and executes dynamic scene transition %s cleanly", transition => {
      const plan = { ...example, transition };
      const p = project(plan);
      expect(() => validateMotionProject(p)).not.toThrow();
      expect(inspectMotionQuality(p).passed).toBe(true);
      if (transition === "wipe") {
        expect(p.composition.layers.some(l => l.id === "scene-0-wipe")).toBe(true);
      }
      const midFrame = evaluateFrame(p, 60);
      expect(midFrame.layers.length).toBeGreaterThan(0);
    },
  );
});
