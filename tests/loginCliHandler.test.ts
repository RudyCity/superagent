import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleLoginCliCommand, printLoginHelp } from "../src/core/commands/loginCliHandler.js";
import * as config from "../src/core/config.js";

describe("loginCliHandler", () => {
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
    await handleLoginCliCommand([]);
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockClear();
    exitSpy.mockClear();

    await handleLoginCliCommand(["help"]);
    expect(logSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should list configured providers", async () => {
    vi.spyOn(config, "getConfiguredProviders").mockReturnValue([
      {
        id: "openrouter",
        name: "openrouter",
        type: "openrouter",
        apiKey: "sk-or-v1-1234567890",
        baseUrl: "https://openrouter.ai/api/v1",
        isActive: true,
      },
    ]);

    await handleLoginCliCommand(["list"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Configured Providers"));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should add a provider with explicit name and key", async () => {
    const addProviderSpy = vi.spyOn(config, "addProvider").mockImplementation(() => {});
    const switchProviderSpy = vi.spyOn(config, "switchActiveProvider").mockImplementation(() => {});

    await handleLoginCliCommand(["add", "openrouter", "sk-or-v1-mysecretkey"]);

    expect(addProviderSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: "openrouter",
      name: "openrouter",
      provider: "openrouter",
      apiKey: "sk-or-v1-mysecretkey",
    }));
    expect(switchProviderSpy).toHaveBeenCalledWith("openrouter");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should auto-detect provider type from key prefix", async () => {
    const addProviderSpy = vi.spyOn(config, "addProvider").mockImplementation(() => {});
    const switchProviderSpy = vi.spyOn(config, "switchActiveProvider").mockImplementation(() => {});

    await handleLoginCliCommand(["add", "sk-ant-api03-testkey"]);

    expect(addProviderSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: "anthropic",
      provider: "anthropic",
      apiKey: "sk-ant-api03-testkey",
    }));
    expect(switchProviderSpy).toHaveBeenCalledWith("anthropic");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should add custom endpoint provider", async () => {
    const addProviderSpy = vi.spyOn(config, "addProvider").mockImplementation(() => {});
    const switchProviderSpy = vi.spyOn(config, "switchActiveProvider").mockImplementation(() => {});

    await handleLoginCliCommand(["add", "custom", "http://localhost:8000/v1", "sk-my-custom-key"]);

    expect(addProviderSpy).toHaveBeenCalledWith(expect.objectContaining({
      id: "custom",
      provider: "custom",
      baseUrl: "http://localhost:8000/v1",
      apiKey: "sk-my-custom-key",
    }));
    expect(switchProviderSpy).toHaveBeenCalledWith("custom");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should switch active provider with 'use'", async () => {
    vi.spyOn(config, "getProviders").mockReturnValue([
      { id: "my-openai", name: "OpenAI", provider: "openai", apiKey: "sk-123" },
    ]);
    const switchSpy = vi.spyOn(config, "switchActiveProvider").mockImplementation(() => {});

    await handleLoginCliCommand(["use", "my-openai"]);

    expect(switchSpy).toHaveBeenCalledWith("my-openai");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("should remove provider with 'remove'", async () => {
    vi.spyOn(config, "getProviders").mockReturnValue([
      { id: "old-prov", name: "Old", provider: "openai", apiKey: "sk-123" },
    ]);
    const removeSpy = vi.spyOn(config, "removeProvider").mockImplementation(() => {});

    await handleLoginCliCommand(["remove", "old-prov"]);

    expect(removeSpy).toHaveBeenCalledWith("old-prov");
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});
