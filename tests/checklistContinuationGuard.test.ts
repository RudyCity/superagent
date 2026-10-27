import { describe, expect, it } from "vitest";
import {
  isInformationalRequest,
  isAutoSeededSingleTask,
  isTransientContinuationNudge,
  MAX_TEXT_ONLY_CONTINUATIONS,
  isNeedsInputOrLimitation,
  isRepetitiveNarration,
} from "../src/core/agent/ChecklistContinuationGuard.js";

describe("checklist continuation guard", () => {
  it.each([
    ["oke ada tols motion gak?", "command", true],
    ["ada tools motion gak", "complex_task", true],
    ["What tools are available?", "complex_task", true],
    ["bagaimana cara pakai motion studio", undefined, true],
    ["tolong perbaiki loop agent?", "question", false],
    ["can you fix the loop?", "question", false],
    ["cek codebase apakah ada bug?", "question", false],
    ["buat landing page", "complex_task", false],
    ["lanjut kerjakan semua", "conversation", false],
    ["hello", "conversation", true],
  ] as const)("classifies informational request %j (category %j)", (request, category, expected) => {
    expect(isInformationalRequest(request, category)).toBe(expected);
  });

  it("caps text-only continuations", () => {
    expect(MAX_TEXT_ONLY_CONTINUATIONS).toBeGreaterThan(0);
    expect(MAX_TEXT_ONLY_CONTINUATIONS).toBeLessThanOrEqual(3);
  });

  it("removes only turn-scoped auto-continuation prompts", () => {
    expect(isTransientContinuationNudge("system", "[SYS] Continue immediately. Use the available tools to perform the search, inspection, or actions you described and provide the result.")).toBe(true);
    expect(isTransientContinuationNudge("system", "[SYS] You have 1 unfinished task(s) remaining on the checklist:\n1. [ ] install package")).toBe(true);
    expect(isTransientContinuationNudge("user", "[SYS] Continue immediately. Use the available tools to perform the search")).toBe(false);
    expect(isTransientContinuationNudge("system", "ADVISOR WARNING: repeated tools")).toBe(false);
    expect(isTransientContinuationNudge("system", "Project update")).toBe(false);
  });

  it("identifies only the synthetic single-message task", () => {
    expect(isAutoSeededSingleTask("# Tasks\n\n- [/] oke ada tols motion gak?\n", "oke ada tols motion gak?")).toBe(true);
    expect(isAutoSeededSingleTask("# Tasks\r\n\r\n- [/] lanjut\r\n", "lanjut")).toBe(true);
    expect(isAutoSeededSingleTask("# Tasks\n\n- [/] fix loop\n- [ ] add tests\n", "fix loop")).toBe(false);
    expect(isAutoSeededSingleTask("# Tasks\n\n- [ ] fix loop\n", "fix loop")).toBe(false);
  });

  it("detects needs-input, permission, and limitation responses", () => {
    expect(isNeedsInputOrLimitation("Please provide your API key to continue.")).toBe(true);
    expect(isNeedsInputOrLimitation("Waiting for your confirmation on whether to overwrite.")).toBe(true);
    expect(isNeedsInputOrLimitation("This action requires your permission before running.")).toBe(true);
    expect(isNeedsInputOrLimitation("Cannot proceed because the target port is blocked.")).toBe(true);
    expect(isNeedsInputOrLimitation("Which option would you prefer: 1 or 2?")).toBe(true);
    expect(isNeedsInputOrLimitation("Would you like me to proceed with the deletion?")).toBe(true);
    expect(isNeedsInputOrLimitation("I will search the repository for all instances of FastPath.")).toBe(false);
    expect(isNeedsInputOrLimitation("Let me check the implementation in src/core/agent.ts.")).toBe(false);
  });

  it("detects repetitive text narration loops", () => {
    const prev = ["I will search the codebase for the file now."];
    expect(isRepetitiveNarration("I will search the codebase for the file now.", prev)).toBe(true);
    expect(isRepetitiveNarration("I found the following 3 files: a, b, c.", prev)).toBe(false);
  });
});
