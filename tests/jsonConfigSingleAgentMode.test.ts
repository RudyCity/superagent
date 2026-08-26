/**
 * Regression test for the H4 audit fix.
 *
 * The single-agent-mode flag is now stored in
 * `~/.superagent-r/model-config.json` (via the `singleAgentMode` field
 * in SystemSettings) and read/written through `getSingleAgentMode()` /
 * `setSingleAgentMode()`. The legacy `process.env.SINGLE_AGENT_MODE`
 * value is still honored as a *fallback* when the JSON field is unset
 * (so existing CI scripts keep working), but new code MUST persist the
 * value to JSON.
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import {
  getSingleAgentMode,
  setSingleAgentMode,
  getSettings,
  updateSettings,
} from "../src/core/config/jsonConfig.js";
import { loadModelConfig, saveModelConfig } from "../src/core/config/jsonConfig.js";

describe("getSingleAgentMode / setSingleAgentMode (H4)", () => {
  const origEnv = process.env.SINGLE_AGENT_MODE;
  // Snapshot the settings so we can restore at the end and not pollute
  // the real ~/.superagent-r/model-config.json used by the live CLI.
  let snapshot: any;
  beforeEach(() => {
    const cfg = loadModelConfig();
    snapshot = cfg.settings ? { ...cfg.settings } : null;
    // Start each test from a clean slate (no JSON field set) so the
    // legacy env fallback path is exercised.
    if (cfg.settings) {
      delete cfg.settings.singleAgentMode;
      saveModelConfig(cfg);
    }
  });
  afterAll(() => {
    if (origEnv === undefined) delete process.env.SINGLE_AGENT_MODE;
    else process.env.SINGLE_AGENT_MODE = origEnv;
    // Restore the original settings so we don't leak state.
    if (snapshot) {
      const cfg = loadModelConfig();
      cfg.settings = snapshot;
      saveModelConfig(cfg);
    } else {
      const cfg = loadModelConfig();
      if (cfg.settings) {
        delete cfg.settings.singleAgentMode;
        saveModelConfig(cfg);
      }
    }
  });

  it("falls back to process.env.SINGLE_AGENT_MODE when JSON field is unset", () => {
    delete process.env.SINGLE_AGENT_MODE;
    expect(getSingleAgentMode()).toBe(false);
    process.env.SINGLE_AGENT_MODE = "1";
    expect(getSingleAgentMode()).toBe(true);
    process.env.SINGLE_AGENT_MODE = "0";
    expect(getSingleAgentMode()).toBe(false);
  });

  it("setSingleAgentMode persists to JSON and overrides the env fallback", () => {
    process.env.SINGLE_AGENT_MODE = "0";
    setSingleAgentMode(true);
    expect(getSingleAgentMode()).toBe(true);
    // Even when env is set the other way, the JSON value wins.
    process.env.SINGLE_AGENT_MODE = "1";
    setSingleAgentMode(false);
    expect(getSingleAgentMode()).toBe(false);
  });

  it("getSingleAgentMode coerces truthy/falsy values to boolean", () => {
    updateSettings({ singleAgentMode: "yes" as any });
    expect(getSingleAgentMode()).toBe(true);
    updateSettings({ singleAgentMode: 0 as any });
    expect(getSingleAgentMode()).toBe(false);
  });

  it("is reflected in getSettings() output", () => {
    setSingleAgentMode(true);
    expect(getSettings().singleAgentMode).toBe(true);
    setSingleAgentMode(false);
    expect(getSettings().singleAgentMode).toBe(false);
  });
});
