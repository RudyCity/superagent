import { describe, expect, it } from "vitest";
import { buildBudgetedPromptContext, estimatePromptTokens } from "../src/core/agent/PromptContextBudget.js";

describe("buildBudgetedPromptContext", () => {
  it("keeps higher-priority context and caps the estimated token budget", () => {
    const context = buildBudgetedPromptContext([
      { id: "rules", content: "rule ".repeat(80), maxTokens: 50 },
      { id: "memory", content: "memory ".repeat(80), maxTokens: 50 },
    ], 60);

    expect(context.text).toContain("rule");
    expect(estimatePromptTokens(context.text)).toBeLessThanOrEqual(60);
    expect(context.truncatedSectionIds).toContain("memory");
  });

  it("deduplicates omitted section identifiers", () => {
    const context = buildBudgetedPromptContext([
      { id: "memory", content: "memory ".repeat(80), maxTokens: 50 },
      { id: "memory", content: "memory ".repeat(80), maxTokens: 50 },
    ], 1);

    expect(context.truncatedSectionIds).toEqual(["memory"]);
  });
});
