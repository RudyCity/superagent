import { describe, expect, it } from "vitest";
import { effectRegistry, EFFECT_CATEGORIES } from "../src/core/motion/effects/index.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import { evaluateFrame } from "../src/core/motion/timeline/evaluateFrame.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

function createBaseProject(): MotionProject {
  return {
    schemaVersion: 1,
    id: "motion-11112222333344445555",
    workspaceRoot: "/test",
    name: "Effects Engine Test Project",
    revision: 1,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    composition: {
      width: 1920,
      height: 1080,
      fps: { numerator: 30, denominator: 1 },
      durationFrames: 60,
      background: "#111827",
      layers: [
        {
          id: "hero-text",
          kind: "text",
          text: "Antigravity Motion",
          x: 200,
          y: 400,
          width: 1520,
          height: 120,
          rotation: 0,
          opacity: 1,
          fill: "#F3F4F6",
          fontSize: 84,
          fontFamily: "Arial",
          tracks: [],
        },
      ],
    },
  };
}

describe("Motion Studio Effects Engine - Registry & Catalog", () => {
  it("registers at least 200 unique, well-formed effects", () => {
    const count = effectRegistry.count();
    expect(count).toBeGreaterThanOrEqual(200);

    const catalog = effectRegistry.getCatalog();
    expect(catalog.length).toBe(count);

    const idRegex = /^[a-z][a-z0-9-]{1,63}$/;
    const ids = new Set<string>();

    for (const item of catalog) {
      expect(item.id).toMatch(idRegex);
      expect(ids.has(item.id), `Duplicate effect ID found: ${item.id}`).toBe(false);
      ids.add(item.id);
      expect(item.name.trim().length).toBeGreaterThan(0);
      expect(item.description.trim().length).toBeGreaterThan(0);
      expect(EFFECT_CATEGORIES).toContain(item.category);
      expect(item.tags.length).toBeGreaterThanOrEqual(1);
      expect(item.targetKinds.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("covers all 7 required effect categories with functional implementations", () => {
    for (const category of EFFECT_CATEGORIES) {
      const items = effectRegistry.getCatalog({ category });
      expect(items.length, `Category ${category} should have multiple effects`).toBeGreaterThanOrEqual(20);
    }
  });

  it("supports catalog search and multi-criteria filtering", () => {
    const entranceOnly = effectRegistry.getCatalog({ category: "entrance" });
    expect(entranceOnly.every(e => e.category === "entrance")).toBe(true);

    const fadeQuery = effectRegistry.getCatalog({ query: "fade" });
    expect(fadeQuery.length).toBeGreaterThan(0);
    expect(fadeQuery.some(e => e.id.includes("fade") || e.tags.includes("fade"))).toBe(true);

    const textTargets = effectRegistry.getCatalog({ targetKind: "text" });
    expect(textTargets.length).toBeGreaterThan(50);
  });
});

describe("Motion Studio Effects Engine - Parameter Validation Strictness", () => {
  it("rejects non-numeric, below-min, and above-max numbers", () => {
    const fadeIn = "entrance-fade-in";
    const minCheck = effectRegistry.validateParams(fadeIn, { durationFrames: 1 });
    expect(minCheck.valid).toBe(false);
    expect(minCheck.errors.some(e => e.includes("below minimum"))).toBe(true);

    const maxCheck = effectRegistry.validateParams(fadeIn, { durationFrames: 999 });
    expect(maxCheck.valid).toBe(false);
    expect(maxCheck.errors.some(e => e.includes("above maximum"))).toBe(true);

    const typeCheck = effectRegistry.validateParams(fadeIn, { durationFrames: "fast" as any });
    expect(typeCheck.valid).toBe(false);
    expect(typeCheck.errors.some(e => e.includes("finite number"))).toBe(true);
  });

  it("rejects invalid hex colors and accepts valid 6-char hex colors", () => {
    const underline = "accent-kinetic-underline";
    const invalidColor = effectRegistry.validateParams(underline, { color: "blue" });
    expect(invalidColor.valid).toBe(false);
    expect(invalidColor.errors.some(e => e.includes("hex color"))).toBe(true);

    const validColor = effectRegistry.validateParams(underline, { color: "#3B82F6" });
    expect(validColor.valid).toBe(true);
    expect(validColor.sanitized.color).toBe("#3B82F6");
  });

  it("rejects disallowed enum choices", () => {
    const fadeIn = "entrance-fade-in";
    const badEnum = effectRegistry.validateParams(fadeIn, { easing: "bounce" });
    expect(badEnum.valid).toBe(false);
    expect(badEnum.errors.some(e => e.includes("not in allowed choices"))).toBe(true);

    const goodEnum = effectRegistry.validateParams(fadeIn, { easing: "linear" });
    expect(goodEnum.valid).toBe(true);
    expect(goodEnum.sanitized.easing).toBe("linear");
  });

  it("rejects unsafe string inputs with script/HTML injection chars", () => {
    const capsule = "accent-status-capsule";
    const badLabel = effectRegistry.validateParams(capsule, { label: "<script>alert(1)</script>" });
    expect(badLabel.valid).toBe(false);
    expect(badLabel.errors.some(e => e.includes("safe string"))).toBe(true);

    const goodLabel = effectRegistry.validateParams(capsule, { label: "OFFICIAL RELEASE" });
    expect(goodLabel.valid).toBe(true);
    expect(goodLabel.sanitized.label).toBe("OFFICIAL RELEASE");
  });
});

describe("Motion Studio Effects Engine - Application & Dynamic Visual Changes", () => {
  it("applies entrance effect and evaluates dynamic opacity change across frames", () => {
    const base = createBaseProject();
    const updated = effectRegistry.applyToProject(base, {
      effectId: "entrance-fade-in",
      targetLayerId: "hero-text",
      startFrame: 0,
      durationFrames: 20,
    });

    validateMotionProject(updated);
    expect(updated.composition.layers[0].tracks.length).toBeGreaterThan(0);

    const frame0 = evaluateFrame(updated, 0);
    const frame20 = evaluateFrame(updated, 20);

    const hero0 = frame0.layers.find(l => l.layer.id === "hero-text");
    const hero20 = frame20.layers.find(l => l.layer.id === "hero-text");

    expect(hero0?.values.opacity).toBeCloseTo(0, 1);
    expect(hero20?.values.opacity).toBeCloseTo(1, 1);
    expect(hero20!.values.opacity - hero0!.values.opacity).toBeGreaterThan(0.9);
  });

  it("applies exit effect and evaluates dynamic motion displacement", () => {
    const base = createBaseProject();
    const updated = effectRegistry.applyToProject(base, {
      effectId: "exit-slide-up",
      targetLayerId: "hero-text",
      startFrame: 40,
      durationFrames: 20,
      params: { offset: 120 },
    });

    validateMotionProject(updated);
    const frame40 = evaluateFrame(updated, 40);
    const frame59 = evaluateFrame(updated, 59);

    const hero40 = frame40.layers.find(l => l.layer.id === "hero-text");
    const hero59 = frame59.layers.find(l => l.layer.id === "hero-text");

    // Slide up moves Y upward (smaller Y) and reduces opacity to 0
    expect(hero59!.values.y).toBeLessThan(hero40!.values.y);
    expect(hero59!.values.opacity).toBeLessThan(hero40!.values.opacity);
  });

  it("applies kinetic typography pulse and oscillates displacement", () => {
    const base = createBaseProject();
    const updated = effectRegistry.applyToProject(base, {
      effectId: "kinetic-pulse-impact",
      targetLayerId: "hero-text",
      startFrame: 0,
      durationFrames: 30,
      params: { intensity: 24, cycleFrames: 20 },
    });

    validateMotionProject(updated);
    const frame0 = evaluateFrame(updated, 0);
    const frame5 = evaluateFrame(updated, 5);
    const frame20 = evaluateFrame(updated, 20);

    const hero0 = frame0.layers.find(l => l.layer.id === "hero-text");
    const hero5 = frame5.layers.find(l => l.layer.id === "hero-text");
    const hero20 = frame20.layers.find(l => l.layer.id === "hero-text");

    expect(hero0!.values.y).toBe(400);
    expect(hero5!.values.y).toBe(376); // shifted by intensity 24
    expect(hero20!.values.y).toBe(400); // returned to anchor
  });

  it("applies camera effects and translates all composition layers", () => {
    const base = createBaseProject();
    const updated = effectRegistry.applyToProject(base, {
      effectId: "camera-pan-right",
      startFrame: 0,
      durationFrames: 30,
      params: { distance: 150 },
    });

    validateMotionProject(updated);
    const frame0 = evaluateFrame(updated, 0);
    const frame30 = evaluateFrame(updated, 30);

    const hero0 = frame0.layers.find(l => l.layer.id === "hero-text");
    const hero30 = frame30.layers.find(l => l.layer.id === "hero-text");

    expect(Math.abs(hero30!.values.x - hero0!.values.x)).toBeGreaterThan(100);
  });

  it("prepends background effects behind existing layers", () => {
    const base = createBaseProject();
    const initialFirstLayer = base.composition.layers[0].id;

    const updated = effectRegistry.applyToProject(base, {
      effectId: "bg-cyber-scanlines",
      params: { cycleFrames: 35, beamThickness: 3 },
    });

    validateMotionProject(updated);
    // Background layers must be prepended (unshifted)
    expect(updated.composition.layers[0].id).not.toBe(initialFirstLayer);
    expect(updated.composition.layers[0].kind).toBe("rect");
    expect(updated.composition.layers[updated.composition.layers.length - 1].id).toBe(initialFirstLayer);
  });

  it("appends graphic accent layers and generates unique IDs without collision", () => {
    const base = createBaseProject();
    const updated = effectRegistry.applyToProject(base, {
      effectId: "accent-kinetic-underline",
      targetLayerId: "hero-text",
      params: { color: "#10B981", thickness: 8 },
    });

    validateMotionProject(updated);
    const underlineLayer = updated.composition.layers.find(l => l.id.includes("underline"));
    expect(underlineLayer).toBeDefined();
    expect(underlineLayer?.kind).toBe("rect");
    expect(underlineLayer?.fill).toBe("#10B981");

    // Applying another accent should not collide IDs
    const doubleAccented = effectRegistry.applyToProject(updated, {
      effectId: "accent-kinetic-underline",
      targetLayerId: "hero-text",
    });
    validateMotionProject(doubleAccented);
    const idSet = new Set(doubleAccented.composition.layers.map(l => l.id));
    expect(idSet.size).toBe(doubleAccented.composition.layers.length);
  });
});
