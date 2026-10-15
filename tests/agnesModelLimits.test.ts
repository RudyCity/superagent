import { describe, it, expect } from "vitest";
import { getStaticModelLimit } from "../src/core/model_limits.js";
import { getContextWindowLimit } from "../src/core/config/models.js";

describe("Agnes AI Model Limits", () => {
  it("resolves static limits correctly for known Agnes models", () => {
    expect(getStaticModelLimit("agnes-3.0-flash")).toBe(524288);
    expect(getStaticModelLimit("agnes/agnes-3.0-flash")).toBe(524288);
    expect(getStaticModelLimit("agnes-3.0-pro")).toBe(1048576);
    expect(getStaticModelLimit("agnes/agnes-3.0-pro")).toBe(1048576);
    expect(getStaticModelLimit("agnes-2.5-flash")).toBe(524288);
    expect(getStaticModelLimit("agnes-2.5-pro")).toBe(1048576);
    expect(getStaticModelLimit("agnes-2.0-flash")).toBe(262144);
    expect(getStaticModelLimit("agnes-1.5-flash")).toBe(262144);
  });

  it("handles substring fallback for custom or prefixed Agnes models", () => {
    expect(getStaticModelLimit("gateway@agnes-3.0-flash")).toBe(524288);
    expect(getStaticModelLimit("custom-agnes-pro-preview")).toBe(1048576);
    expect(getStaticModelLimit("experimental-agnes-v2")).toBe(524288);
  });

  it("returns 512K context window limit through getContextWindowLimit for agnes-3.0-flash", () => {
    const limit = getContextWindowLimit("agnes-3.0-flash");
    expect(limit).toBe(524288);
  });

  it("returns 1M context window limit through getContextWindowLimit for agnes-3.0-pro", () => {
    const limit = getContextWindowLimit("agnes-3.0-pro");
    expect(limit).toBe(1048576);
  });
});
