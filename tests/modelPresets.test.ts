import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

// Mock os.homedir() di paling atas untuk isolasi penuh
const tempHome = path.join(process.cwd(), "tests", "temp-home-model-presets");
vi.spyOn(os, "homedir").mockReturnValue(tempHome);

import { 
  getModelPresets, 
  saveModelPreset, 
  applyModelPreset, 
  deleteModelPreset,
  updateModelPreset,
  getCustomPresetsPath,
  getRootConfigDir,
  ensureGlobalConfigDir,
  getActivePresetId
} from "../src/core/config.js";
import { handleSlashCommand, getDefaultModel } from "../src/core/slash-commands.js";
import { getModelConfigPath } from "../src/core/config/paths.js";
import { clearModelConfigCache, clearSessionActivePreset, getActivePreset } from "../src/core/config/jsonConfig.js";

const configPath = getModelConfigPath();

describe("Model Presets", () => {
  let originalEnv: NodeJS.ProcessEnv;
  const customPresetsPath = getCustomPresetsPath();
  const envPath = path.join(getRootConfigDir(), ".env");

  beforeEach(() => {
    originalEnv = { ...process.env };
    
    // Pastikan folder temp bersih total sebelum mulai
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    clearSessionActivePreset();
  });

  afterEach(() => {
    process.env = originalEnv;
    // Bersihkan folder temp setelah tes selesai
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("should retrieve model presets", () => {
    const presets = getModelPresets();
    expect(Array.isArray(presets)).toBe(true);
  });

  it("should save a custom model preset to model-presets.json", () => {
    // Write test config with models
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "openai", model: "gpt-4-test-master" },
            superagent: { providerProfileId: "openai", model: "gpt-4-test-super" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4-test-sub" },
            subagentDetails: {}
          }
        }],
        single: []
      },
      activePresetId: { multi: "test-multi", single: "" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    const savedPath = saveModelPreset("my-cool-preset", "A custom testing preset");
    expect(savedPath).toBe(customPresetsPath);
    expect(fs.existsSync(customPresetsPath)).toBe(true);

    const presets = getModelPresets();
    const myPreset = presets.find(p => p.name === "my-cool-preset");
    expect(myPreset).toBeDefined();
    expect(myPreset?.description).toBe("A custom testing preset");
    expect(myPreset?.models.MODEL_MULTI_MASTER).toContain("gpt-4-test-master");
    expect(myPreset?.models.MODEL_MULTI_SUPERAGENT).toContain("gpt-4-test-super");
  });

  it("should apply a model preset to JSON config", () => {
    // Write test config with providers
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
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

    saveModelPreset("openai-full", "OpenAI stack", {
      MODEL_MULTI_MASTER: "openai:gpt-4o",
      MODEL_MULTI_SUBAGENT: "openai:gpt-4o-mini",
    });
    applyModelPreset("openai-full");

    // Verify preset was saved
    const presets = getModelPresets();
    const appliedPreset = presets.find(p => p.name === "openai-full");
    expect(appliedPreset).toBeDefined();
    expect(appliedPreset?.models.MODEL_MULTI_MASTER).toBe("openai:gpt-4o");
    expect(appliedPreset?.models.MODEL_MULTI_SUBAGENT).toBe("openai:gpt-4o-mini");
    expect(getActivePresetId("multi")).toBe("openai-full");
  });

  it("should apply a model preset in-memory by default and to disk only when persist is true", () => {
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
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
      activePresetId: { multi: "test-multi", single: "test-single" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    saveModelPreset("openai-session", "OpenAI session stack", {
      MODEL_MULTI_MASTER: "openai:gpt-4-session",
      MODEL_MULTI_SUBAGENT: "openai:gpt-4o-mini",
    });

    // 1. Apply without persisting (persist = false)
    applyModelPreset("openai-session", "multi", false);

    // Verify it is active in session memory
    expect(getActivePresetId("multi")).toBe("openai-session");
    expect(getActivePreset<any>("multi")?.models.master.model).toBe("gpt-4-session");

    // But verify it is NOT written to activePresetId on disk
    const diskConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(diskConfig.activePresetId.multi).toBe("test-multi");

    // 2. Apply with persisting (persist = true)
    applyModelPreset("openai-session", "multi", true);
    
    // Verify it is now updated on disk
    const updatedDiskConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    expect(updatedDiskConfig.activePresetId.multi).toBe("openai-session");
  });

  it("should execute slash commands for listing, saving and loading presets", () => {
    // Tulis config tiruan dengan provider 'openai' dan active preset
    const testConfig = {
      settings: { concurrencyLimit: 0, rateLimitRpm: 60, rateLimitCapacity: 60 },
      providers: [
        { id: "openai", name: "OpenAI", provider: "openai", apiKey: "sk-test", baseUrl: "" }
      ],
      presets: {
        multi: [{
          id: "test-multi",
          name: "Test Multi",
          description: "Test",
          models: {
            master: { providerProfileId: "openai", model: "test-slash-model" },
            superagent: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }],
        single: [{
          id: "test-single",
          name: "Test Single",
          description: "Test single preset",
          models: {
            superagent: { providerProfileId: "openai", model: "test-slash-model" },
            subagentDefault: { providerProfileId: "openai", model: "gpt-4o" },
            subagentDetails: {}
          }
        }]
      },
      activePresetId: { multi: "test-multi", single: "test-single" }
    };
    fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2), "utf-8");
    clearModelConfigCache();

    const addedLines: any[] = [];
    let currentLimit = 0;
    let activeModel = "";

    const mockCtx = {
      addLine: (line: any) => {
        addedLines.push(line);
      },
      exit: () => {},
      agent: null,
      setContextLimit: (limit: number) => {
        currentLimit = limit;
      },
      setActiveModel: (model: string) => {
        activeModel = model;
      }
    };

    // 1. List presets
    handleSlashCommand("/model preset list", mockCtx);
    expect(addedLines.length).toBe(1);
    expect(addedLines[0].content).toContain("Available Model Presets");

    // 2. Save custom preset (now also auto-applies)
    process.env.MODEL = "openai:test-slash-model";
    process.env.MODEL_MULTI_MASTER = "openai:test-slash-model";
    handleSlashCommand("/model preset save test-slash A preset from slash command", mockCtx);
    expect(addedLines.length).toBe(2);
    expect(addedLines[1].content).toContain('saved & applied successfully');

    // 3. Load/apply custom preset
    handleSlashCommand("/model preset test-slash", mockCtx);
    expect(addedLines.length).toBe(3);
    expect(addedLines[2].content).toContain('Model preset "test-slash" applied successfully');
    expect(process.env.MODEL).toBe("openai:test-slash-model");
  });

  it("should update a custom model preset", () => {
    saveModelPreset("my-update-preset", "Original description", { MODEL: "openai:gpt-4-test", MODEL_MULTI_MASTER: "openai:gpt-4-test" });

    const path = updateModelPreset("my-update-preset", "Updated description", { MODEL: "openai:gpt-4-updated" });
    expect(fs.existsSync(path)).toBe(true);

    const presets = getModelPresets();
    const myPreset = presets.find(p => p.name === "my-update-preset");
    expect(myPreset).toBeDefined();
    expect(myPreset?.description).toBe("Updated description");
    expect(myPreset?.models.MODEL).toBe("openai:gpt-4-updated");
  });

  it("should delete a custom model preset", () => {
    saveModelPreset("my-delete-preset", "Delete me", { MODEL: "openai:gpt-4-test", MODEL_MULTI_MASTER: "openai:gpt-4-test" });

    const presetsBefore = getModelPresets();
    expect(presetsBefore.some(p => p.name === "my-delete-preset")).toBe(true);

    const path = deleteModelPreset("my-delete-preset");
    expect(fs.existsSync(path)).toBe(true);

    const presetsAfter = getModelPresets();
    expect(presetsAfter.some(p => p.name === "my-delete-preset")).toBe(false);
  });

  it("should save a custom model preset with explicit models argument", () => {
    const customModels = {
      MODEL: "openai:gpt-4-explicit",
      MODEL_MULTI_MASTER: "openai:gpt-4-explicit-master",
    };
    saveModelPreset("explicit-preset", "Explicit description", customModels);
    
    const presets = getModelPresets();
    const myPreset = presets.find(p => p.name === "explicit-preset");
    expect(myPreset).toBeDefined();
    expect(myPreset?.description).toBe("Explicit description");
    expect(myPreset?.models.MODEL).toBe("openai:gpt-4-explicit");
    expect(myPreset?.models.MODEL_MULTI_MASTER).toBe("openai:gpt-4-explicit-master");
  });

  it("should retrieve custom provider profile credentials from model-config.json when resolving model instance", async () => {
    const { loadModelConfig, saveModelConfig } = await import("../src/core/config/jsonConfig.js");
    const { getModelInstanceForString } = await import("../src/core/config/models.js");
    const originalConfig = loadModelConfig();

    const testConfig = {
      ...originalConfig,
      providers: [
        ...originalConfig.providers,
        {
          id: "uuuu",
          name: "uuuu",
          provider: "openrouter",
          apiKey: "test-api-key-value-from-json",
          baseUrl: "https://openrouter.ai/api/v1",
        }
      ]
    };

    saveModelConfig(testConfig);

    // Call getModelInstanceForString with a model that uses the "uuuu" prefix
    // In a test environment, vitest mock/CI might run check. So we set process.env.VITEST to override checking or use SUPERAGENT_FORCE_VAL_CHECK
    // Let's call getModelInstanceForString directly and mock createOpenAI/createAnthropic if needed, or check if it throws/returns.
    // Actually, getModelInstanceForString parses/creates a provider client. If we pass "uuuu:google/gemini-2.5-flash", it will create the OpenAI/OpenRouter client.
    // Let's spy on or verify it configures the right key. Since createOpenAI is imported, we can just verify that it doesn't throw "API key is missing".
    // Wait, the API key verification checks if apiKey is missing or "dummy". If it finds "test-api-key-value-from-json", it will proceed to createOpenAI.
    // Let's call it and verify it doesn't throw API key missing. (It might throw a fetch/network error or succeed, but not throw API key missing).
    
    let error: any = null;
    try {
      getModelInstanceForString("uuuu:google/gemini-2.5-flash");
    } catch (e: any) {
      error = e;
    }

    // It should NOT throw "API key is missing or not configured."
    if (error) {
      expect(error.message).not.toContain("API key is missing or not configured");
    }

    // Clean up
    saveModelConfig(originalConfig);
  });
});
