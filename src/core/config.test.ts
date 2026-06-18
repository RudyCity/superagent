import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock os.homedir() di paling atas untuk isolasi penuh
const tempHome = path.join(process.cwd(), "tests", "temp-home-config");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { getGlobalConfigDir, getContextWindowLimit, getConfig, fetchAndCacheModels, listHistorySessions, getModelInstanceForTier, getModelInstanceForString, isAnthropicCompatible, switchActiveProvider, savePreset, setActivePresetId, ensureGlobalConfigDir } from "./config.js";
import { getModelConfigPath } from "./config/paths.js";
import { clearModelConfigCache, loadModelConfig, addProvider } from "./config/jsonConfig.js";

describe("config", () => {
  let originalEnv: NodeJS.ProcessEnv;
  const configPath = getModelConfigPath();

  beforeEach(() => {
    // Back up process.env to avoid side effects
    originalEnv = { ...process.env };
    
    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearModelConfigCache();
  });

  afterEach(() => {
    // Restore process.env
    process.env = originalEnv;
    
    // Bersihkan folder temp
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    clearModelConfigCache();
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

    // Tulis provider 'custom' ke JSON config
    addProvider({
      id: "custom",
      name: "Custom Provider",
      provider: "openai",
      apiKey: "test-key",
      baseUrl: "http://localhost:8080/v1"
    });
    switchActiveProvider("custom");

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

  it("should resolve config using JSON preset", () => {
    // Write a test config with anthropic provider
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "test-anthropic", name: "Test Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" }
      ],
      presets: {
        multi: [{ id: "test-multi", name: "Test Multi", description: "", models: { master: { providerProfileId: "test-anthropic", model: "claude-3-5-sonnet" }, superagent: { providerProfileId: "test-anthropic", model: "claude-3-5-sonnet" }, subagentDefault: { providerProfileId: "test-anthropic", model: "claude-3-5-sonnet" }, subagentDetails: {} } }],
        single: [{ id: "test-single", name: "Test Single", description: "", models: { superagent: { providerProfileId: "test-anthropic", model: "claude-3-5-sonnet" }, subagentDefault: { providerProfileId: "test-anthropic", model: "claude-3-5-sonnet" }, subagentDetails: {} } }]
      },
      activePresetId: { multi: "test-multi", single: "test-single" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    const config = getConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("sk-ant-test");
  });

  it("should fallback config provider appropriately", () => {
    // Write a test config with anthropic provider and custom model
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "test-anthropic", name: "Test Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" }
      ],
      presets: {
        multi: [{ id: "test-multi", name: "Test Multi", description: "", models: { master: { providerProfileId: "test-anthropic", model: "my-custom-model" }, superagent: { providerProfileId: "test-anthropic", model: "my-custom-model" }, subagentDefault: { providerProfileId: "test-anthropic", model: "my-custom-model" }, subagentDetails: {} } }],
        single: [{ id: "test-single", name: "Test Single", description: "", models: { superagent: { providerProfileId: "test-anthropic", model: "my-custom-model" }, subagentDefault: { providerProfileId: "test-anthropic", model: "my-custom-model" }, subagentDetails: {} } }]
      },
      activePresetId: { multi: "test-multi", single: "test-single" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    const config = getConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.apiKey).toBe("sk-ant-test");
    expect(config.model).toBe("my-custom-model");
  });

  describe("listHistorySessions", () => {
    it("should only return history sessions matching the current active project path or its subdirectories", () => {
      const historyDirSingle = path.join(getGlobalConfigDir(), "history", "single");

      const mockCwd = "D:\\projects\\my-awesome-project";
      const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      const spyExistsSync = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = typeof p === "string" ? p : p.toString();
        if (pathStr.includes("history")) return true;
        return false;
      });

      const mockDirs = [
        "D__projects_my_awesome_project_123",
        "d__projects_my_awesome_project_src_456",
        "D__projects_another_project_789",
      ];
      const spyReaddirSync = vi.spyOn(fs, "readdirSync").mockReturnValue(mockDirs as any);

      const spyStatSync = vi.spyOn(fs, "statSync").mockReturnValue({
        mtime: new Date(),
      } as any);

      const spyReadFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((p) => {
        const filePath = typeof p === "string" ? p : p.toString();
        if (filePath.includes("my_awesome_project_src")) {
          // Object format
          return JSON.stringify({
            messages: [
              { role: "user", content: "hello from object" },
              { role: "assistant", content: "hi from object" }
            ],
            planState: "IDLE"
          });
        }
        // Legacy array format
        return JSON.stringify([
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" }
        ]);
      });

      try {
        const sessions = listHistorySessions();
        // Should only match:
        // - "D__projects_my_awesome_project_123"
        // - "d__projects_my_awesome_project_src_456"
        expect(sessions.length).toBe(2);
        expect(sessions[0].filePath).toContain("my_awesome_project");
        expect(sessions[0].messageCount).toBe(2);
        expect(sessions[0].preview).toBe("hello");

        expect(sessions[0].displayName).toBe("hello");

        expect(sessions[1].filePath).toContain("my_awesome_project_src");
        expect(sessions[1].messageCount).toBe(2);
        expect(sessions[1].preview).toBe("hello from object");
        expect(sessions[1].displayName).toBe("hello from object");
      } finally {
        spyCwd.mockRestore();
        spyExistsSync.mockRestore();
        spyReaddirSync.mockRestore();
        spyStatSync.mockRestore();
        spyReadFileSync.mockRestore();
      }
    });

    it("should filter between single-agent and multi-agent sessions when isMulti flag is provided", () => {
      const mockCwd = "D:\\projects\\my-awesome-project";
      const spyCwd = vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

      const spyExistsSync = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
        const pathStr = typeof p === "string" ? p : p.toString();
        if (pathStr.includes("history")) return true;
        return false;
      });

      const spyReaddirSync = vi.spyOn(fs, "readdirSync").mockImplementation((p) => {
        const pathStr = typeof p === "string" ? p : p.toString();
        if (pathStr.includes("single")) {
          return ["D__projects_my_awesome_project_123"] as any;
        }
        if (pathStr.includes("multi")) {
          return ["D__projects_my_awesome_project_456"] as any;
        }
        return [] as any;
      });

      const spyStatSync = vi.spyOn(fs, "statSync").mockReturnValue({
        mtime: new Date(),
      } as any);

      const spyReadFileSync = vi.spyOn(fs, "readFileSync").mockReturnValue(
        JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        })
      );

      try {
        const singleSessions = listHistorySessions(false);
        expect(singleSessions.length).toBe(1);
        expect(singleSessions[0].filePath).toContain("my_awesome_project_123");

        const multiSessions = listHistorySessions(true);
        expect(multiSessions.length).toBe(1);
        expect(multiSessions[0].filePath).toContain("my_awesome_project_456");
      } finally {
        spyCwd.mockRestore();
        spyExistsSync.mockRestore();
        spyReaddirSync.mockRestore();
        spyStatSync.mockRestore();
        spyReadFileSync.mockRestore();
      }
    });
  });

  it("should namespace getGlobalConfigDir if process.env.SUPERAGENT_SESSION_ID is set", () => {
    process.env.SUPERAGENT_SESSION_ID = "session-123456";
    const dir = getGlobalConfigDir();
    expect(dir).toContain(path.join(".superagent-r", "sessions", "session-123456"));
  });

  describe("getModelInstanceForTier", () => {
    beforeEach(() => {
      process.env.OPENAI_API_KEY = "dummy-openai-key";
      process.env.ANTHROPIC_API_KEY = "dummy-anthropic-key";
      process.env.CUSTOM_API_KEY = "dummy-custom-key";
      process.env.CUSTOM_BASE_URL = "http://localhost:11434/v1";
    });

    it("should resolve specific model per agent tier from the active preset", () => {
      const testPreset = {
        id: "test-tier-preset",
        name: "Test Tier Preset",
        description: "Test",
        models: {
          master: { providerProfileId: "default-openai", model: "gpt-4o-mini" },
          superagent: { providerProfileId: "default-anthropic", model: "claude-3-5-sonnet" },
          subagentDefault: { providerProfileId: "default-openai", model: "local-llama" },
          subagentDetails: {}
        }
      };
      savePreset("multi", testPreset);
      setActivePresetId("multi", "test-tier-preset");
      process.env.SUPERAGENT_MULTI = "true";

      const masterModel: any = getModelInstanceForTier("master", 0);
      expect(masterModel.modelId).toBe("gpt-4o-mini");

      const superagentModel: any = getModelInstanceForTier("superagent", 1);
      expect(superagentModel.modelId).toBe("claude-3-5-sonnet");

      const subagentModel: any = getModelInstanceForTier("subagent", 2);
      expect(subagentModel.modelId).toBe("local-llama");
    });

    it("should resolve subagent-specific model overrides from active preset", () => {
      // Write config with required provider profiles
      const testConfig = {
        settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
        providers: [
          { id: "default-openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" },
          { id: "default-anthropic", name: "Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" }
        ],
        presets: {
          multi: [{
            id: "test-subagent-preset",
            name: "Test Subagent Preset",
            description: "Test",
            models: {
              master: { providerProfileId: "default-openai", model: "gpt-4" },
              superagent: { providerProfileId: "default-openai", model: "gpt-4" },
              subagentDefault: { providerProfileId: "default-openai", model: "general-subagent-model" },
              subagentDetails: {
                researcher: { providerProfileId: "default-openai", model: "gpt-4-turbo" },
                coder: { providerProfileId: "default-anthropic", model: "claude-3-5-haiku" }
              }
            }
          }],
          single: []
        },
        activePresetId: { multi: "test-subagent-preset", single: "" }
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
      clearModelConfigCache();
      process.env.SUPERAGENT_MULTI = "true";

      const researcherModel: any = getModelInstanceForTier("subagent", 2, "researcher");
      expect(researcherModel.modelId).toBe("gpt-4-turbo");

      const coderModel: any = getModelInstanceForTier("subagent", 2, "coder");
      expect(coderModel.modelId).toBe("claude-3-5-haiku");

      const reviewerModel: any = getModelInstanceForTier("subagent", 2, "reviewer");
      expect(reviewerModel.modelId).toBe("general-subagent-model");
    });

    it("should fallback to process.env.MODEL if preset models are missing or global override is set", () => {
      process.env.MODEL = "openai:gpt-4o";
      const testPreset = {
        id: "test-fallback-preset",
        name: "Test Fallback Preset",
        description: "Test",
        models: {
          master: null,
          superagent: null,
          subagentDefault: null,
          subagentDetails: {}
        }
      } as any;
      savePreset("multi", testPreset);
      setActivePresetId("multi", "test-fallback-preset");
      process.env.SUPERAGENT_MULTI = "true";

      const masterModel: any = getModelInstanceForTier("master", 0);
      expect(masterModel.modelId).toBe("gpt-4o");
    });

    it("should prioritize tier parameter over depth parameter in getModelInstanceForTier", () => {
      const testPreset = {
        id: "test-priority-preset",
        name: "Test Priority Preset",
        description: "Test",
        models: {
          master: { providerProfileId: "default-openai", model: "gpt-master" },
          superagent: { providerProfileId: "default-openai", model: "gpt-superagent" },
          subagentDefault: { providerProfileId: "default-openai", model: "local-llama" },
          subagentDetails: {}
        }
      };
      savePreset("multi", testPreset);
      setActivePresetId("multi", "test-priority-preset");
      process.env.SUPERAGENT_MULTI = "true";

      // Even if depth is 1 (which matches superagent), if tier is subagent, it must resolve using subagent model
      const subagentModel: any = getModelInstanceForTier("subagent", 1);
      expect(subagentModel.modelId).toBe("local-llama");
    });

    it("should update active provider without overwriting existing tier models", () => {
      // Write test config with providers
      const testConfig = {
        settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
        providers: [
          { id: "anthropic", name: "Anthropic", provider: "anthropic", apiKey: "sk-ant-test", baseUrl: "" }
        ],
        presets: {
          multi: [{
            id: "test-multi",
            name: "Test Multi",
            description: "Test",
            models: {
              master: { providerProfileId: "openai", model: "gpt-4o-mini" },
              superagent: { providerProfileId: "openai", model: "gpt-4o" },
              subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
              subagentDetails: {
                researcher: { providerProfileId: "openai", model: "gpt-4-turbo" }
              }
            }
          }],
          single: []
        },
        activePresetId: { multi: "test-multi", single: "" }
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
      clearModelConfigCache();

      process.env.SUPERAGENT_MULTI = "true";
      switchActiveProvider("anthropic");
      delete process.env.SUPERAGENT_MULTI;

      // Verify preset was updated
      const config = loadModelConfig();
      const preset = config.presets.multi[0];
      expect(preset.models.master.providerProfileId).toBe("anthropic");
      expect(preset.models.master.model).toBe("gpt-4o-mini");
      expect(preset.models.superagent.model).toBe("gpt-4o");
      expect(preset.models.subagentDefault.providerProfileId).toBe("anthropic");
      expect(preset.models.subagentDetails.researcher.providerProfileId).toBe("anthropic");
      expect(preset.models.subagentDetails.researcher.model).toBe("gpt-4-turbo");
    });
  });

  describe("getModelInstanceForString", () => {
    it("should dynamically resolve custom provider prefix from JSON config", () => {
      // Write config with custom provider
      const testConfig = {
        settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
        providers: [
          { id: "myprovider", name: "MyProvider", provider: "openai", apiKey: "my-api-key", baseUrl: "https://api.myprovider.com/v1" }
        ],
        presets: {
          multi: [],
          single: []
        },
        activePresetId: { multi: "", single: "" }
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
      clearModelConfigCache();

      const model: any = getModelInstanceForString("myprovider:some-cool-model");
      expect(model.modelId).toBe("some-cool-model");
    });

    it("should fallback resolve custom provider prefixes starting with openrouter/anthropic/openai", () => {
      // Write config with openrouter provider
      const testConfig = {
        settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
        providers: [
          { id: "openrouter", name: "openrouter", provider: "openrouter", apiKey: "fallback-key", baseUrl: "https://openrouter.ai/api/v1" }
        ],
        presets: {
          multi: [],
          single: []
        },
        activePresetId: { multi: "", single: "" }
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
      clearModelConfigCache();

      const model: any = getModelInstanceForString("openrouter:nex-agi/nex-n2-pro:free");
      expect(model.modelId).toBe("nex-agi/nex-n2-pro:free");
    });

    it("should throw a descriptive error when API key is missing for a cloud provider", () => {
      process.env.SUPERAGENT_FORCE_VAL_CHECK = "true";

      // Write config with provider that has empty API key
      const testConfig = {
        settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
        providers: [
          { id: "openrouter", name: "openrouter", provider: "openrouter", apiKey: "", baseUrl: "https://openrouter.ai/api/v1" }
        ],
        presets: {
          multi: [],
          single: []
        },
        activePresetId: { multi: "", single: "" }
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
      clearModelConfigCache();

      try {
        expect(() => {
          getModelInstanceForString("openrouter:nex-agi/nex-n2-pro:free");
        }).toThrow(/API key is missing or not configured/);
      } finally {
        delete process.env.SUPERAGENT_FORCE_VAL_CHECK;
      }
    });

    it("should correctly identify Anthropic-compatible endpoints using isAnthropicCompatible", () => {
      expect(isAnthropicCompatible("https://api.anthropic.com", "claude-3-5-sonnet")).toBe(true);
      expect(isAnthropicCompatible("https://anthropic-proxy.corp.internal/v1", "claude-3-5-sonnet")).toBe(true);
      expect(isAnthropicCompatible("https://openrouter.ai/api/v1", "anthropic/claude-3.5-sonnet")).toBe(false);
      expect(isAnthropicCompatible("http://localhost:11434/v1", "llama3")).toBe(false);
      expect(isAnthropicCompatible("https://api.litellm.ai", "claude-3-haiku")).toBe(false);
    });
  });
});
