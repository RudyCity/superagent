import { describe, it, expect } from "vitest";
import { resolveProviderType, buildProviderOptions, getModelOptions, resolveTestModel } from "../src/core/loginWizardLogic.js";

describe("loginWizardLogic", () => {
  describe("resolveProviderType", () => {
    it("resolves numeric choices", () => {
      expect(resolveProviderType("1")).toBe("openrouter");
      expect(resolveProviderType("2")).toBe("openai");
      expect(resolveProviderType("3")).toBe("anthropic");
      expect(resolveProviderType("4")).toBe("custom");
    });

    it("resolves name choices case-insensitively", () => {
      expect(resolveProviderType("OpenRouter (Recommended)")).toBe("openrouter");
      expect(resolveProviderType("OPENAI")).toBe("openai");
      expect(resolveProviderType("anthropic")).toBe("anthropic");
      expect(resolveProviderType("Custom Endpoint")).toBe("custom");
    });

    it("returns null for invalid choices", () => {
      expect(resolveProviderType("5")).toBeNull();
      expect(resolveProviderType("foo")).toBeNull();
    });
  });

  describe("buildProviderOptions", () => {
    it("builds numbered options and skips providers without api keys", () => {
      const providers = [
        { id: "p1", name: "prod", provider: "openai", apiKey: "sk-123" },
        { id: "p2", name: "dev", provider: "custom", apiKey: "", baseUrl: "http://localhost:11434/v1" },
        { id: "p3", name: "legacy", provider: "openrouter", apiKey: "sk-or-abc" },
      ];
      expect(buildProviderOptions(providers)).toEqual([
        "1. prod [openai]",
        "2. legacy [openrouter]",
      ]);
    });
  });

  describe("getModelOptions", () => {
    it("returns filtered cached models for openai", () => {
      const cached = ["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "o1-preview", "whisper-1"];
      expect(getModelOptions("openai", cached)).toEqual([
        "gpt-4o",
        "gpt-4o-mini",
        "o1-preview",
      ]);
    });

    it("returns filtered cached models for anthropic", () => {
      const cached = ["claude-3-opus-20240229", "gpt-4o", "claude-3-5-sonnet-20241022"];
      expect(getModelOptions("anthropic", cached)).toEqual([
        "claude-3-opus-20240229",
        "claude-3-5-sonnet-20241022",
      ]);
    });

    it("returns fallback models when cache is empty", () => {
      expect(getModelOptions("openai", [])).toEqual(["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"]);
      expect(getModelOptions("anthropic", [])).toEqual([
        "claude-3-5-sonnet-20241022",
        "claude-3-5-haiku-20241022",
        "claude-3-opus-20240229",
      ]);
    });

    it("limits results to 50", () => {
      const cached = Array.from({ length: 60 }, (_, i) => `gpt-${i}`);
      expect(getModelOptions("openai", cached)).toHaveLength(50);
    });
  });

  describe("resolveTestModel", () => {
    it("resolves anthropic test model", () => {
      expect(resolveTestModel("anthropic", "")).toBe("claude-3-haiku-20240307");
    });

    it("resolves openrouter test model", () => {
      expect(resolveTestModel("openrouter", "https://openrouter.ai/api/v1")).toBe("openai/gpt-4o-mini");
    });

    it("defaults to openai gpt-4o-mini", () => {
      expect(resolveTestModel("openai", "")).toBe("gpt-4o-mini");
      expect(resolveTestModel("custom", "http://localhost:11434/v1")).toBe("gpt-4o-mini");
    });
  });
});
