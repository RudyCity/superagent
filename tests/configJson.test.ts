import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { 
  loadModelConfig, 
  addProvider, 
  getProviders, 
  getActivePreset, 
  savePreset,
  setActivePresetId,
  clearModelConfigCache,
  updateSettings,
  getTrustedDirectories,
  addTrustedDirectory,
  isDirectoryTrusted,
  getSettings
} from "../src/core/config/jsonConfig";
import { getModelInstanceForTier } from "../src/core/config/models";
import { closeHistoryDb } from "../src/core/storage/historyDb";

describe("JSON-based model-config.json storage", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-config-json-${process.pid}`);

  beforeAll(() => {
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    clearModelConfigCache();
    closeHistoryDb();
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
  });

  afterAll(() => {
    clearModelConfigCache();
    closeHistoryDb();
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
    process.env = originalEnv;
  });

  beforeEach(() => {
    clearModelConfigCache();
    closeHistoryDb();
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
  });

  it("should initialize default configuration correctly", () => {
    const config = loadModelConfig();
    expect(config).toBeDefined();
    expect(config.providers).toBeInstanceOf(Array);
    expect(config.providers.length).toBeGreaterThan(0);
    expect(config.presets.multi.length).toBeGreaterThan(0);
    expect(config.presets.single.length).toBeGreaterThan(0);
  });

  it("should add and retrieve multiple provider profiles", () => {
    const initialCount = getProviders().length;

    addProvider({
      id: "openai-test-work",
      name: "Work OpenAI Account",
      provider: "openai",
      apiKey: "sk-test-work-12345",
      baseUrl: "https://api.openai.com/v1"
    });

    addProvider({
      id: "anthropic-test-personal",
      name: "Personal Anthropic",
      provider: "anthropic",
      apiKey: "sk-ant-test-personal-999",
      baseUrl: ""
    });

    const providers = getProviders();
    expect(providers.length).toBe(initialCount + 2);

    const workProfile = providers.find(p => p.id === "openai-test-work");
    expect(workProfile).toBeDefined();
    expect(workProfile?.name).toBe("Work OpenAI Account");
    expect(workProfile?.apiKey).toBe("sk-test-work-12345");

    const personalProfile = providers.find(p => p.id === "anthropic-test-personal");
    expect(personalProfile).toBeDefined();
    expect(personalProfile?.name).toBe("Personal Anthropic");
  });

  it("should update models by tier using presets and resolve correctly in getModelInstanceForTier", () => {
    // Add custom providers first
    addProvider({
      id: "openai-work",
      name: "Work OpenAI",
      provider: "openai",
      apiKey: "sk-proj-work-abc",
    });

    addProvider({
      id: "anthropic-personal",
      name: "Personal Anthropic",
      provider: "anthropic",
      apiKey: "sk-ant-personal-xyz",
    });

    // Create and save custom multi-agent preset
    const customMultiPreset = {
      id: "test-multi-preset",
      name: "Test Multi Preset",
      description: "Uses Personal Anthropic for master and OpenAI Work for superagent/subagent",
      models: {
        master: {
          providerProfileId: "anthropic-personal",
          model: "claude-3-5-sonnet-20241022"
        },
        superagent: {
          providerProfileId: "openai-work",
          model: "gpt-4o"
        },
        subagentDefault: {
          providerProfileId: "openai-work",
          model: "gpt-4o-mini"
        },
        subagentDetails: {
          researcher: {
            providerProfileId: "anthropic-personal",
            model: "claude-3-5-haiku-20241022"
          }
        }
      }
    };

    savePreset("multi", customMultiPreset);
    setActivePresetId("multi", "test-multi-preset");

    process.env.SUPERAGENT_MULTI = "true";

    const activePreset = getActivePreset<any>("multi");
    expect(activePreset.id).toBe("test-multi-preset");

    // Verify presets resolve correctly for different tiers without exporting provider
    // credentials into process.env.
    // Master Agent
    const masterInstance = getModelInstanceForTier("master", 0, undefined, false);
    expect(masterInstance).toBeDefined();
    expect(process.env.PROVIDER_ANTHROPIC_PERSONAL_API_KEY).toBeUndefined();

    // Superagent
    const superagentInstance = getModelInstanceForTier("superagent", 1, undefined, false);
    expect(superagentInstance).toBeDefined();
    expect(process.env.PROVIDER_OPENAI_WORK_API_KEY).toBeUndefined();
  });

  it("should synchronize and persist system settings to model-config.json", async () => {
    updateSettings({
      concurrencyLimit: 1,
      rateLimitRpm: 100,
      rateLimitCapacity: 150,
    });

    await new Promise(resolve => setTimeout(resolve, 50));

    const config = loadModelConfig();
    expect(config.settings).toBeDefined();
    expect(config.settings?.concurrencyLimit).toBe(1);
    expect(config.settings?.rateLimitRpm).toBe(100);
    expect(config.settings?.rateLimitCapacity).toBe(150);
  });

  it("should ignore removed legacy settings keys without failing", () => {
    updateSettings({ focus: "medium", focusBudget: 8000 } as any);
    const settings = getSettings();
    expect((settings as any).focus).toBeUndefined();
    expect((settings as any).focusBudget).toBeUndefined();
    expect((settings as any).maxConcurrentWorkspaceTasks).toBeUndefined();
  });

  it("should handle trusted directories operations correctly", () => {
    // Initial state
    expect(getTrustedDirectories()).toEqual([]);
    expect(isDirectoryTrusted("/some/path/project1")).toBe(false);

    // Add a directory
    addTrustedDirectory("/some/path/project1");
    expect(getTrustedDirectories()).toContain(path.resolve("/some/path/project1"));
    expect(isDirectoryTrusted("/some/path/project1")).toBe(true);

    // Add a duplicate directory
    const initialLen = getTrustedDirectories().length;
    addTrustedDirectory("/some/path/project1");
    expect(getTrustedDirectories().length).toBe(initialLen);
  });
});
