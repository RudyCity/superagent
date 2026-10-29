import { describe, expect, it } from "vitest";
import {
  cliBridgeTool,
  DEFAULT_BACKGROUND_DELEGATE_TIMEOUT_MS,
  MAX_DELEGATE_TIMEOUT_MS,
} from "../src/core/tools/cliBridgeTool.js";

describe("cli_bridge delegation timeouts", () => {
  it("defaults background delegation to one hour", () => {
    expect(DEFAULT_BACKGROUND_DELEGATE_TIMEOUT_MS).toBe(3_600_000);
  });

  it("allows explicit delegations up to twelve hours", () => {
    expect(MAX_DELEGATE_TIMEOUT_MS).toBe(43_200_000);
  });

  it("documents the one-hour default and twelve-hour maximum", () => {
    const properties = (cliBridgeTool.parameters as any).properties;
    expect(properties.action.description).toContain("default 60 minutes");
    expect(properties.action.description).toContain("up to 12 hours");
    expect(properties.timeoutMs.description).toContain("3_600_000 (60 minutes)");
    expect(properties.timeoutMs.description).toContain("43200000 (12 hours)");
  });
});
