import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getGlobalConfigDir, getContextWindowLimit, getConfig } from "./config.js";

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
