import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import {
  loadModelConfig,
  updateSettings,
  getSettings,
  clearModelConfigCache,
} from "../src/core/config/jsonConfig";
import { closeHistoryDb } from "../src/core/storage/historyDb";
import * as textUtils from "../src/utils/text.js";
import * as uiHelpers from "../src/utils/uiHelpers.js";
import * as chatLine from "../src/components/chat-line.js";
import { resolveSubagentTimeoutMs } from "../src/core/tools/subagentTools.js";

describe("cleanup sweep", () => {
  const originalEnv = process.env;
  const testConfigDir = path.join(os.tmpdir(), `superagent-cleanup-sweep-${process.pid}`);

  beforeAll(() => {
    process.env = { ...originalEnv, SUPERAGENT_CONFIG_DIR: testConfigDir };
    clearModelConfigCache();
    closeHistoryDb();
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
  });

  afterAll(() => {
    clearModelConfigCache();
    closeHistoryDb();
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
    process.env = originalEnv;
  });

  beforeEach(() => {
    clearModelConfigCache();
    try { fs.rmSync(testConfigDir, { recursive: true, force: true }); } catch {}
  });

  describe("legacy settings keys are tolerated and never surfaced", () => {
    it("ignores removed focus/focusBudget/maxConcurrentWorkspaceTasks on load", () => {
      updateSettings({ concurrencyLimit: 1 });
      // Simulate a legacy model-config.json that still carries removed placebo keys
      const configPath = path.join(testConfigDir, "model-config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      config.settings.focus = "high";
      config.settings.focusBudget = 8000;
      config.settings.maxConcurrentWorkspaceTasks = 5;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
      clearModelConfigCache();

      expect(() => loadModelConfig()).not.toThrow();
      const settings = getSettings() as Record<string, unknown>;
      expect(settings.concurrencyLimit).toBe(1);
      expect(settings.focus).toBeUndefined();
      expect(settings.focusBudget).toBeUndefined();
      expect(settings.maxConcurrentWorkspaceTasks).toBeUndefined();
    });
  });

  describe("subagent timeoutMs resolution", () => {
    it("enforces a 30s minimum floor", () => {
      expect(resolveSubagentTimeoutMs(1000)).toBe(30000);
      expect(resolveSubagentTimeoutMs(29999)).toBe(30000);
      expect(resolveSubagentTimeoutMs(30000)).toBe(30000);
    });

    it("honors caller values between floor and cap", () => {
      expect(resolveSubagentTimeoutMs(600000)).toBe(600000);
      expect(resolveSubagentTimeoutMs(1200000)).toBe(1200000);
    });

    it("caps at 24h", () => {
      expect(resolveSubagentTimeoutMs(24 * 60 * 60 * 1000)).toBe(24 * 60 * 60 * 1000);
      expect(resolveSubagentTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(24 * 60 * 60 * 1000);
    });

    it("returns undefined for missing/invalid values (no timeout)", () => {
      expect(resolveSubagentTimeoutMs(undefined)).toBeUndefined();
      expect(resolveSubagentTimeoutMs(0)).toBeUndefined();
      expect(resolveSubagentTimeoutMs(-5)).toBeUndefined();
      expect(resolveSubagentTimeoutMs("1000" as unknown)).toBeUndefined();
      expect(resolveSubagentTimeoutMs(Number.NaN)).toBeUndefined();
    });
  });

  describe("helper dedup — canonical module surfaces", () => {
    it("owns paste/mouse helpers exclusively in text.ts", () => {
      expect(typeof (textUtils as Record<string, unknown>).stripSgrMouseSequences).toBe("function");
      expect(typeof (textUtils as Record<string, unknown>).getInsertion).toBe("function");
      expect(typeof (textUtils as Record<string, unknown>).getPasteSplit).toBe("function");

      expect((uiHelpers as Record<string, unknown>).stripSgrMouseSequences).toBeUndefined();
      expect((uiHelpers as Record<string, unknown>).getInsertion).toBeUndefined();
      expect((uiHelpers as Record<string, unknown>).getPasteSplit).toBeUndefined();
    });

    it("owns truncateStreamDisplay exclusively in chat-line.tsx", () => {
      expect(typeof (chatLine as Record<string, unknown>).truncateStreamDisplay).toBe("function");
      expect((uiHelpers as Record<string, unknown>).truncateStreamDisplay).toBeUndefined();
    });

    it("keeps latest-action helpers only in uiHelpers.ts", () => {
      expect(typeof (uiHelpers as Record<string, unknown>).getLatestSubagentAction).toBe("function");
      expect(typeof (uiHelpers as Record<string, unknown>).getLatestSuperagentAction).toBe("function");
      expect(typeof (uiHelpers as Record<string, unknown>).getSubagentActionStreams).toBe("function");
      expect(typeof (uiHelpers as Record<string, unknown>).reconstructChatLines).toBe("function");

      expect((textUtils as Record<string, unknown>).getLatestSubagentAction).toBeUndefined();
      expect((textUtils as Record<string, unknown>).getLatestSuperagentAction).toBeUndefined();
    });
  });
});
