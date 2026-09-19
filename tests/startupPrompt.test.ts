import { describe, it, expect, vi } from "vitest";
import { setupCommand } from "../src/core/commands/coreCommands.js";
import { registry } from "../src/core/commands/index.js";
import { getConfiguredProviders } from "../src/core/config/providers.js";

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
});
