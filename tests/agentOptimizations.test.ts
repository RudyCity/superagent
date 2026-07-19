import { describe, it, expect } from "vitest";
import { CriticAgent } from "../src/core/agent/criticAgent.js";
import { ContextGraph } from "../src/core/context/ContextGraph.js";
import { PromptOptimizer } from "../src/core/agent/promptOptimizer.js";

describe("agentOptimizations", () => {
  describe("CriticAgent", () => {
    it("should reject changes with git conflict markers", async () => {
      const critic = new CriticAgent(null);
      const res = await critic.reviewChanges(
        process.cwd(),
        "<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> feature",
        "",
        ""
      );
      expect(res.valid).toBe(false);
      expect(res.errors).toContain("Leftover git conflict markers detected in code changes.");
    });

    it("should reject changes on build failures", async () => {
      const critic = new CriticAgent(null);
      const res = await critic.reviewChanges(
        process.cwd(),
        "const a = 1;",
        "",
        "Error TS2304: Cannot find name 'a'."
      );
      expect(res.valid).toBe(false);
      expect(res.errors[0]).toContain("Compilation failed");
    });

    it("should reject changes on test failures", async () => {
      const critic = new CriticAgent(null);
      const res = await critic.reviewChanges(
        process.cwd(),
        "const a = 1;",
        "Tests failed: 1 failed, 10 passed",
        ""
      );
      expect(res.valid).toBe(false);
      expect(res.errors).toContain("Unit tests failed.");
    });
  });

  describe("ContextGraph", () => {
    it("should build component structure and compile summary", async () => {
      const graph = new ContextGraph(process.cwd());
      await graph.buildGraph(["package.json"], ["Verify package.json versions"]);
      const summary = graph.compileSummary();
      expect(summary).toContain("ACTIVE WORKSPACE CONTEXT GRAPH");
      expect(summary).toContain("package.json");
    });
  });

  describe("PromptOptimizer", () => {
    it("should load optimized guidelines as empty if file not exists", () => {
      const guidelines = PromptOptimizer.loadOptimizedGuidelines("unregistered-type");
      expect(guidelines).toBe("");
    });
  });
});
