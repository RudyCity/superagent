import { describe, it, expect, vi } from "vitest";
import { setupCommand } from "../src/core/commands/coreCommands.js";
import { registry } from "../src/core/commands/index.js";
import { getConfiguredProviders, shouldShowStartupPrompt } from "../src/core/config/providers.js";
import { getSettings, updateSettings } from "../src/core/config/jsonConfig.js";
import { settingStartupPromptCommand } from "../src/core/commands/settingsCommand.js";

describe("Startup Choice & Setup Wizard", () => {
  it("should have setup command registered in slash command registry", () => {
    const cmd = registry.get("setup");
    expect(cmd).toBeDefined();
    expect(cmd?.name).toBe("setup");
    expect(cmd?.description).toContain("setup wizard");
  });

  it("should activate provider setup wizard when executing setup command with wizard context", async () => {
    const setActiveWizard = vi.fn();
    const setWizardOptions = vi.fn();
    const setWizardSelectedIndex = vi.fn();
    const addLine = vi.fn();

    await setupCommand.execute("", {
      setActiveWizard,
      setWizardOptions,
      setWizardSelectedIndex,
      addLine,
    } as any);

    expect(setActiveWizard).toHaveBeenCalledWith({
      type: "login",
      step: 2,
      data: {},
    });
    expect(setWizardOptions).toHaveBeenCalled();
    const options = setWizardOptions.mock.calls[0][0];
    expect(Array.isArray(options)).toBe(true);
    expect(options.length).toBeGreaterThan(0);
    expect(setWizardSelectedIndex).toHaveBeenCalledWith(0);
  });

  it("should fall back to helpful tip when setActiveWizard is unavailable", async () => {
    const addLine = vi.fn();

    await setupCommand.execute("", {
      addLine,
    } as any);

    expect(addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system",
        content: expect.stringContaining("/login add"),
      })
    );
  });

  it("should verify getConfiguredProviders returns an array", () => {
    const providers = getConfiguredProviders();
    expect(Array.isArray(providers)).toBe(true);
  });

  it("should suppress startup prompt when skipStartupPrompt is enabled in settings", () => {
    updateSettings({ skipStartupPrompt: true });
    expect(getSettings().skipStartupPrompt).toBe(true);

    const shouldShow = shouldShowStartupPrompt({
      isQuickMode: false,
      isTTY: true,
      autoResume: false,
      isSetupArg: false,
    });

    expect(shouldShow).toBe(false);

    // Re-enable and verify it respects the toggle
    updateSettings({ skipStartupPrompt: false });
    expect(getSettings().skipStartupPrompt).toBe(false);
  });

  it("should suppress startup prompt when isSetupArg, quickMode, non-TTY, or autoResume is set", () => {
    updateSettings({ skipStartupPrompt: false });

    expect(shouldShowStartupPrompt({ isSetupArg: true })).toBe(false);
    expect(shouldShowStartupPrompt({ isQuickMode: true, isTTY: true })).toBe(false);
    expect(shouldShowStartupPrompt({ isTTY: false })).toBe(false);
    expect(shouldShowStartupPrompt({ autoResume: true, isTTY: true })).toBe(false);
  });

  it("should toggle skipStartupPrompt via /setting-startup-prompt command", () => {
    const addLine = vi.fn();
    const ctx = { addLine } as any;

    // View current status
    settingStartupPromptCommand.execute("", ctx);
    expect(addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system",
        content: expect.stringContaining("Usage: /setting-startup-prompt"),
      })
    );

    // Turn off (skip/suppress prompt)
    settingStartupPromptCommand.execute("off", ctx);
    expect(getSettings().skipStartupPrompt).toBe(true);
    expect(addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system",
        content: expect.stringContaining("OFF (skipped/suppressed)"),
      })
    );

    // Turn on (enable prompt)
    settingStartupPromptCommand.execute("on", ctx);
    expect(getSettings().skipStartupPrompt).toBe(false);
    expect(addLine).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system",
        content: expect.stringContaining("ON (enabled)"),
      })
    );
  });
});
