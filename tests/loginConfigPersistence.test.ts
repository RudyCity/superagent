import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

const tempHome = path.join(process.cwd(), "tests", "temp-home-login-persistence");

import {
  loadModelConfig,
  saveModelConfig,
  addProvider,
  getProviders,
  clearModelConfigCache,
} from "../src/core/config/jsonConfig.js";
import { getModelConfigPath, ensureGlobalConfigDir } from "../src/core/config/paths.js";
import {
  switchActiveProvider,
  getConfiguredProviders,
  setAllTierModels,
} from "../src/core/config/providers.js";
import {
  getOrCreateMasterKey,
  _resetSecretStoreForTests,
  encryptSecret,
  decryptSecret,
} from "../src/core/config/secretStore.js";

describe("Login Configuration Persistence & Defensive Credentials Retention", () => {
  let originalProcessEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    originalProcessEnv = { ...process.env };
    process.env.SUPERAGENT_CONFIG_DIR = tempHome;

    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    ensureGlobalConfigDir();
    _resetSecretStoreForTests();
    clearModelConfigCache();
  });

  afterEach(() => {
    process.env = originalProcessEnv;
    if (fs.existsSync(tempHome)) {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
    _resetSecretStoreForTests();
    clearModelConfigCache();
  });

  it("should create .secret-key and .secret-key.bak, and restore from backup if primary is deleted", () => {
    const key1 = getOrCreateMasterKey();
    expect(key1).toBeDefined();
    expect(key1.length).toBe(32);

    const keyPath = path.join(tempHome, ".secret-key");
    const bakPath = path.join(tempHome, ".secret-key.bak");
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.existsSync(bakPath)).toBe(true);

    // Delete primary key to simulate crash or deletion
    fs.unlinkSync(keyPath);
    expect(fs.existsSync(keyPath)).toBe(false);

    // Reset memory cache
    _resetSecretStoreForTests();

    // Call getOrCreateMasterKey again: should restore from .secret-key.bak instead of regenerating
    const key2 = getOrCreateMasterKey();
    expect(key2.toString("hex")).toBe(key1.toString("hex"));
    expect(fs.existsSync(keyPath)).toBe(true);
  });

  it("should preserve on-disk apiKey when saving an in-memory provider that has empty apiKey", () => {
    addProvider({
      id: "my-provider",
      name: "My Provider",
      provider: "openrouter",
      apiKey: "sk-or-real-api-key-12345",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    clearModelConfigCache();
    const configOnDisk = loadModelConfig();
    const p1 = configOnDisk.providers.find((p) => p.id === "my-provider");
    expect(p1?.apiKey).toBe("sk-or-real-api-key-12345");

    // Simulate an in-memory snapshot where apiKey was blanked
    const modifiedConfig = JSON.parse(JSON.stringify(configOnDisk));
    const targetProvider = modifiedConfig.providers.find((p: any) => p.id === "my-provider");
    targetProvider.apiKey = "";

    // Save with mergeProviders: true (default)
    saveModelConfig(modifiedConfig);

    clearModelConfigCache();
    const reloaded = loadModelConfig();
    const p2 = reloaded.providers.find((p) => p.id === "my-provider");
    // On-disk non-empty key must be preserved!
    expect(p2?.apiKey).toBe("sk-or-real-api-key-12345");
  });

  it("should auto-recover provider keys from .corrupt backup if live file lost keys", () => {
    addProvider({
      id: "recoverable-provider",
      name: "Recoverable Provider",
      provider: "openai",
      apiKey: "sk-proj-super-secret-key",
      baseUrl: "https://api.openai.com/v1",
    });

    const configPath = getModelConfigPath();
    // Create a backup file representing a previous valid state
    const corruptBackupPath = configPath + ".corrupt-" + Date.now();
    fs.copyFileSync(configPath, corruptBackupPath);

    // Now corrupt the live file by emptying all keys
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    for (const p of raw.providers) {
      p.apiKey = "";
    }
    fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), "utf-8");

    clearModelConfigCache();
    // Loading config should detect that all providers lost keys and restore from backup
    const loaded = loadModelConfig();
    const recovered = loaded.providers.find((p) => p.id === "recoverable-provider");
    expect(recovered?.apiKey).toBe("sk-proj-super-secret-key");
  });

  it("should properly update active preset tiers when switchActiveProvider is called", () => {
    addProvider({
      id: "test-provider-switch",
      name: "Test Provider Switch",
      provider: "openrouter",
      apiKey: "sk-test-key",
      baseUrl: "https://openrouter.ai/api/v1",
    });

    const switched = switchActiveProvider("test-provider-switch");
    expect(switched).toBe(true);

    clearModelConfigCache();
    const configured = getConfiguredProviders();
    const active = configured.find((p) => p.id === "test-provider-switch");
    expect(active?.isActive).toBe(true);
    expect(active?.hasValidKey).toBe(true);
  });
});
