import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { 
  getModelPresets, 
  saveModelPreset, 
  applyModelPreset, 
  deleteModelPreset,
  updateModelPreset,
  getCustomPresetsPath,
  getRootConfigDir,
  ensureGlobalConfigDir
} from "../src/core/config.js";
import { handleSlashCommand, getDefaultModel } from "../src/core/slash-commands.js";

describe("Model Presets", () => {
  let originalEnv: NodeJS.ProcessEnv;
  const customPresetsPath = getCustomPresetsPath();
  const envPath = path.join(getRootConfigDir(), ".env");

  let originalPresetsContent: string | null = null;
  let originalEnvContent: string | null = null;

  beforeEach(() => {
    originalEnv = { ...process.env };
    ensureGlobalConfigDir();

    // Backup existing custom presets and .env
    if (fs.existsSync(customPresetsPath)) {
      originalPresetsContent = fs.readFileSync(customPresetsPath, "utf-8");
      fs.unlinkSync(customPresetsPath);
    }
    if (fs.existsSync(envPath)) {
      originalEnvContent = fs.readFileSync(envPath, "utf-8");
    }
  });

  afterEach(() => {
    process.env = originalEnv;

    // Restore original custom presets and .env
    if (originalPresetsContent !== null) {
      fs.writeFileSync(customPresetsPath, originalPresetsContent, "utf-8");
    } else {
      if (fs.existsSync(customPresetsPath)) {
        fs.unlinkSync(customPresetsPath);
      }
    }

    if (originalEnvContent !== null) {
      fs.writeFileSync(envPath, originalEnvContent, "utf-8");
    } else {
      if (fs.existsSync(envPath)) {
        fs.unlinkSync(envPath);
      }
    }
  });

  it("should retrieve built-in model presets", () => {
    const presets = getModelPresets();
    expect(presets.length).toBeGreaterThanOrEqual(5);
    const names = presets.map(p => p.name);
    expect(names).toContain("balanced");
    expect(names).toContain("openai-full");
    expect(names).toContain("anthropic-full");
    expect(names).toContain("gemini-full");
    expect(names).toContain("fast-cheap");
  });

  it("should save a custom model preset to model-presets.json", () => {
    process.env.MODEL = "openai:gpt-4-test";
    process.env.MODEL_DEPTH_0 = "openai:gpt-4-test-master";
    process.env.MODEL_DEPTH_1 = "openai:gpt-4-test-super";

    const savedPath = saveModelPreset("my-cool-preset", "A custom testing preset");
    expect(savedPath).toBe(customPresetsPath);
    expect(fs.existsSync(customPresetsPath)).toBe(true);

    const presets = getModelPresets();
    const myPreset = presets.find(p => p.name === "my-cool-preset");
    expect(myPreset).toBeDefined();
    expect(myPreset?.description).toBe("A custom testing preset");
    expect(myPreset?.models.MODEL).toBe("openai:gpt-4-test");
    expect(myPreset?.models.MODEL_DEPTH_0).toBe("openai:gpt-4-test-master");
    expect(myPreset?.models.MODEL_DEPTH_1).toBe("openai:gpt-4-test-super");
  });

  it("should apply a model preset to env variables and write to .env", () => {
    const envPath = applyModelPreset("openai-full");

    expect(process.env.MODEL).toBe("openai:gpt-4o");
    expect(process.env.MODEL_DEPTH_0).toBe("openai:gpt-4o");
    expect(process.env.MODEL_DEPTH_2).toBe("openai:gpt-4o-mini");
    expect(process.env.ACTIVE_PROVIDER).toBe("openai");

    const content = fs.readFileSync(envPath, "utf-8");
    expect(content).toContain("MODEL=openai:gpt-4o");
    expect(content).toContain("MODEL_DEPTH_0=openai:gpt-4o");
    expect(content).toContain("MODEL_DEPTH_2=openai:gpt-4o-mini");
    expect(content).toContain("ACTIVE_PROVIDER=openai");
  });

  it("should execute slash commands for listing, saving and loading presets", () => {
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
    expect(addedLines[0].content).toContain("balanced");

    // 2. Save custom preset
    process.env.MODEL = "openai:test-slash-model";
    handleSlashCommand("/model preset save test-slash A preset from slash command", mockCtx);
    expect(addedLines.length).toBe(2);
    expect(addedLines[1].content).toContain('Model configuration saved successfully as preset "test-slash"');

    // 3. Load/apply custom preset
    handleSlashCommand("/model preset test-slash", mockCtx);
    expect(addedLines.length).toBe(3);
    expect(addedLines[2].content).toContain('Model preset "test-slash" applied successfully');
    expect(process.env.MODEL).toBe("openai:test-slash-model");
  });

  it("should update a custom model preset", () => {
    process.env.MODEL = "openai:gpt-4-test";
    saveModelPreset("my-update-preset", "Original description");

    const path = updateModelPreset("my-update-preset", "Updated description", { MODEL: "openai:gpt-4-updated" });
    expect(fs.existsSync(path)).toBe(true);

    const presets = getModelPresets();
    const myPreset = presets.find(p => p.name === "my-update-preset");
    expect(myPreset).toBeDefined();
    expect(myPreset?.description).toBe("Updated description");
    expect(myPreset?.models.MODEL).toBe("openai:gpt-4-updated");
  });

  it("should delete a custom model preset", () => {
    process.env.MODEL = "openai:gpt-4-test";
    saveModelPreset("my-delete-preset", "Delete me");

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
      MODEL_DEPTH_0: "openai:gpt-4-explicit-master",
    };
    saveModelPreset("explicit-preset", "Explicit description", customModels);
    
    const presets = getModelPresets();
    const myPreset = presets.find(p => p.name === "explicit-preset");
    expect(myPreset).toBeDefined();
    expect(myPreset?.description).toBe("Explicit description");
    expect(myPreset?.models.MODEL).toBe("openai:gpt-4-explicit");
    expect(myPreset?.models.MODEL_DEPTH_0).toBe("openai:gpt-4-explicit-master");
  });
});
