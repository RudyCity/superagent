import { describe, expect, it } from "vitest";
import { scoreNearDuplicateSimilarity } from "../../src/core/selfdev/distiller.js";

describe("Selfdev near-duplicate similarity", () => {
  it("scores differently worded operationally equivalent lessons", () => {
    const score = scoreNearDuplicateSimilarity(
      "Run focused tests after changing the task lifecycle before merge",
      "Run focused tests after changing the task lifecycle code before merging",
    );
    expect(score).toBeGreaterThan(0.5);
  });

  it("refuses to flag an obvious opposite policy as a near-duplicate", () => {
    expect(scoreNearDuplicateSimilarity(
      "Always cache results when input is stable and validated",
      "Never cache results when input is stable and validated",
    )).toBe(0);
    expect(scoreNearDuplicateSimilarity(
      "Use transactions for batch inserts and updates",
      "Avoid transactions for batch inserts and updates",
    )).toBe(0);
  });
});
