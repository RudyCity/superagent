import { describe, expect, it } from "vitest";
import { resolveModelExecutionMode } from "../src/core/config/executionMode.js";

describe("session model execution mode", () => {
  it("honors explicitly single sessions on a multi-agent shared server", () => {
    expect(resolveModelExecutionMode(true, true, false)).toBe("single");
  });
  it("honors explicitly multi sessions without any process-wide --multi flag", () => {
    expect(resolveModelExecutionMode(false, false, true)).toBe("multi");
    expect(resolveModelExecutionMode(false, true, false)).toBe("multi");
  });
  it("preserves legacy CLI behavior when no session mode was selected", () => {
    expect(resolveModelExecutionMode(undefined, true, false)).toBe("multi");
    expect(resolveModelExecutionMode(undefined, true, true)).toBe("single");
    expect(resolveModelExecutionMode(undefined, false, false)).toBe("single");
  });
});
