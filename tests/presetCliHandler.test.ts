import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handlePresetCliCommand, printPresetHelp } from "../src/core/commands/presetCliHandler.js";
import * as config from "../src/core/config.js";

describe("presetCliHandler", () => {
  let exitSpy: any;
  let logSpy: any;
  let errorSpy: any;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as any);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should display help when no args or 'help' is passed", async () => {
    await handlePresetCliCommand([]);
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockClear();
    exitSpy.mockClear();

    await handlePresetCliCommand(["help"]);
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should list available presets for multi and single modes", async () => {
    vi.spyOn(config, "getModelPresets").mockImplementation((mode) => {
      if (mode === "multi") {
        return [{ name: "dev", description: "Balanced multi dev preset", models: {} }];
      }
      return [{ name: "fast", description: "Fast single dev preset", models: {} }];
    });

    await handlePresetCliCommand(["list"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Superagent Model Presets"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should apply preset globally for multi mode by default", async () => {
    const applySpy = vi.spyOn(config, "applyModelPreset").mockImplementation(() => {});

    await handlePresetCliCommand(["use", "dev"]);
    expect(applySpy).toHaveBeenCalledWith("dev", "multi", true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should apply preset globally for single mode when --single is specified", async () => {
    const applySpy = vi.spyOn(config, "applyModelPreset").mockImplementation(() => {});

    await handlePresetCliCommand(["use", "dev", "--single"]);
    expect(applySpy).toHaveBeenCalledWith("dev", "single", true);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should show preset details", async () => {
    vi.spyOn(config, "getModelPresets").mockReturnValue([
      {
        name: "dev",
        description: "Development preset",
        models: {
          MODEL_MULTI_MASTER: "anthropic@claude-3-5-sonnet",
        },
      },
    ]);

    await handlePresetCliCommand(["show", "dev"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Preset: dev"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should error when preset name is missing", async () => {
    await handlePresetCliCommand(["use"]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Please provide a preset name"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
