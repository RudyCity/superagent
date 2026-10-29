import { describe, expect, it } from "vitest";
import {
  cliBridgeTool,
  DEFAULT_BACKGROUND_DELEGATE_TIMEOUT_MS,
} from "../src/core/tools/cliBridgeTool.js";

describe("cli_bridge background delegation timeout default", () => {
  it("defaults background delegation to one hour", () => {
    expect(DEFAULT_BACKGROUND_DELEGATE_TIMEOUT_MS).toBe(3_600_000);
  });

  it("documents the same one-hour default in the public tool schema", () => {
    const properties = (cliBridgeTool.parameters as any).properties;
    expect(properties.action.description).toContain("default 60 minutes");
    expect(properties.timeoutMs.description).toContain("3_600_000 (60 minutes)");
  });
});
