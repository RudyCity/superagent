import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderType, buildProviderOptions, getModelOptions, resolveTestModel, fetchModelsFromEndpoint, resolveTestModelAsync, resolveProfileFromPicker, fetchModelsForProvider, checkEndpointCompatibility } from "../src/core/loginWizardLogic.js";
import { getProviderOptionsList } from "../src/core/config/providers.js";
import { fetchAndCacheModels, getCachedModelIds, getContextWindowLimit } from "../src/core/config/models.js";
import { addProvider, clearModelConfigCache } from "../src/core/config/jsonConfig.js";

describe("loginWizardLogic", () => {
  describe("resolveProviderType", () => {
    it("resolves numeric choices", () => {
      expect(resolveProviderType("1")).toBe("openrouter");
      expect(resolveProviderType("2")).toBe("openai");
      expect(resolveProviderType("3")).toBe("anthropic");
      expect(resolveProviderType("4")).toBe("custom");
      expect(resolveProviderType("5")).toBe("custom-anthropic");
      expect(resolveProviderType("6")).toBe("gemini");
    });

    it("resolves name choices case-insensitively", () => {
      expect(resolveProviderType("OpenRouter (Recommended)")).toBe("openrouter");
      expect(resolveProviderType("OPENAI")).toBe("openai");
      expect(resolveProviderType("anthropic")).toBe("anthropic");
      expect(resolveProviderType("Custom Endpoint")).toBe("custom");
      expect(resolveProviderType("Custom Anthropic Endpoint")).toBe("custom-anthropic");
      expect(resolveProviderType("Google Gemini")).toBe("gemini");
    });

    it("returns null for invalid choices", () => {
      expect(resolveProviderType("7")).toBeNull();
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

    it("returns filtered cached models for gemini", () => {
      const cached = ["gemini-1.5-flash", "gpt-4o", "gemini-2.0-pro"];
      expect(getModelOptions("gemini", cached)).toEqual([
        "gemini-1.5-flash",
        "gemini-2.0-pro",
      ]);
    });

    it("returns fallback models for gemini when filtered cached list is empty", () => {
      const cached = ["gpt-4o", "claude-3-5-sonnet"];
      expect(getModelOptions("gemini", cached)).toEqual([
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
      ]);
    });

  it("limits results to 15", () => {
    const cached = Array.from({ length: 60 }, (_, i) => `gpt-${i}`);
    expect(getModelOptions("openai", cached)).toHaveLength(15);
  });
  });

  describe("resolveTestModel", () => {
    it("resolves anthropic test model", () => {
      expect(resolveTestModel("anthropic", "")).toBe("claude-3-haiku-20240307");
    });

    it("resolves openrouter test model", () => {
      expect(resolveTestModel("openrouter", "https://openrouter.ai/api/v1")).toBe("openai/gpt-4o-mini");
    });

    it("resolves gemini test model", () => {
      expect(resolveTestModel("gemini", "")).toBe("gemini-2.5-flash");
    });

    it("defaults to openai gpt-4o-mini", () => {
      expect(resolveTestModel("openai", "")).toBe("gpt-4o-mini");
      expect(resolveTestModel("custom", "http://localhost:11434/v1")).toBe("gpt-4o-mini");
    });
  });

  describe("fetchModelsFromEndpoint", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should return model IDs from a valid /models response", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: "llama-3.1-8b" },
            { id: "mistral-7b" },
            { id: "deepseek-chat" },
          ],
        }),
      });
      const models = await fetchModelsFromEndpoint("http://localhost:20128/v1", "sk-test");
      expect(models).toEqual(["llama-3.1-8b", "mistral-7b", "deepseek-chat"]);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:20128/v1/models",
        expect.objectContaining({
          headers: { Authorization: "Bearer sk-test" },
        })
      );
    });

    it("should strip trailing slashes from baseUrl", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "model-a" }] }),
      });
      await fetchModelsFromEndpoint("http://localhost:20128/v1///", "sk-test");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:20128/v1/models",
        expect.anything()
      );
    });

    it("should return empty array when response is not ok", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 404 });
      const models = await fetchModelsFromEndpoint("http://localhost:20128/v1", "sk-test");
      expect(models).toEqual([]);
    });

    it("should return empty array when fetch throws", async () => {
      (globalThis.fetch as any).mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const models = await fetchModelsFromEndpoint("http://localhost:20128/v1", "sk-test");
      expect(models).toEqual([]);
    });

    it("should filter out entries without id", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [{ id: "good" }, { id: "" }, null, { name: "no-id" }, { id: "also-good" }],
        }),
      });
      const models = await fetchModelsFromEndpoint("http://localhost:8080/v1", "");
      expect(models).toEqual(["good", "also-good"]);
    });

    it("should send no Authorization header when apiKey is empty", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });
      await fetchModelsFromEndpoint("http://localhost:8080/v1", "");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:8080/v1/models",
        expect.objectContaining({ headers: {} })
      );
    });
  });

  describe("resolveTestModelAsync", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("should use first model from endpoint for custom provider", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: "my-custom-model" }, { id: "another-model" }] }),
      });
      const model = await resolveTestModelAsync("custom", "http://localhost:20128/v1", "sk-test");
      expect(model).toBe("my-custom-model");
    });

    it("should fallback to resolveTestModel when endpoint returns no models", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [] }),
      });
      const model = await resolveTestModelAsync("custom", "http://localhost:20128/v1", "sk-test");
      expect(model).toBe("gpt-4o-mini");
    });

    it("should fallback to resolveTestModel when endpoint is unreachable", async () => {
      (globalThis.fetch as any).mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const model = await resolveTestModelAsync("custom", "http://localhost:20128/v1", "sk-test");
      expect(model).toBe("gpt-4o-mini");
    });

    it("should NOT fetch for anthropic provider (use hardcoded)", async () => {
      const model = await resolveTestModelAsync("anthropic", "", "sk-ant");
      expect(model).toBe("claude-3-haiku-20240307");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("should NOT fetch for openrouter provider (use hardcoded)", async () => {
      const model = await resolveTestModelAsync("openrouter", "https://openrouter.ai/api/v1", "sk-or");
      expect(model).toBe("openai/gpt-4o-mini");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("should NOT fetch for openai.com baseUrl (use hardcoded)", async () => {
      const model = await resolveTestModelAsync("openai", "https://api.openai.com/v1", "sk-openai");
      expect(model).toBe("gpt-4o-mini");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe("getProviderOptionsList", () => {
    it("should return all 6 default templates without filtering out configured providers", () => {
      const list = [
        { id: "openai-profile", name: "openai", type: "openai", apiKey: "sk-123", isActive: true },
        { id: "gemini-profile", name: "gemini", type: "gemini", apiKey: "gemini-123", isActive: false },
      ];
      const result = getProviderOptionsList(list);
      expect(result).toContain("openai (openai) [Active]");
      expect(result).toContain("gemini (gemini)");
      expect(result).toContain("1. OpenRouter (Recommended)");
      expect(result).toContain("2. OpenAI");
      expect(result).toContain("3. Anthropic");
      expect(result).toContain("4. Custom OpenAI Endpoint");
      expect(result).toContain("5. Custom Anthropic Endpoint");
      expect(result).toContain("6. Google Gemini");
      expect(result).toContain("< Back");
    });
  });

  describe("fetchAndCacheModels with inputTokenLimit and fallbacks", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
      clearModelConfigCache();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      clearModelConfigCache();
    });

    it("should read inputTokenLimit and fall back to static limits or 128000 when missing/falsy", async () => {
      addProvider({
        id: "gemini-test-prov",
        name: "Gemini Test Provider",
        provider: "gemini",
        apiKey: "test-gemini-key",
      });

      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: "models/gemini-2.5-flash", inputTokenLimit: 1000000 },
            { name: "models/gemini-2.5-pro" }, // no limit, falls back to static limit 1048576
            { name: "models/unknown-fictional-model" }, // no limit, falls back to 128000
          ],
        }),
      });

      await fetchAndCacheModels();

      expect(getContextWindowLimit("gemini-2.5-flash")).toBe(1000000);
      expect(getContextWindowLimit("gemini-2.5-pro")).toBe(1048576);
      expect(getContextWindowLimit("unknown-fictional-model")).toBe(128000);
      expect(getContextWindowLimit("mistral-large-latest")).toBe(262144);
      expect(getContextWindowLimit("~mistralai/mistral-large-latest")).toBe(262144);
      expect(getContextWindowLimit("mistralai/mistral-small-latest")).toBe(262144);
      expect(getContextWindowLimit("codestral-latest")).toBe(256000);
      expect(getContextWindowLimit("mistral-medium-latest")).toBe(262144);
    });
  });

  describe("resolveProfileFromPicker", () => {
    const providers = [
      { id: "or-main", name: "My OpenRouter", provider: "openrouter", apiKey: "sk-or-123" },
      { id: "oai-prod", name: "OpenAI Prod", provider: "openai", apiKey: "sk-oai-456" },
      { id: "custom-ollama", name: "Local Ollama", provider: "custom", apiKey: "", baseUrl: "http://localhost:11434/v1" },
    ];

    it("resolves numbered index choice", () => {
      const resolved = resolveProfileFromPicker("1", "openrouter", providers as any);
      expect(resolved?.id).toBe("or-main");
    });

    it("resolves numbered option text format", () => {
      const resolved = resolveProfileFromPicker("1. My OpenRouter (key: sk-or-123)", "openrouter", providers as any);
      expect(resolved?.id).toBe("or-main");
    });

    it("resolves unnumbered option text format", () => {
      const resolved = resolveProfileFromPicker("My OpenRouter (key: sk-or-...)", "openrouter", providers as any);
      expect(resolved?.id).toBe("or-main");
    });

    it("resolves exact profile name", () => {
      const resolved = resolveProfileFromPicker("OpenAI Prod", "openai", providers as any);
      expect(resolved?.id).toBe("oai-prod");
    });
  });

  describe("checkEndpointCompatibility shape support", () => {
    beforeEach(() => {
      vi.stubGlobal("fetch", vi.fn());
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("supports { models: [{ name: 'models/xxx' }] } shape", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          models: [{ name: "models/gemini-2.5-flash" }, { name: "models/gemini-2.5-pro" }]
        }),
      });

      const res = await checkEndpointCompatibility("http://localhost:8080/v1", "key");
      expect(res.ok).toBe(true);
      expect(res.models).toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    });

    it("supports raw array shape", async () => {
      (globalThis.fetch as any).mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify([
          { id: "llama3:latest" },
          { id: "mistral:latest" }
        ]),
      });

      const res = await checkEndpointCompatibility("http://localhost:11434/v1", "");
      expect(res.ok).toBe(true);
      expect(res.models).toEqual(["llama3:latest", "mistral:latest"]);
    });
  });
});
