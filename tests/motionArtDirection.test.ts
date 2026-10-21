import { describe, expect, it } from "vitest";
import { compileDirectorPlan, validateDirectorPlan, chooseMotionArtDirection, type MotionDirectorPlan } from "../src/core/motion/director/directorService.js";
import { MOTION_ART_DIRECTIONS, MOTION_PRESETS } from "../src/core/motion/director/creativePresets.js";
import { inspectMotionQuality } from "../src/core/motion/director/motionQuality.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

const brief: MotionDirectorPlan = {
  name: "Creative directions", durationSeconds: 9, background: "#101827",
  scenes: [
    { headline: "Create something remarkable", subtitle: "Made for modern teams", accent: "#36F4D3" },
    { headline: "Bring your ideas to life", subtitle: "With motion and personality", accent: "#FFDF59" },
    { headline: "Launch it today", subtitle: "Let's make it happen", accent: "#FF6A8D" },
  ],
};
const project = (plan: MotionDirectorPlan): MotionProject => ({
  schemaVersion: 1, id: "motion-art-preview", workspaceRoot: "/temp",
  name: plan.name, revision: 1, createdAt: "2026-10-21T00:00:00Z",
  updatedAt: "2026-10-21T00:00:00Z", composition: compileDirectorPlan(plan),
});
describe("Motion Studio deliberate creative direction", () => {
  it("keeps clear Indonesian and English style instructions over model defaults", () => {
    expect(chooseMotionArtDirection("Buat iklan neon futuristik", "editorial")).toBe("neon");
    expect(chooseMotionArtDirection("Desain brutalist yang tegas", "minimal")).toBe("brutalist");
    expect(chooseMotionArtDirection("A clean minimal product video", "neon")).toBe("minimal");
    expect(chooseMotionArtDirection("Video gaya editorial majalah")).toBe("editorial");
    expect(chooseMotionArtDirection("A brand launch", undefined)).toBe("editorial");
  });
  it.each(MOTION_ART_DIRECTIONS)("renders %s as a distinct validated editable visual system", artDirection => {
    const p = project({ ...brief, artDirection });
    expect(() => validateMotionProject(p)).not.toThrow();
    const report = inspectMotionQuality(p);
    expect(report.passed, JSON.stringify(report.issues)).toBe(true);
    expect(report.samples).toHaveLength(3);
    for (const layer of p.composition.layers) {
      expect(layer.tracks.length).toBeLessThanOrEqual(4);
    }
    expect(p.composition.layers.filter(l => l.kind === "rect").length).toBeGreaterThan(3);
    expect(renderMotionSvg(p, 45)).toContain("<svg");
  });
  it.each(["16:9", "1:1", "9:16"] as const)("supports all layouts and style variants in %s", aspectRatio => {
    for (const artDirection of MOTION_ART_DIRECTIONS) {
      const p = project({ ...brief, artDirection, aspectRatio,
        scenes: brief.scenes.map((scene, i) => ({ ...scene,
          layout: (["left", "center", "right"] as const)[i] })),
      });
      expect(() => validateMotionProject(p)).not.toThrow();
      const report = inspectMotionQuality(p);
      expect(report.passed, JSON.stringify(report.issues)).toBe(true);
      expect(report.issues.filter(i => i.code === "text-overflow")).toEqual([]);
      expect(report.samples.map(s => s.visibleHeadlines)).toEqual([
        [brief.scenes[0].headline], [brief.scenes[1].headline], [brief.scenes[2].headline],
      ]);
    }
  });
  it("keeps left, center and right alignments distinct and bounded", () => {
    const p = project({ ...brief, artDirection: "editorial" as const,
      scenes: brief.scenes.map((s, i) => ({ ...s, layout: (["left","center","right"] as const)[i] })),
    });
    const xs = p.composition.layers.filter(l => /-title$/.test(l.id)).map(l => l.x);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
  });
  it.each(["slide-right", "drop-in", "swing"] as const)("uses safe %s entrance animation", motion => {
    expect(MOTION_PRESETS).toContain(motion);
    const p = project({ ...brief, scenes: [brief.scenes[0]], motion });
    expect(() => validateMotionProject(p)).not.toThrow();
    const title = p.composition.layers.find(l => l.id === "scene-0-title")!;
    const key = motion === "slide-right" ? "x" : motion === "drop-in" ? "y" : "rotation";
    expect(title.tracks.map(t => t.property)).toContain(key);
    const f0 = evaluateFrame(p, 0).layers.find(l => l.layer.id === title.id)!;
    const fm = evaluateFrame(p, 60).layers.find(l => l.layer.id === title.id)!;
    expect(f0.values[key]).not.toBe(fm.values[key]);
  });
  it("does not accept untrusted arbitrary layout or art direction", () => {
    expect(() => validateDirectorPlan({ ...brief, artDirection: "execute-js" })).toThrow();
    expect(() => validateDirectorPlan({ ...brief, scenes: [{ ...brief.scenes[0], layout: "arbitrary-css" }] })).toThrow();
    expect(() => validateDirectorPlan({ ...brief, scenes: [{ ...brief.scenes[0], colorFilter: "<script>" }] })).toThrow();
  });
  it("never constructs remote references or executable SVG instructions", () => {
    const p = project({ ...brief, artDirection: "neon",
      scenes: [{ headline: "Safe <motion> & design", subtitle: "No scripts", accent: "#00FFFF" }],
    });
    const svg = renderMotionSvg(p, 60);
    expect(svg).toContain("Safe &lt;motion&gt; &amp; design");
    expect(svg).not.toMatch(/<script|(?:href|src)="https?:\/\//i);
  });
});


