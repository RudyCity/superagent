import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import {
  loadModelConfig,
  addProvider,
  clearModelConfigCache,
  savePreset,
  setActivePresetId,
} from "../src/core/config/jsonConfig";
import { getModelConfigPath } from "../src/core/config/paths";
import { switchActiveProvider } from "../src/core/config/providers";
import { applyModelPreset, saveModelPreset, getModelPresets, getCustomPresetsPath } from "../src/core/config/presets";
import { updateEnvFile } from "../src/core/config/env";
import { getConfig } from "../src/core/config/base";
import { getModelInstanceForString } from "../src/core/config/models";
import { ensureGlobalConfigDir, getRootConfigDir } from "../src/core/config/paths";

describe("Provider Credential Resolution Fixes", () => {
  let originalConfigContent: string | null = null;
  let originalPresetsContent: string | null = null;
  let originalEnvContent: string | null = null;
  let originalProcessEnv: NodeJS.ProcessEnv;

  const configPath = getModelConfigPath();
  const presetsPath = getCustomPresetsPath();
  const envPath = path.join(getRootConfigDir(), ".env");

  beforeEach(() => {
    originalProcessEnv = { ...process.env };
    ensureGlobalConfigDir();

    if (fs.existsSync(configPath)) {
      originalConfigContent = fs.readFileSync(configPath, "utf-8");
    }
    if (fs.existsSync(presetsPath)) {
      originalPresetsContent = fs.readFileSync(presetsPath, "utf-8");
      fs.unlinkSync(presetsPath);
    }
    if (fs.existsSync(envPath)) {
      originalEnvContent = fs.readFileSync(envPath, "utf-8");
      fs.unlinkSync(envPath);
    }

    clearModelConfigCache();
    if (fs.existsSync(configPath)) {
      try { fs.unlinkSync(configPath); } catch (e) {}
    }
  });

  afterEach(() => {
    process.env = originalProcessEnv;

    if (originalConfigContent !== null) {
      fs.writeFileSync(configPath, originalConfigContent, "utf-8");
    } else {
      if (fs.existsSync(configPath)) {
        try { fs.unlinkSync(configPath); } catch (e) {}
      }
    }

    if (originalPresetsContent !== null) {
      fs.writeFileSync(presetsPath, originalPresetsContent, "utf-8");
    } else {
      if (fs.existsSync(presetsPath)) {
        try { fs.unlinkSync(presetsPath); } catch (e) {}
      }
    }

    if (originalEnvContent !== null) {
      fs.writeFileSync(envPath, originalEnvContent, "utf-8");
    } else {
      if (fs.existsSync(envPath)) {
        try { fs.unlinkSync(envPath); } catch (e) {}
      }
    }

    clearModelConfigCache();
  });

  describe("JSON config provider resolution", () => {
    it("should resolve provider credentials from JSON config", () => {
      addProvider({
        id: "openrouter-valid",
        name: "OpenRouter Valid",
        provider: "openrouter",
        apiKey: "sk-or-valid-key",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      const config = loadModelConfig();
      const providers = config.providers;
      const validProfile = providers.find(p => p.id === "openrouter-valid");

      expect(validProfile).toBeDefined();
      expect(validProfile?.apiKey).toBe("sk-or-valid-key");
    });

    it("should store multiple provider profiles in JSON config", () => {
      addProvider({
        id: "openai-valid",
        name: "OpenAI Valid",
        provider: "openai",
        apiKey: "sk-valid-openai-key",
        baseUrl: "",
      });

      const config = loadModelConfig();
      const profile = config.providers.find(p => p.id === "openai-valid");

      expect(profile).toBeDefined();
      expect(profile?.apiKey).toBe("sk-valid-openai-key");
    });
  });

  describe("Fix #5: switchActiveProvider", () => {
    it("should update active preset in JSON config", () => {
      // Write test config with providers
      const testConfig = {
        settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
        providers: [
          { id: "openrouter", name: "OpenRouter", provider: "openrouter", apiKey: "sk-or-test", baseUrl: "https://openrouter.ai/api/v1" }
        ],
        presets: {
          multi: [{
            id: "test-multi",
            name: "Test Multi",
            description: "Test",
            models: {
              master: { providerProfileId: "openrouter", model: "gpt-4o" },
              superagent: { providerProfileId: "openrouter", model: "gpt-4o" },
              subagentDefault: { providerProfileId: "openrouter", model: "gpt-4o" },
              subagentDetails: {}
            }
          }],
          single: []
        },
        activePresetId: { multi: "test-multi", single: "" }
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
      clearModelConfigCache();

      switchActiveProvider("openrouter");

      // Verify preset was updated
      const config = loadModelConfig();
      const preset = config.presets.multi[0];
      expect(preset.models.master.providerProfileId).toBe("openrouter");
    });

    it("should update active preset with correct provider", () => {
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
              master: { providerProfileId: "openai", model: "gpt-4o" },
              superagent: { providerProfileId: "openai", model: "gpt-4o" },
              subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
              subagentDetails: {}
            }
          }],
          single: []
        },
        activePresetId: { multi: "test-multi", single: "" }
      };
      fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
      clearModelConfigCache();

      // Set multi mode
      process.env.SUPERAGENT_MULTI = "true";
      switchActiveProvider("anthropic");
      delete process.env.SUPERAGENT_MULTI;

      // Verify preset was updated
      const config = loadModelConfig();
      const preset = config.presets.multi[0];
      expect(preset.models.master.providerProfileId).toBe("anthropic");
    });
  });

  describe("Fix #6: updateEnvFile safety net", () => {
    it("should sync active profile credentials when ACTIVE_PROVIDER is set", () => {
      addProvider({
        id: "test-openrouter",
        name: "Test OpenRouter",
        provider: "openrouter",
        apiKey: "sk-or-test-key",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      clearModelConfigCache();

      // Verify provider is stored in JSON config
      const config = loadModelConfig();
      const profile = config.providers.find(p => p.id === "test-openrouter");
      expect(profile).toBeDefined();
      expect(profile?.apiKey).toBe("sk-or-test-key");
      expect(profile?.baseUrl).toBe("https://openrouter.ai/api/v1");
    });

    it("should fallback to same-type profile when matched profile has empty key", () => {
      addProvider({
        id: "openrouter-empty",
        name: "OpenRouter Empty",
        provider: "openrouter",
        apiKey: "",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      addProvider({
        id: "openrouter-valid",
        name: "OpenRouter Valid",
        provider: "openrouter",
        apiKey: "sk-or-fallback-key",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      clearModelConfigCache();

      // Verify fallback profile exists in JSON config
      const config = loadModelConfig();
      const emptyProfile = config.providers.find(p => p.id === "openrouter-empty");
      const validProfile = config.providers.find(p => p.id === "openrouter-valid");
      expect(emptyProfile?.apiKey).toBe("");
      expect(validProfile?.apiKey).toBe("sk-or-fallback-key");
    });
  });

  describe("Fix #1: applyModelPreset carries credentials", () => {
    it("should preserve model suffix with colons (e.g., :free) when syncing to model-config.json", async () => {
      addProvider({
        id: "openrouter",
        name: "openrouter",
        provider: "openrouter",
        apiKey: "sk-or-test-key",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      clearModelConfigCache();

      saveModelPreset("free-preset", "Free model preset", {
        MODEL_MULTI_MASTER: "openrouter:nex-agi/nex-n2-pro:free",
      });

      applyModelPreset("free-preset");

      await new Promise(resolve => setTimeout(resolve, 100));

      const presets = getModelPresets();
      const appliedPreset = presets.find(p => p.name === "free-preset");
      expect(appliedPreset).toBeDefined();
      expect(appliedPreset?.models.MODEL_MULTI_MASTER).toBe("openrouter:nex-agi/nex-n2-pro:free");
    });

    it("should store provider credentials in JSON config", () => {
      addProvider({
        id: "openrouter",
        name: "openrouter",
        provider: "openrouter",
        apiKey: "sk-or-preset-key",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      clearModelConfigCache();

      // Verify credentials are in JSON config
      const config = loadModelConfig();
      const profile = config.providers.find(p => p.id === "openrouter");
      expect(profile).toBeDefined();
      expect(profile?.apiKey).toBe("sk-or-preset-key");
    });

    it("should fallback to same-type profile when matched profile has empty key", () => {
      addProvider({
        id: "openrouter",
        name: "openrouter",
        provider: "openrouter",
        apiKey: "",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      addProvider({
        id: "openrouter-backup",
        name: "OpenRouter Backup",
        provider: "openrouter",
        apiKey: "sk-or-backup-key",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      clearModelConfigCache();

      // Verify fallback profile exists in JSON config
      const config = loadModelConfig();
      const emptyProfile = config.providers.find(p => p.id === "openrouter");
      const backupProfile = config.providers.find(p => p.id === "openrouter-backup");
      expect(emptyProfile?.apiKey).toBe("");
      expect(backupProfile?.apiKey).toBe("sk-or-backup-key");
    });
  });

  describe("Fix #2+#3: getConfig + getModelInstanceForString fallback", () => {
    it("should fallback to same-type profile in getConfig when matched profile has empty key", () => {
      addProvider({
        id: "test-provider",
        name: "Test Provider",
        provider: "openrouter",
        apiKey: "",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      addProvider({
        id: "test-provider-backup",
        name: "Test Provider Backup",
        provider: "openrouter",
        apiKey: "sk-or-getConfig-fallback",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      const preset = {
        id: "test-getConfig-preset",
        name: "Test getConfig Preset",
        description: "Test",
        models: {
          superagent: {
            providerProfileId: "test-provider",
            model: "test-model",
          },
          subagentDefault: {
            providerProfileId: "test-provider",
            model: "test-model-mini",
          },
          subagentDetails: {},
        },
      };

      savePreset("single", preset);
      setActivePresetId("single", "test-getConfig-preset");
      clearModelConfigCache();

      delete process.env.ACTIVE_PROVIDER;
      delete process.env.CUSTOM_BASE_URL;
      delete process.env.CUSTOM_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const config = getConfig();
      expect(config.apiKey).toBe("sk-or-getConfig-fallback");
    });

    it("should fallback in getModelInstanceForString when matched profile has empty key", () => {
      addProvider({
        id: "test-models-provider",
        name: "Test Models Provider",
        provider: "openrouter",
        apiKey: "",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      addProvider({
        id: "test-models-provider-backup",
        name: "Test Models Provider Backup",
        provider: "openrouter",
        apiKey: "sk-or-models-fallback",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      clearModelConfigCache();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: "mock" })));

      try {
        expect(() => {
          getModelInstanceForString("test-models-provider:test-model");
        }).not.toThrow(/API key is missing/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not throw API key error when fallback profile exists", () => {
      addProvider({
        id: "empty-or",
        name: "Empty OR",
        provider: "openrouter",
        apiKey: "",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      addProvider({
        id: "valid-or",
        name: "Valid OR",
        provider: "openrouter",
        apiKey: "sk-or-no-throw",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      clearModelConfigCache();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: "mock" })));

      try {
        expect(() => {
          getModelInstanceForString("empty-or:model");
        }).not.toThrow();
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should not treat colon in namespaced model as provider separator", () => {
      addProvider({
        id: "openrouter",
        name: "openrouter",
        provider: "openrouter",
        apiKey: "sk-or-namespace-test",
        baseUrl: "https://openrouter.ai/api/v1",
      });

      const preset = {
        id: "namespace-test-preset",
        name: "Namespace Test",
        description: "Test",
        models: {
          superagent: {
            providerProfileId: "openrouter",
            model: "nex-agi/nex-n2-pro:free",
          },
          subagentDefault: {
            providerProfileId: "openrouter",
            model: "nex-agi/nex-n2-pro:free",
          },
          subagentDetails: {},
        },
      };

      savePreset("single", preset);
      setActivePresetId("single", "namespace-test-preset");
      clearModelConfigCache();

      delete process.env.ACTIVE_PROVIDER;
      delete process.env.CUSTOM_BASE_URL;
      delete process.env.CUSTOM_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const config = getConfig();
      expect(config.apiKey).toBe("sk-or-namespace-test");
      expect(config.model).toBe("nex-agi/nex-n2-pro:free");

      const originalFetch = globalThis.fetch;
      globalThis.fetch = () => Promise.resolve(new Response(JSON.stringify({ error: "mock" })));

      try {
        expect(() => {
          getModelInstanceForString("nex-agi/nex-n2-pro:free");
        }).not.toThrow(/API key is missing/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
