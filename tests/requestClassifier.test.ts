/**
 * Unit tests for requestClassifier.ts
 *
 * Tests the heuristic pre-filter accuracy, category-to-toolset mapping,
 * skip flags, edge cases, and the optimized classification pipeline.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateText } from "ai";
import {
  classifyHeuristic,
  classifyRequest,
  getToolsetForCategory,
  shouldSkipWorkspaceDiscovery,
  shouldSkipPlanInjection,
  getCategoryPromptAddendum,
  meetsThreshold,
  mapSupraTelemetryToCategory,
  warmUpClassifier,
  clearLocalClassifierCache,
  isHighConfidenceConversation,
  type RequestCategory,
  type ClassificationResult,
} from "../src/core/requestClassifier.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

export const mockClassifierPipeline = vi.fn();
vi.mock("@huggingface/transformers", () => {
  return {
    pipeline: vi.fn().mockResolvedValue((prompt: string) => mockClassifierPipeline(prompt)),
  };
});


// ─── meetsThreshold Tests ───────────────────────────────────────────────────

describe("meetsThreshold", () => {
  it("high meets high", () => {
    expect(meetsThreshold("high", "high")).toBe(true);
  });

  it("high meets medium", () => {
    expect(meetsThreshold("high", "medium")).toBe(true);
  });

  it("high meets low", () => {
    expect(meetsThreshold("high", "low")).toBe(true);
  });

  it("medium meets medium", () => {
    expect(meetsThreshold("medium", "medium")).toBe(true);
  });

  it("medium does NOT meet high", () => {
    expect(meetsThreshold("medium", "high")).toBe(false);
  });

  it("low meets low", () => {
    expect(meetsThreshold("low", "low")).toBe(true);
  });

  it("low does NOT meet medium", () => {
    expect(meetsThreshold("low", "medium")).toBe(false);
  });

  it("low does NOT meet high", () => {
    expect(meetsThreshold("low", "high")).toBe(false);
  });
});

// ─── Heuristic Classifier Tests ─────────────────────────────────────────────

describe("classifyHeuristic", () => {
  describe("conversation detection", () => {
    const conversationInputs = [
      "ok", "okay", "oke", "yes", "no", "y", "n",
      "lanjut", "lanjutkan", "proceed", "continue",
      "go ahead", "sure", "yep", "yup",
      "ongoing", "onging", "on going",
      "thanks", "thank you", "thx", "terima kasih",
      "good", "great", "nice", "cool", "awesome",
      "done", "got it", "understood", "noted",
      "hi", "hello", "hey", "halo",
      "sounds good", "that's fine", "i agree", "approved", "lgtm",
      "diskusi", "ngobrol", "diskusi aja", "cuma nanya", "cuma diskusi",
      "hanya diskusi", "kita diskusi", "mari diskusi", "mau diskusi",
      "mau ngobrol", "ngobrol aja", "cuma ngobrol"
    ];

    it.each(conversationInputs)("should classify '%s' as conversation with high confidence", (input) => {
      const result = classifyHeuristic(input);
      expect(result.category).toBe("conversation");
      expect(result.confidence).toBe("high");
      expect(result.heuristicOnly).toBe(true);
      expect(result.classificationTokens).toBe(0);
    });

    it("should classify 'OK' (uppercase) as conversation", () => {
      const result = classifyHeuristic("OK");
      expect(result.category).toBe("conversation");
      expect(result.confidence).toBe("high");
    });

    it("should classify 'let's go' as conversation", () => {
      const result = classifyHeuristic("let's go");
      expect(result.category).toBe("conversation");
    });
  });

  describe("question detection", () => {
    it("should classify 'what does getModel do?' as question with high confidence", () => {
      const result = classifyHeuristic("what does getModel do?");
      expect(result.category).toBe("question");
      expect(result.confidence).toBe("high");
    });

    it("should classify 'how does the classifier work?' as question with high confidence", () => {
      const result = classifyHeuristic("how does the classifier work?");
      expect(result.category).toBe("question");
      expect(result.confidence).toBe("high");
    });

    it("should classify 'why is this failing?' as question (not debug, because question pattern is stronger)", () => {
      const result = classifyHeuristic("why is this failing?");
      // Question starters + question mark = high confidence question
      expect(result.category).toBe("question");
    });

    it("should classify 'explain the architecture' as question with medium confidence", () => {
      const result = classifyHeuristic("explain the architecture");
      expect(result.category).toBe("question");
      expect(result.confidence).toBe("medium");
    });

    it("should classify 'where is the config file?' as question with high confidence", () => {
      const result = classifyHeuristic("where is the config file?");
      expect(result.category).toBe("question");
      expect(result.confidence).toBe("high");
    });
  });

  describe("debug detection", () => {
    it("should classify 'fix the bug in agent.ts' as debug", () => {
      const result = classifyHeuristic("fix the bug in agent.ts");
      expect(result.category).toBe("debug");
      expect(result.confidence).toBe("high");
    });

    it("should classify 'there is an error in the build' as debug", () => {
      const result = classifyHeuristic("there is an error in the build");
      expect(result.category).toBe("debug");
    });

    it("should classify 'TypeError: cannot read property of undefined' as debug", () => {
      const result = classifyHeuristic("TypeError: cannot read property of undefined");
      expect(result.category).toBe("debug");
    });

    it("should classify 'debug the failing test' as debug with high confidence", () => {
      const result = classifyHeuristic("debug the failing test");
      expect(result.category).toBe("debug");
      expect(result.confidence).toBe("high");
    });
  });

  describe("research detection", () => {
    it("should classify 'find all usages of generateText' as research", () => {
      const result = classifyHeuristic("find all usages of generateText");
      expect(result.category).toBe("research");
    });

    it("should classify 'search for simpleTask references' as research", () => {
      const result = classifyHeuristic("search for simpleTask references");
      expect(result.category).toBe("research");
    });

    it("should classify 'cari file config' as research", () => {
      const result = classifyHeuristic("cari file config");
      expect(result.category).toBe("research");
    });

    it("should classify 'explore the codebase for usage patterns' as research", () => {
      const result = classifyHeuristic("explore the codebase for usage patterns");
      expect(result.category).toBe("research");
    });

    it("should classify 'cari profile chrome' as research", () => {
      const result = classifyHeuristic("cari profile chrome");
      expect(result.category).toBe("research");
    });

    it("should include Chrome tools in research toolset", () => {
      const mockTools = [
        { name: "list_chrome_profiles" },
        { name: "get_active_browser_tabs" },
        { name: "manage_chrome_bookmarks" },
        { name: "manage_chrome_history" },
      ] as any;
      const tools = getToolsetForCategory("research", mockTools);
      const names = tools.map((t) => t.name);
      expect(names).toContain("list_chrome_profiles");
      expect(names).toContain("get_active_browser_tabs");
      expect(names).toContain("manage_chrome_bookmarks");
      expect(names).toContain("manage_chrome_history");
    });
  });

  describe("complex task detection", () => {
    it("should classify 'implement a new authentication system with OAuth2 and JWT tokens' as complex_task", () => {
      const result = classifyHeuristic("implement a new authentication system with OAuth2 and JWT tokens");
      expect(result.category).toBe("complex_task");
    });

    it("should classify 'refactor the entire module architecture to use dependency injection' as complex_task", () => {
      const result = classifyHeuristic("refactor the entire module architecture to use dependency injection");
      expect(result.category).toBe("complex_task");
    });

    it("should classify 'build a new dashboard feature with real-time data visualization' as complex_task", () => {
      const result = classifyHeuristic("build a new dashboard feature with real-time data visualization");
      expect(result.category).toBe("complex_task");
    });
  });

  describe("simple edit detection", () => {
    it("should classify 'rename the variable from foo to bar' as simple_edit", () => {
      const result = classifyHeuristic("rename the variable from foo to bar");
      expect(result.category).toBe("simple_edit");
    });

    it("should classify 'add a comment to line 50' as simple_edit", () => {
      const result = classifyHeuristic("add a comment to line 50");
      expect(result.category).toBe("simple_edit");
    });

    it("should classify 'remove the unused import' as simple_edit", () => {
      const result = classifyHeuristic("remove the unused import");
      expect(result.category).toBe("simple_edit");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string gracefully", () => {
      const result = classifyHeuristic("");
      expect(result.category).toBe("conversation");
      expect(result.confidence).toBe("high");
    });

    it("should handle whitespace-only string", () => {
      const result = classifyHeuristic("   ");
      expect(result.category).toBe("conversation");
      expect(result.confidence).toBe("high");
    });

    it("should return low confidence for ambiguous long input", () => {
      const result = classifyHeuristic("I need you to do something with the system that involves multiple considerations and careful planning");
      expect(result.confidence).not.toBe("high");
    });
  });

  describe("custom keywords", () => {
    it("should use custom conversation keywords", () => {
      const result = classifyHeuristic("ayo", { conversation: ["ayo"] });
      expect(result.category).toBe("conversation");
      expect(result.confidence).toBe("high");
    });

    it("should use custom debug keywords", () => {
      const result = classifyHeuristic("there is a glitch in the matrix with a regression", {
        debug: ["glitch", "regression"],
      });
      expect(result.category).toBe("debug");
    });
  });
});

// ─── Word Boundary Matching Tests ───────────────────────────────────────────

describe("word boundary matching (no substring false positives)", () => {
  it("should NOT match 'error' inside 'terrorist'", () => {
    const result = classifyHeuristic("the terrorist attack was reported on the news channel today");
    expect(result.category).not.toBe("debug");
  });

  it("should NOT match 'fix' inside 'prefix'", () => {
    const result = classifyHeuristic("add a prefix to the variable name");
    // Should be simple_edit (because of "add"), not debug
    expect(result.category).not.toBe("debug");
  });

  it("should NOT match 'run' inside 'brunch'", () => {
    const result = classifyHeuristic("let's discuss brunch plans");
    expect(result.category).not.toBe("command");
  });

  it("should still match exact word 'error' when standalone", () => {
    const result = classifyHeuristic("there is an error somewhere");
    expect(result.category).toBe("debug");
  });

  it("should still match exact word 'fix' when standalone", () => {
    const result = classifyHeuristic("fix the broken test case");
    expect(result.category).toBe("debug");
  });

  it("should still match exact word 'run' when standalone", () => {
    const result = classifyHeuristic("run the test suite");
    expect(result.category).toBe("command");
  });

  it("should NOT match 'find' inside 'defined'", () => {
    const result = classifyHeuristic("the type is already defined in the module interface specification");
    expect(result.category).not.toBe("research");
  });

  it("should NOT match 'scan' inside 'scandal'", () => {
    const result = classifyHeuristic("there was a scandal about it");
    expect(result.category).not.toBe("research");
  });
});

// ─── Toolset Filtering Tests ────────────────────────────────────────────────

describe("getToolsetForCategory", () => {
  const mockToolset = [
    { name: "read", description: "Read file", parameters: {} },
    { name: "write", description: "Write file", parameters: {} },
    { name: "glob", description: "Glob files", parameters: {} },
    { name: "grep", description: "Search", parameters: {} },
    { name: "bash", description: "Run command", parameters: {} },
    { name: "web_search", description: "Search web", parameters: {} },
  ] as any[];

  it("should return empty array for conversation category", () => {
    const result = getToolsetForCategory("conversation", mockToolset);
    expect(result).toHaveLength(0);
  });

  it("should return filtered read-only tools for question category", () => {
    const result = getToolsetForCategory("question", mockToolset);
    // Only read, glob, grep, web_search should be included (from the mock toolset)
    expect(result.length).toBeLessThan(mockToolset.length);
    expect(result.every(t => ["read", "glob", "grep", "web_search"].includes(t.name))).toBe(true);
  });

  it("should return filtered read-only tools for research category", () => {
    const result = getToolsetForCategory("research", mockToolset);
    expect(result.length).toBeLessThan(mockToolset.length);
    expect(result.some(t => t.name === "read")).toBe(true);
    expect(result.some(t => t.name === "write")).toBe(false);
  });

  it("should return full toolset for complex_task category", () => {
    const result = getToolsetForCategory("complex_task", mockToolset);
    expect(result).toHaveLength(mockToolset.length);
  });

  it("should return full toolset for debug category", () => {
    const result = getToolsetForCategory("debug", mockToolset);
    expect(result).toHaveLength(mockToolset.length);
  });

  it("should return full toolset for simple_edit category", () => {
    const result = getToolsetForCategory("simple_edit", mockToolset);
    expect(result).toHaveLength(mockToolset.length);
  });

  it("should return full toolset for command category", () => {
    const result = getToolsetForCategory("command", mockToolset);
    expect(result).toHaveLength(mockToolset.length);
  });
});

// ─── Skip Flag Tests ────────────────────────────────────────────────────────

describe("shouldSkipWorkspaceDiscovery", () => {
  it("should skip for conversation", () => {
    expect(shouldSkipWorkspaceDiscovery("conversation")).toBe(true);
  });

  it("should not skip for question", () => {
    expect(shouldSkipWorkspaceDiscovery("question")).toBe(false);
  });

  it("should not skip for complex_task", () => {
    expect(shouldSkipWorkspaceDiscovery("complex_task")).toBe(false);
  });

  it("should not skip for debug", () => {
    expect(shouldSkipWorkspaceDiscovery("debug")).toBe(false);
  });
});

describe("shouldSkipPlanInjection", () => {
  it("should skip for conversation", () => {
    expect(shouldSkipPlanInjection("conversation")).toBe(true);
  });

  it("should skip for question", () => {
    expect(shouldSkipPlanInjection("question")).toBe(true);
  });

  it("should not skip for complex_task", () => {
    expect(shouldSkipPlanInjection("complex_task")).toBe(false);
  });

  it("should not skip for simple_edit", () => {
    expect(shouldSkipPlanInjection("simple_edit")).toBe(false);
  });

  it("should not skip for debug", () => {
    expect(shouldSkipPlanInjection("debug")).toBe(false);
  });
});

// ─── Prompt Addendum Tests ──────────────────────────────────────────────────

describe("getCategoryPromptAddendum", () => {
  it("should return addendum for conversation", () => {
    const addendum = getCategoryPromptAddendum("conversation");
    expect(addendum).toContain("CLASSIFICATION");
    expect(addendum).toContain("conversation");
  });

  it("should return addendum for question", () => {
    const addendum = getCategoryPromptAddendum("question");
    expect(addendum).toContain("CLASSIFICATION");
    expect(addendum).toContain("question");
  });

  it("should return addendum for research", () => {
    const addendum = getCategoryPromptAddendum("research");
    expect(addendum).toContain("CLASSIFICATION");
    expect(addendum).toContain("research");
  });

  it("should return empty string for complex_task", () => {
    expect(getCategoryPromptAddendum("complex_task")).toBe("");
  });

  it("should return empty string for debug", () => {
    expect(getCategoryPromptAddendum("debug")).toBe("");
  });

  it("should return empty string for simple_edit", () => {
    expect(getCategoryPromptAddendum("simple_edit")).toBe("");
  });
});

// ─── Heuristic Enhancement Tests ──────────────────────────────────────────────

describe("classifyHeuristic Enhancements", () => {
  describe("punctuation and spacing fixes", () => {
    it("should classify 'thank you!' as conversation", () => {
      const result = classifyHeuristic("thank you!");
      expect(result.category).toBe("conversation");
      expect(result.confidence).toBe("high");
    });

    it("should classify 'terima kasih.' as conversation", () => {
      const result = classifyHeuristic("terima kasih.");
      expect(result.category).toBe("conversation");
      expect(result.confidence).toBe("high");
    });
  });

  describe("question mark hijacking fixes", () => {
    it("should classify 'fix the build error?' as debug", () => {
      const result = classifyHeuristic("fix the build error?");
      expect(result.category).toBe("debug");
      expect(result.confidence).toBe("high");
    });

    it("should classify 'run tests?' as command", () => {
      const result = classifyHeuristic("run tests?");
      expect(result.category).toBe("command");
      expect(result.confidence).toBe("high");
    });
  });

  describe("Indonesian keywords", () => {
    it("should classify 'apakah server sudah jalan?' as question", () => {
      const result = classifyHeuristic("apakah server sudah jalan?");
      expect(result.category).toBe("question");
    });

    it("should classify 'tolong temukan file config' as research", () => {
      const result = classifyHeuristic("tolong temukan file config");
      expect(result.category).toBe("research");
    });

    it("should classify 'rancang schema database baru' as complex_task", () => {
      const result = classifyHeuristic("rancang schema database baru");
      expect(result.category).toBe("complex_task");
    });

    it("should classify 'jalankan tes' as command", () => {
      const result = classifyHeuristic("jalankan tes");
      expect(result.category).toBe("command");
    });

    it("should classify 'perbaiki bug di classifier' as debug", () => {
      const result = classifyHeuristic("perbaiki bug di classifier");
      expect(result.category).toBe("debug");
    });

    it("should classify 'tolong benerin error compile' as debug", () => {
      const result = classifyHeuristic("tolong benerin error compile");
      expect(result.category).toBe("debug");
    });
  });
});

// ─── Optimized Classification Pipeline Tests ──────────────────────────────────

describe("classifyRequest (Optimized Pipeline)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLocalClassifierCache();
  });

  it("should bypass LLM and return conversation immediately for empty input", async () => {
    const mockModel = {};
    const result = await classifyRequest("", mockModel);
    expect(result.category).toBe("conversation");
    expect(result.heuristicOnly).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("should skip LLM when heuristic confidence is high (default threshold)", async () => {
    const mockModel = {};
    // "ok" is high-confidence conversation — should NOT call LLM
    const result = await classifyRequest("ok", mockModel);
    expect(result.category).toBe("conversation");
    expect(result.confidence).toBe("high");
    expect(result.heuristicOnly).toBe(true);
    expect(result.classificationTokens).toBe(0);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("should skip LLM when heuristic has high confidence for debug", async () => {
    const mockModel = {};
    // "fix the bug error" has 3 debug keywords => high confidence
    const result = await classifyRequest("fix the bug error", mockModel);
    expect(result.category).toBe("debug");
    expect(result.confidence).toBe("high");
    expect(result.heuristicOnly).toBe(true);
    expect(generateText).not.toHaveBeenCalled();
  });

  it("should call local classifier model when heuristic confidence is below threshold", async () => {
    const mockModel = {};
    mockClassifierPipeline.mockResolvedValue([
      { generated_text: "Analysis: Domain: Code | Complexity: 5 | Route: big model | Justification: Complex coding task" }
    ]);

    // Ambiguous input that heuristic returns low confidence for
    const result = await classifyRequest(
      "I need you to do something with the system that involves multiple considerations and careful planning",
      mockModel,
    );
    expect(result.heuristicOnly).toBe(false);
    expect(result.category).toBe("complex_task");
    expect(mockClassifierPipeline).toHaveBeenCalled();
  });

  it("should call local classifier when heuristic is medium and threshold is high", async () => {
    const mockModel = {};
    mockClassifierPipeline.mockResolvedValue([
      { generated_text: "Analysis: Domain: Code | Complexity: 2 | Route: small model | Justification: Small edit" }
    ]);

    // Single debug keyword => medium confidence, threshold defaults to high
    const result = await classifyRequest("there is an issue with the build", mockModel, {
      confidenceThreshold: "high",
    });
    expect(result.heuristicOnly).toBe(false);
    expect(result.category).toBe("simple_edit");
    expect(mockClassifierPipeline).toHaveBeenCalled();
  });

  it("should skip local model when heuristic is medium and threshold is medium", async () => {
    const mockModel = {};
    // Single debug keyword => medium confidence, threshold is medium => skip classifier
    const result = await classifyRequest("there is an issue with it", mockModel, {
      confidenceThreshold: "medium",
    });
    expect(result.heuristicOnly).toBe(true);
    expect(mockClassifierPipeline).not.toHaveBeenCalled();
  });

  it("should use heuristic when heuristic has low threshold but high confidence", async () => {
    const mockModel = {};
    const result = await classifyRequest("fix the compiler error", mockModel, {
      confidenceThreshold: "low",
    });
    // Heuristic returns high for "fix the compiler error" (2 debug keywords),
    // so even with low threshold it should skip classifier
    expect(result.heuristicOnly).toBe(true);
    expect(mockClassifierPipeline).not.toHaveBeenCalled();
  });

  it("should fallback to heuristic when no model is provided (e.g. skipLLM is true)", async () => {
    const result = await classifyRequest("fix the compiler error", null);
    expect(result.category).toBe("debug");
    expect(result.heuristicOnly).toBe(true);
  });

  it("should fallback to heuristic when skipLLM is true", async () => {
    const mockModel = {};
    const result = await classifyRequest("fix the compiler error", mockModel, { skipLLM: true });
    expect(result.category).toBe("debug");
    expect(result.heuristicOnly).toBe(true);
  });

  it("should fallback to heuristic on classifier model failure", async () => {
    const mockModel = {};
    mockClassifierPipeline.mockRejectedValue(new Error("Local model load failure"));

    const result = await classifyRequest(
      "I need you to consider many things about the overall approach for this system",
      mockModel,
    );
    // Should still return a result (heuristic fallback), not throw
    expect(result).toBeDefined();
    expect(result.reason).toContain("Local Classifier failed");
  });
});

describe("mapSupraTelemetryToCategory", () => {
  it("should map code: true + route: big model to complex_task", () => {
    const result = mapSupraTelemetryToCategory("Domain: Code | Complexity: 5 | Route: big model", "question");
    expect(result).toBe("complex_task");
  });

  it("should map code: true + route: big model with heuristic debug to debug", () => {
    const result = mapSupraTelemetryToCategory("Domain: Code | Complexity: 5 | Route: big model", "debug");
    expect(result).toBe("debug");
  });

  it("should map code: true + route: small model to simple_edit", () => {
    const result = mapSupraTelemetryToCategory("Domain: Code | Complexity: 2 | Route: small model", "question");
    expect(result).toBe("simple_edit");
  });

  it("should map code: true + route: small model with heuristic command to command", () => {
    const result = mapSupraTelemetryToCategory("Domain: Code | Complexity: 2 | Route: small model", "command");
    expect(result).toBe("command");
  });

  it("should map high complexity non-code to research", () => {
    const result = mapSupraTelemetryToCategory("Domain: research | Complexity: 3 | Route: big model", "question");
    expect(result).toBe("research");
  });

  it("should preserve conversation category if matched by heuristic", () => {
    const result = mapSupraTelemetryToCategory("Domain: Chat | Complexity: 1 | Route: small model", "conversation");
    expect(result).toBe("conversation");
  });

  it("should default to question for low complexity read-only queries", () => {
    const result = mapSupraTelemetryToCategory("Domain: general | Complexity: 1 | Route: small model", "question");
    expect(result).toBe("question");
  });

  it("should fall back to heuristic category on invalid/degenerated telemetry", () => {
    const result = mapSupraTelemetryToCategory("dx or dx are potential for consideration", "debug");
    expect(result).toBe("debug");
  });

  it("should preserve action-oriented categories and not downgrade them to question/research when Code is False", () => {
    const debugRes = mapSupraTelemetryToCategory("Domain: general | Complexity: 2 | Math: False | Code: False | Route: small model", "debug");
    expect(debugRes).toBe("debug");

    const editRes = mapSupraTelemetryToCategory("Domain: general | Complexity: 2 | Math: False | Code: False | Route: small model", "simple_edit");
    expect(editRes).toBe("simple_edit");

    const commandRes = mapSupraTelemetryToCategory("Domain: general | Complexity: 2 | Math: False | Code: False | Route: small model", "command");
    expect(commandRes).toBe("command");

    const complexRes = mapSupraTelemetryToCategory("Domain: general | Complexity: 2 | Math: False | Code: False | Route: small model", "complex_task");
    expect(complexRes).toBe("simple_edit");
  });
});

describe("warmUpClassifier", () => {
  it("should call pipeline pre-warmup if not disabled", async () => {
    const { pipeline } = await import("@huggingface/transformers");
    await warmUpClassifier();
    expect(pipeline).toHaveBeenCalledWith("text-generation", "Sharjeelbaig/Supra-Router-51M-ONNX", expect.any(Object));
  });
});

describe("optimizations (Jaro-Winkler, Trie, Soundex, TF-IDF)", () => {
  it("should classify phonetic variations using Soundex", () => {
    // Words phonetically close to "oke", "iya", "yes", "gas"
    const okeRes = classifyHeuristic("okayy");
    expect(okeRes.category).toBe("conversation");

    const iyaRes = classifyHeuristic("iyya");
    expect(iyaRes.category).toBe("conversation");
  });

  it("should classify typos using Jaro-Winkler similarity", () => {
    const debugRes = classifyHeuristic("compailer"); // Typo of compiler -> debug keyword
    expect(debugRes.category).toBe("debug");
  });

  it("should match conversation phrases using Trie", () => {
    const res = classifyHeuristic("oke deh lanjut");
    expect(res.category).toBe("conversation");
  });

  it("should route medium text using statistical TF-IDF classifier", () => {
    const res = classifyHeuristic("please find search locate explore check if inspect investigate scan along with other files in the workspace to see if there is any clean code");
    expect(res.category).toBe("research");
    expect(res.confidence).toBe("high");
    expect(res.reason).toContain("Statistical TF-IDF routing");
  });

  describe("Accuracy Improvements (C1-C5)", () => {
    it("should classify 'optimasi' requests as complex_task", () => {
      const res = classifyHeuristic("optimasi prompt base dan classifier");
      expect(res.category).toBe("complex_task");
    });

    it("should disambiguate question-phrased debug queries to question", () => {
      const res = classifyHeuristic("how do I fix this bug?");
      expect(res.category).toBe("question");
      expect(res.confidence).toBe("medium");
    });

    it("should guard conversation token 'gas' from technical false positives", () => {
      const res1 = classifyHeuristic("gas fees ethereum");
      expect(res1.category).not.toBe("conversation");

      const res2 = classifyHeuristic("gas");
      expect(res2.category).toBe("conversation");
    });

    it("should lower statistical classifier threshold to 2 and support dominance check", () => {
      // Input has exactly two matches for complex_task (rancang, schema)
      const res = classifyHeuristic("tolong rancang schema");
      expect(res.category).toBe("complex_task");
      expect(res.confidence).toBe("high"); // 100% dominance
    });

    it("should populate secondaryCategory when scores are close", () => {
      // Input has matches for both command (jalankan) and debug (error)
      const res = classifyHeuristic("jalankan error");
      expect(res.category).toBeDefined();
      expect(res.secondaryCategory).toBeDefined();
    });
  });
});

describe("isHighConfidenceConversation with planState", () => {
  it("should return true when planState is IDLE or undefined", () => {
    const classRes = { category: "conversation" as const, confidence: "high" as const, reason: "", heuristicOnly: true, classificationTokens: 0 };
    expect(isHighConfidenceConversation(classRes, "single", "IDLE")).toBe(true);
    expect(isHighConfidenceConversation(classRes, "single")).toBe(true);
  });

  it("should return false when planState is PLANNING_PENDING or APPROVED", () => {
    const classRes = { category: "conversation" as const, confidence: "high" as const, reason: "", heuristicOnly: true, classificationTokens: 0 };
    expect(isHighConfidenceConversation(classRes, "single", "PLANNING_PENDING")).toBe(false);
    expect(isHighConfidenceConversation(classRes, "single", "APPROVED")).toBe(false);
  });
});




