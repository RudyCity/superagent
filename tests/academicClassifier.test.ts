import { describe, it, expect } from "vitest";
import { classifyHeuristic } from "../src/core/requestClassifier.js";

describe("Request Classifier - Academic/Journal Keywords", () => {
  it("should classify Indonesian 'coba search journal' as research", () => {
    const result = classifyHeuristic("coba search journal");
    expect(result.category).toBe("research");
  });

  it("should classify academic search query as research", () => {
    const result = classifyHeuristic("search arxiv for deep learning papers");
    expect(result.category).toBe("research");
  });
});
