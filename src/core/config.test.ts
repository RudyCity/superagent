import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { getGlobalConfigDir, getContextWindowLimit, getConfig, fetchAndCacheModels } from "./config.js";

describe("config", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Back up process.env to avoid side effects
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore process.env
    process.env = originalEnv;
  });

  it("should get global config directory containing expected name", () => {
    const dir = getGlobalConfigDir();
    expect(dir).toContain(".superagent-r");
  });

  it("should return correct context window limits based on model name", () => {
    expect(getContextWindowLimit("claude-3-5-sonnet")).toBe(200000);
    expect(getContextWindowLimit("gpt-4o")).toBe(128000);
    expect(getContextWindowLimit("o1-preview")).toBe(200000);
    expect(getContextWindowLimit("unknown-model")).toBe(256000);
  });

  it("should read context window limits from models_cache.json if present", () => {
    const cachePath = path.join(getGlobalConfigDir(), "models_cache.json");
    
    // Save existing cache file if it exists
    let existingContent: string | null = null;
    if (fs.existsSync(cachePath)) {
      existingContent = fs.readFileSync(cachePath, "utf-8");
    }

    try {
      // Ensure dir exists
      fs.mkdirSync(getGlobalConfigDir(), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ "my-special-cached-model": 999999 }), "utf-8");
      
      expect(getContextWindowLimit("my-special-cached-model")).toBe(999999);
    } finally {
      // Clean up
      if (existingContent !== null) {
        fs.writeFileSync(cachePath, existingContent, "utf-8");
      } else {
        try {
          fs.unlinkSync(cachePath);
        } catch {}
      }
    }
  });

  it("should fallback to rich static lookups if not cached", () => {
    expect(getContextWindowLimit("google/gemini-2.5-flash")).toBe(1048576);
    expect(getContextWindowLimit("deepseek-chat")).toBe(131072);
    expect(getContextWindowLimit("meta-llama/llama-3.3-70b-instruct")).toBe(131072);
    
    // Explicit and dynamic free models
    expect(getContextWindowLimit("google/gemma-4-26b-a4b-it:free")).toBe(262144);
    expect(getContextWindowLimit("meta-llama/llama-3.3-70b-instruct:free")).toBe(131072);
    expect(getContextWindowLimit("qwen/qwen3-coder:free")).toBe(1048576);
  });

  it("should fetch and cache models from provider correctly", async () => {
    // Mock global fetch
    const mockResponseData = {
      data: [
        { id: "fetched-model-1", context_length: 50000 },
        { id: "fetched-model-2", metadata: { max_model_len: 60000 } }
      ]
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(() => 
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockResponseData)
      } as Response)
    );

    // Mock active provider env override to test OpenAI/custom provider path
    process.env.ACTIVE_PROVIDER = "custom";
    process.env.CUSTOM_BASE_URL = "http://localhost:8080/v1";
    process.env.CUSTOM_API_KEY = "test-key";

    const cachePath = path.join(getGlobalConfigDir(), "models_cache.json");
    let existingContent: string | null = null;
    if (fs.existsSync(cachePath)) {
      existingContent = fs.readFileSync(cachePath, "utf-8");
    }

    try {
      await fetchAndCacheModels();
      
      expect(getContextWindowLimit("fetched-model-1")).toBe(50000);
      expect(getContextWindowLimit("fetched-model-2")).toBe(60000);
    } finally {
      // Restore
      globalThis.fetch = originalFetch;
      if (existingContent !== null) {
        fs.writeFileSync(cachePath, existingContent, "utf-8");
      } else {
        try {
          fs.unlinkSync(cachePath);
        } catch {}
      }
    }
  });

  it("should resolve config using active provider env overrides", () => {
    process.env.ACTIVE_PROVIDER = "anthropic";
    process.env.PROVIDER_ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.MODEL = "claude-3-5-sonnet";

    const config = getConfig();
    expect(config.provider).toBe("anthropic");
  });

  it("should fallback config provider appropriately", () => {
    // Clean up env keys
    delete process.env.ACTIVE_PROVIDER;
    delete process.env.CUSTOM_BASE_URL;
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.MODEL = "my-custom-model";

    const config = getConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("sk-ant-test");
    expect(config.model).toBe("my-custom-model");
  });
});
