import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveProviderType, buildProviderOptions, getModelOptions, resolveTestModel, fetchModelsFromEndpoint, resolveTestModelAsync } from "../src/core/loginWizardLogic.js";

describe("loginWizardLogic", () => {
  describe("resolveProviderType", () => {
    it("resolves numeric choices", () => {
      expect(resolveProviderType("1")).toBe("openrouter");
      expect(resolveProviderType("2")).toBe("openai");
      expect(resolveProviderType("3")).toBe("anthropic");
      expect(resolveProviderType("4")).toBe("custom");
      expect(resolveProviderType("5")).toBe("custom-anthropic");
    });

    it("resolves name choices case-insensitively", () => {
      expect(resolveProviderType("OpenRouter (Recommended)")).toBe("openrouter");
      expect(resolveProviderType("OPENAI")).toBe("openai");
      expect(resolveProviderType("anthropic")).toBe("anthropic");
      expect(resolveProviderType("Custom Endpoint")).toBe("custom");
      expect(resolveProviderType("Custom Anthropic Endpoint")).toBe("custom-anthropic");
    });

    it("returns null for invalid choices", () => {
      expect(resolveProviderType("6")).toBeNull();
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
});
