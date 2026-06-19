import { describe, it, expect } from "vitest";
import {
  resolveProviderType,
  buildProviderOptions,
  getModelOptions,
  resolveTestModel,
  getFallbackModels,
} from "../src/core/loginWizardLogic";

describe("loginWizardLogic — pure helper functions", () => {
  describe("resolveProviderType", () => {
    it("should resolve openrouter from number or text", () => {
      expect(resolveProviderType("1")).toBe("openrouter");
      expect(resolveProviderType("OpenRouter")).toBe("openrouter");
      expect(resolveProviderType("openrouter (recommended)")).toBe("openrouter");
    });

    it("should resolve openai from number or text", () => {
      expect(resolveProviderType("2")).toBe("openai");
      expect(resolveProviderType("OpenAI")).toBe("openai");
    });

    it("should resolve anthropic from number or text", () => {
      expect(resolveProviderType("3")).toBe("anthropic");
      expect(resolveProviderType("Anthropic")).toBe("anthropic");
    });

    it("should resolve custom from number or text", () => {
      expect(resolveProviderType("4")).toBe("custom");
      expect(resolveProviderType("Custom Endpoint")).toBe("custom");
    });

    it("should return null for invalid input", () => {
      expect(resolveProviderType("invalid")).toBeNull();
      expect(resolveProviderType("5")).toBeNull();
    });
  });

  describe("buildProviderOptions", () => {
    it("should filter out providers without apiKey", () => {
      const providers = [
        { id: "p1", name: "P1", provider: "openai", apiKey: "sk-123", baseUrl: undefined, isActive: false },
        { id: "p2", name: "P2", provider: "anthropic", apiKey: "", baseUrl: undefined, isActive: false },
        { id: "p3", name: "P3", provider: "custom", apiKey: "sk-456", baseUrl: "http://localhost:8080/v1", isActive: true },
      ];
      const options = buildProviderOptions(providers);
      expect(options).toHaveLength(2);
      expect(options[0]).toContain("P1");
      expect(options[1]).toContain("P3");
      expect(options[1]).toContain("http://localhost:8080/v1");
    });

    it("should return empty array when no providers have keys", () => {
      const providers = [
        { id: "p1", name: "P1", provider: "openai", apiKey: "", baseUrl: undefined, isActive: false },
      ];
      expect(buildProviderOptions(providers)).toHaveLength(0);
    });
  });

  describe("resolveTestModel", () => {
    it("should return claude model for anthropic", () => {
      expect(resolveTestModel("anthropic", "")).toBe("claude-3-haiku-20240307");
    });

    it("should return openrouter model for openrouter", () => {
      expect(resolveTestModel("openrouter", "")).toBe("openai/gpt-4o-mini");
    });

    it("should return openrouter model when baseUrl contains openrouter.ai", () => {
      expect(resolveTestModel("custom", "https://openrouter.ai/api/v1")).toBe("openai/gpt-4o-mini");
    });

    it("should return gpt-4o-mini for openai", () => {
      expect(resolveTestModel("openai", "")).toBe("gpt-4o-mini");
    });

    it("should return gpt-4o-mini for custom provider with non-openrouter URL", () => {
      expect(resolveTestModel("custom", "http://localhost:8080/v1")).toBe("gpt-4o-mini");
    });

    it("should return gpt-4o-mini for custom provider with empty URL", () => {
      expect(resolveTestModel("custom", "")).toBe("gpt-4o-mini");
    });
  });

  describe("getModelOptions", () => {
    it("should return cached models when available", () => {
      const cached = ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"];
      const result = getModelOptions("openai", cached);
      expect(result).toEqual(cached);
    });

    it("should fall back to default models when cache is empty", () => {
      const result = getModelOptions("openai", []);
      expect(result).toEqual(getFallbackModels("openai"));
    });

    it("should filter anthropic models when provider is anthropic", () => {
      const cached = ["gpt-4o", "claude-3-5-sonnet-20241022", "gpt-4o-mini"];
      const result = getModelOptions("anthropic", cached);
      expect(result).toEqual(["claude-3-5-sonnet-20241022"]);
    });

    it("should filter openai models when provider is openai", () => {
      const cached = ["claude-3-5-sonnet", "gpt-4o", "gpt-4o-mini"];
      const result = getModelOptions("openai", cached);
      expect(result).toEqual(["gpt-4o", "gpt-4o-mini"]);
    });

    it("should not filter models for custom provider", () => {
      const cached = ["llama-3", "mistral-7b", "codellama"];
      const result = getModelOptions("custom", cached);
      expect(result).toEqual(cached);
    });

    it("should limit results to 15 models", () => {
      const cached = Array.from({ length: 20 }, (_, i) => `model-${i}`);
      const result = getModelOptions("custom", cached);
      expect(result).toHaveLength(15);
    });

    it("should use fallback when filtered list is empty for anthropic", () => {
      const cached = ["gpt-4o", "gpt-4o-mini"]; // no claude models
      const result = getModelOptions("anthropic", cached);
      expect(result).toEqual(getFallbackModels("anthropic"));
    });
  });

  describe("getFallbackModels", () => {
    it("should return claude models for anthropic", () => {
      const models = getFallbackModels("anthropic");
      expect(models.every((m) => m.includes("claude"))).toBe(true);
    });

    it("should return gpt models for openai", () => {
      const models = getFallbackModels("openai");
      expect(models.every((m) => m.startsWith("gpt-"))).toBe(true);
    });

    it("should return default models for custom/openrouter", () => {
      const models = getFallbackModels("custom" as any);
      expect(models).toHaveLength(2);
    });
  });
});

describe("Connection test step 7 — skipTest logic", () => {
  // Simulates the skipTest logic from step 7
  function isSkipTest(value: string): boolean {
    const choice = value.toLowerCase();
    return choice.includes("tidak") || choice.includes("no") || choice === "2" || choice.startsWith("2.");
  }

  it("should skip test when user selects '2. No'", () => {
    expect(isSkipTest("2. No")).toBe(true);
  });

  it("should skip test when user types 'no'", () => {
    expect(isSkipTest("no")).toBe(true);
  });

  it("should skip test when user types 'tidak'", () => {
    expect(isSkipTest("Tidak")).toBe(true);
  });

  it("should skip test when user types '2'", () => {
    expect(isSkipTest("2")).toBe(true);
  });

  it("should NOT skip test when user selects '1. Yes, Test Connection'", () => {
    expect(isSkipTest("1. Yes, Test Connection")).toBe(false);
  });

  it("should NOT skip test when user types 'yes'", () => {
    expect(isSkipTest("yes")).toBe(false);
  });

  it("should NOT skip test when user types '1'", () => {
    expect(isSkipTest("1")).toBe(false);
  });
});
