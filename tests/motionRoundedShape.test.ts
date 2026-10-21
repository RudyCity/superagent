import { describe, expect, it } from "vitest";
import { createMotionFrameRenderer } from "../src/core/motion/render/canvasFrames.js";
import { renderMotionSvg } from "../src/core/motion/runtime/frameSvg.js";
import { validateMotionProject } from "../src/core/motion/schema/validation.js";
import type { MotionProject } from "../src/core/motion/schema/types.js";

function project(radius: number): MotionProject {
  return {
    schemaVersion: 1, id: "motion-round-preview", name: "Rounded shape", workspaceRoot: "/workspace",
    revision: 1, createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
    composition: {
      width: 200, height: 160, fps: { numerator: 30, denominator: 1 },
      durationFrames: 30, background: "#000000",
      layers: [{ kind: "rect", id: "rounded-card", x: 40, y: 30, width: 100, height: 80,
        rotation: 0, opacity: 1, fill: "#FF0000", tracks: [], cornerRadius: radius }],
    },
  };
}
describe("Motion engine rounded rectangle parity", () => {
  it("keeps safe corner radius in schema, SVG preview and real canvas export", () => {
    const scene = project(30);
    expect(() => validateMotionProject(scene)).not.toThrow();
    const svg = renderMotionSvg(scene, 0);
    expect(svg).toContain('rx="30"');
    const rgba = createMotionFrameRenderer(scene, 200, 160)(0);
    const pixel = (x: number, y: number) => [...rgba.subarray((y * 200 + x) * 4, (y * 200 + x) * 4 + 3)];
    expect(pixel(41, 31)).toEqual([0, 0, 0]);
    expect(pixel(90, 70)).toEqual([255, 0, 0]);
    expect(pixel(41, 70)).toEqual([255, 0, 0]);
  });
  it("rejects out-of-bounds and unsupported shape fields", () => {
    const bad = project(50);
    expect(() => validateMotionProject(bad)).toThrow(/cornerRadius/);
    const invalid = project(20);
    (invalid.composition.layers[0] as any).userScript = "alert(1)";
    expect(() => validateMotionProject(invalid)).toThrow(/unsupported field/);
  });
});
