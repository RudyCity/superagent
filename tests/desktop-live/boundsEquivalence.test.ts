import { describe, expect, it } from "vitest";
import { boundsEquivalentWithDpi } from "../../src/core/desktopUi/adapters/windowsPreviewWorker.js";

describe("verified capture bounds equivalence", () => {
  const physical = { x: -11, y: -11, width: 2582, height: 1550 };
  const dip = { x: -7, y: -7, width: 1721, height: 1033 };

  it("accepts exact bounds", () => {
    expect(boundsEquivalentWithDpi(physical, physical, 1)).toBe(true);
    expect(boundsEquivalentWithDpi(dip, dip, 1.5)).toBe(true);
  });

  it("accepts the same window reported in a different DPI context", () => {
    // 150% display: discovery reported physical pixels, the worker DIPs.
    expect(boundsEquivalentWithDpi(dip, physical, 1.5)).toBe(true);
    expect(boundsEquivalentWithDpi(physical, dip, 1.5)).toBe(true);
  });

  it("rejects a moved, resized or missing window", () => {
    expect(boundsEquivalentWithDpi({ ...dip, x: 200 }, physical, 1.5)).toBe(false);
    expect(boundsEquivalentWithDpi({ ...dip, width: dip.width + 80 }, physical, 1.5)).toBe(false);
    expect(boundsEquivalentWithDpi(undefined, physical, 1.5)).toBe(false);
  });

  it("falls back to exact matching for an unknown or invalid scale", () => {
    expect(boundsEquivalentWithDpi(dip, physical, undefined)).toBe(false);
    expect(boundsEquivalentWithDpi(dip, physical, 0)).toBe(false);
    expect(boundsEquivalentWithDpi(dip, dip, Number.NaN)).toBe(true);
  });
});
