import { describe, expect, it } from "vitest";
import {
  isInformationalRequest,
  isAutoSeededSingleTask,
  MAX_TEXT_ONLY_CONTINUATIONS,
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

  it("identifies only the synthetic single-message task", () => {
    expect(isAutoSeededSingleTask("# Tasks\n\n- [/] oke ada tols motion gak?\n", "oke ada tols motion gak?")).toBe(true);
    expect(isAutoSeededSingleTask("# Tasks\r\n\r\n- [/] lanjut\r\n", "lanjut")).toBe(true);
    expect(isAutoSeededSingleTask("# Tasks\n\n- [/] fix loop\n- [ ] add tests\n", "fix loop")).toBe(false);
    expect(isAutoSeededSingleTask("# Tasks\n\n- [ ] fix loop\n", "fix loop")).toBe(false);
  });
});
