import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeSelfDevConfig } from "../../src/core/config/selfdevConfig.js";

const isolated = vi.hoisted(() => ({ root: "" }));
vi.mock("../../src/core/config/paths.js", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/core/config/paths.js")>();
  return { ...original, getRootConfigDir: () => isolated.root, getGlobalConfigDir: () => isolated.root,
    getModelConfigPath: () => `${isolated.root}/model-config.json`, ensureGlobalConfigDir: () => {} };
});
import { clearModelConfigCache, getSettings, updateSettings } from "../../src/core/config/jsonConfig.js";
import { getSelfDevConfig, updateSelfDevConfig } from "../../src/core/selfdev/settings.js";

afterEach(() => { clearModelConfigCache(); if (isolated.root) fs.rmSync(isolated.root, { recursive: true, force: true }); isolated.root = ""; });

describe("selfdev JSON settings", () => {
  it("loads invalid JSON booleans fail-closed and persists normalized settings", () => {
    isolated.root = fs.mkdtempSync(path.resolve("tests/selfdev/.settings-"));
    fs.writeFileSync(path.join(isolated.root, "model-config.json"), JSON.stringify({
      version: 1, providers: [], presets: { multi: {}, single: {} }, activePresetId: { multi: "", single: "" },
      settings: { selfdev: { enabled: "true", collectionEnabled: true } },
    }));
    clearModelConfigCache();
    expect(getSettings().selfdev?.enabled).toBe(false);
    expect(getSelfDevConfig().enabled).toBe(false);
    updateSettings({ concurrencyLimit: 3 });
    updateSelfDevConfig({ enabled: true, maxEventsPerWorkspace: 2 });
    clearModelConfigCache();
    expect(getSelfDevConfig()).toMatchObject({ enabled: true, maxEventsPerWorkspace: 2, redactSecrets: true });
    expect(getSettings().concurrencyLimit).toBe(3);
    expect(JSON.parse(fs.readFileSync(path.join(isolated.root, "model-config.json"), "utf8")).settings.selfdev.enabled).toBe(true);
  });
  it.each(["false", 0, null, {}, []])("rejects invalid boolean %j", value => {
    expect(normalizeSelfDevConfig({ enabled: true, collectionEnabled: value }).enabled).toBe(false);
  });
  it("clamps numeric limits and cannot disable mandatory redaction", () => {
    expect(normalizeSelfDevConfig({ enabled: true, maxBatchSize: Infinity, maxEventsPerWorkspace: 99999, maxLessons: -4, redactSecrets: false }))
      .toMatchObject({ enabled: true, maxBatchSize: 100, maxEventsPerWorkspace: 5000, maxLessons: 1, redactSecrets: true });
    expect(normalizeSelfDevConfig(undefined).enabled).toBe(false);
  });
});
