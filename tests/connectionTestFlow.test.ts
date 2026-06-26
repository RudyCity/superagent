import { describe, it, expect } from "vitest";
import {
  resolveProviderType,
  buildProviderOptions,
  getModelOptions,
  resolveTestModel,
  getFallbackModels,
  checkEndpointCompatibility,
  testCustomProviderMessage,
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

    it("should resolve custom-anthropic from number or text", () => {
      expect(resolveProviderType("5")).toBe("custom-anthropic");
      expect(resolveProviderType("Custom Anthropic Endpoint")).toBe("custom-anthropic");
    });

    it("should return null for invalid input", () => {
      expect(resolveProviderType("invalid")).toBeNull();
      expect(resolveProviderType("6")).toBeNull();
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

  describe("checkEndpointCompatibility", () => {
    it("should return parsed models for valid OpenAI-compatible /models response", async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response(JSON.stringify({
          data: [{ id: "model-a" }, { id: "model-b" }, { id: "model-a" }, { id: "" }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

      try {
        const result = await checkEndpointCompatibility("http://localhost:8080/v1", "");
        expect(result.ok).toBe(true);
        expect(result.models).toEqual(["model-a", "model-b"]);
        expect(result.message).toBeUndefined();
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should diagnose HTML returned from /models", async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response("<html><body>bad gateway</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })) as typeof fetch;

      try {
        const result = await checkEndpointCompatibility("http://localhost:8080/v1", "");
        expect(result.ok).toBe(false);
        expect(result.models).toEqual([]);
        expect(result.message).toContain("HTML instead of JSON");
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should diagnose missing data array from /models", async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response(JSON.stringify({ models: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch;

      try {
        const result = await checkEndpointCompatibility("http://localhost:8080/v1", "");
        expect(result.ok).toBe(false);
        expect(result.models).toEqual([]);
        expect(result.message).toContain("missing expected JSON shape");
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe("testCustomProviderMessage", () => {
    it("should parse OpenAI-compatible chat completion JSON", async () => {
      const originalFetch = global.fetch;
      global.fetch = (async (_url, init) => {
        expect((init as RequestInit).method).toBe("POST");
        expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
          model: "model-a",
          stream: false,
        });
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "hello" } }],
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as typeof fetch;

      try {
        const result = await testCustomProviderMessage("http://localhost:8080/v1", "sk-test", "model-a", "hi");
        expect(result).toEqual({ ok: true, text: "hello" });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should parse SSE chat completion response when endpoint streams anyway", async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response([
          "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}",
          "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"}}]}",
          "data: [DONE]",
          "",
        ].join("\n"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })) as typeof fetch;

      try {
        const result = await testCustomProviderMessage("http://localhost:8080/v1", "", "model-a", "hi");
        expect(result).toEqual({ ok: true, text: "hello" });
      } finally {
        global.fetch = originalFetch;
      }
    });

    it("should diagnose non-JSON chat completion body", async () => {
      const originalFetch = global.fetch;
      global.fetch = (async () =>
        new Response("not json", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        })) as typeof fetch;

      try {
        const result = await testCustomProviderMessage("http://localhost:8080/v1", "", "model-a", "hi");
        expect(result.ok).toBe(false);
        expect(result.message).toContain("non-JSON body");
      } finally {
        global.fetch = originalFetch;
      }
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

describe("Wizard flow — step 7 bypassed (connection test via step 9)", () => {
  // After the refactor, the wizard skips step 7 (hardcoded connection test)
  // and goes directly from step 5/6 to step 8 (model selection).
  // The connection is tested naturally when the user sends a test message in step 9.
  // The step 7 handler code is kept as dead code for backward compatibility.

  it("should document that resolveTestModel is no longer used in the main wizard flow", () => {
    // resolveTestModel still works as a helper but is no longer called in the wizard
    expect(resolveTestModel("custom", "http://localhost:8080/v1")).toBe("gpt-4o-mini");
  });

  it("should return models for custom provider without filtering", () => {
    // This is the key function used when transitioning to step 8
    const cached = ["freemodel/gpt-5.4-mini", "openrouter/owl-alpha", "custom-model"];
    const result = getModelOptions("custom", cached);
    expect(result).toEqual(cached);
  });
});
