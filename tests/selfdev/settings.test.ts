import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { normalizeSelfDevConfig } from "../../src/core/config/selfdevConfig.js";
import { clearModelConfigCache, getSettings, updateSettings } from "../../src/core/config/jsonConfig.js";
import { getSelfDevConfig, updateSelfDevConfig } from "../../src/core/selfdev/settings.js";

let isolatedRoot = "";
const prevConfigDir = process.env.SUPERAGENT_CONFIG_DIR;

afterEach(() => {
  clearModelConfigCache();
  if (isolatedRoot && fs.existsSync(isolatedRoot)) {
    try {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    } catch {}
  }
  isolatedRoot = "";
  if (prevConfigDir !== undefined) {
    process.env.SUPERAGENT_CONFIG_DIR = prevConfigDir;
  } else {
    delete process.env.SUPERAGENT_CONFIG_DIR;
  }
});

describe("selfdev JSON settings", () => {
  it("loads invalid JSON booleans fail-closed and persists normalized settings", () => {
    isolatedRoot = fs.mkdtempSync(path.resolve("tests/selfdev/.settings-"));
    process.env.SUPERAGENT_CONFIG_DIR = isolatedRoot;
    fs.writeFileSync(path.join(isolatedRoot, "model-config.json"), JSON.stringify({
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
    expect(JSON.parse(fs.readFileSync(path.join(isolatedRoot, "model-config.json"), "utf8")).settings.selfdev.enabled).toBe(true);
  });
  for (const value of ["false", 0, null, {}, []]) {
    it(`rejects invalid boolean ${JSON.stringify(value)}`, () => {
      expect(normalizeSelfDevConfig({ enabled: true, collectionEnabled: value }).enabled).toBe(false);
    });
  }
  it("clamps numeric limits and cannot disable mandatory redaction", () => {
    expect(normalizeSelfDevConfig({ enabled: true, maxBatchSize: Infinity, maxEventsPerWorkspace: 99999, maxLessons: -4, redactSecrets: false }))
      .toMatchObject({ enabled: true, maxBatchSize: 100, maxEventsPerWorkspace: 5000, maxLessons: 1, redactSecrets: true });
    expect(normalizeSelfDevConfig(undefined).enabled).toBe(false);
  });
});
