import { describe, expect, it } from "vitest";
import { MOTION_CAPABILITIES } from "../src/core/motion/motionCapabilities.js";
import { listMotionTemplates } from "../src/core/motion/motionTemplates.js";

describe("SuperAgent Studio first-party display identity", () => {
  it("advertises a provisional name and native-only template policy", () => {
    expect(MOTION_CAPABILITIES.productDisplayName).toBe("SuperAgent Studio");
    expect(MOTION_CAPABILITIES.templateSourcePolicy).toBe("superagent-authored-only");
    expect(MOTION_CAPABILITIES.externalMotionTemplateImport).toBe(false);
    expect(MOTION_CAPABILITIES.schemaVersion).toBe(1);
  });
  it("serves the original native catalog with explicit first-party provenance", () => {
    const templates = listMotionTemplates();
    expect(templates).toHaveLength(6);
    expect(templates.every(template => template.origin === "superagent-original")).toBe(true);
    expect(new Set(templates.map(template => template.id)).size).toBe(templates.length);
  });
});
