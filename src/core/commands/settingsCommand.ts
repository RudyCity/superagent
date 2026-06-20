import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { getSettings, updateSettings } from "../config.js";

// /settings command — show all settings from JSON config
export const settingsCommand: SlashCommand = {
  name: "settings",
  description: "Show current settings (rate limit, concurrency, streaming, etc.)",
  execute(args, ctx) {
    const s = getSettings();
    ctx.addLine({
      type: "system",
      content: [
        "┌───[ ⚙️ SUPERAGENT SETTINGS ]",
        "│ ",
        `│ • Concurrency Limit  : ${s.concurrencyLimit === 1 ? "1 (enabled)" : "0 (disabled)"}`,
        `│ • Rate Limit (RPM)   : ${s.rateLimitRpm === 0 ? "0 (disabled)" : `${s.rateLimitRpm} RPM`}`,
        `│ • Limit Capacity     : ${s.rateLimitCapacity}`,
        `│ • Streaming          : ${s.disableStreaming ? "DISABLED" : "ENABLED"}`,
        `│ • Context Window     : ${s.contextWindowLimit > 0 ? `${s.contextWindowLimit} tokens` : "auto (model default)"}`,
        `│ • Max Iterations     : ${s.maxIterations}`,
        "│ ",
        "└─────────────────────────────────",
        "Configure these settings using:",
        "  /setting-concurrency <0|1>",
        "  /setting-rpm <number>",
        "  /setting-capacity <number>",
        "  /setting-streaming <on|off>",
        "  /setting-context-limit <number>",
        "  /setting-max-iterations <number>"
      ].join("\n"),
      timestamp: Date.now(),
    });
  }
};

// /setting-concurrency command
export const settingConcurrencyCommand: SlashCommand = {
  name: "setting-concurrency",
  description: "Set LLM concurrency limit",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-concurrency <0|1>\nCurrent value: ${getSettings().concurrencyLimit === 1 ? "1 (enabled)" : "0 (disabled)"}`,
        timestamp: now,
      });
      return;
    }
    if (val !== "0" && val !== "1") {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be 0 (disabled) or 1 (enabled).",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ concurrencyLimit: parseInt(val, 10) });
      ctx.addLine({
        type: "system",
        content: `✓ Concurrency limit set to: ${val === "1" ? "1 (enabled)" : "0 (disabled)"}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /setting-rpm command
export const settingRpmCommand: SlashCommand = {
  name: "setting-rpm",
  description: "Set rate limit RPM",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-rpm <number>\nCurrent value: ${getSettings().rateLimitRpm}`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 0) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a non-negative integer.",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ rateLimitRpm: num });
      ctx.addLine({
        type: "system",
        content: `✓ Rate limit set to: ${val === "0" ? "0 (disabled)" : `${val} RPM`}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /setting-capacity command
export const settingCapacityCommand: SlashCommand = {
  name: "setting-capacity",
  description: "Set rate limit capacity",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-capacity <number>\nCurrent value: ${getSettings().rateLimitCapacity}`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num <= 0) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a positive integer.",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ rateLimitCapacity: num });
      ctx.addLine({
        type: "system",
        content: `✓ Rate limit capacity set to: ${val}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /setting-streaming command
export const settingStreamingCommand: SlashCommand = {
  name: "setting-streaming",
  description: "Enable or disable streaming",
  execute(args, ctx) {
    const val = args.trim().toLowerCase();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-streaming <on|off>\nCurrent value: ${getSettings().disableStreaming ? "DISABLED" : "ENABLED"}`,
        timestamp: now,
      });
      return;
    }
    if (val !== "on" && val !== "off" && val !== "true" && val !== "false" && val !== "enable" && val !== "disable") {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Use 'on' or 'off'.",
        timestamp: now,
      });
      return;
    }
    const disabled = val === "off" || val === "false" || val === "disable";
    try {
      updateSettings({ disableStreaming: disabled });
      ctx.addLine({
        type: "system",
        content: `✓ Streaming set to: ${disabled ? "DISABLED" : "ENABLED"}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /setting-context-limit command
export const settingContextLimitCommand: SlashCommand = {
  name: "setting-context-limit",
  description: "Set custom context window limit (0 = auto)",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      const current = getSettings().contextWindowLimit;
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-context-limit <number> (0 = auto/model default)\nCurrent value: ${current > 0 ? `${current} tokens` : "auto"}`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 0) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a non-negative integer (0 = auto).",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ contextWindowLimit: num });
      ctx.addLine({
        type: "system",
        content: `✓ Context window limit set to: ${num > 0 ? `${num} tokens` : "auto (model default)"}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

// /setting-max-iterations command
export const settingMaxIterationsCommand: SlashCommand = {
  name: "setting-max-iterations",
  description: "Set max agent loop iterations",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-max-iterations <number>\nCurrent value: ${getSettings().maxIterations}`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 1) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a positive integer (minimum 1).",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ maxIterations: num });
      ctx.addLine({
        type: "system",
        content: `✓ Max iterations set to: ${num}`,
        timestamp: now,
      });
    } catch (err: any) {
      ctx.addLine({
        type: "error",
        content: `Failed to save setting: ${err.message}`,
        timestamp: now,
      });
    }
  }
};

registry.register(settingsCommand);
registry.register(settingConcurrencyCommand);
registry.register(settingRpmCommand);
registry.register(settingCapacityCommand);
registry.register(settingStreamingCommand);
registry.register(settingContextLimitCommand);
registry.register(settingMaxIterationsCommand);
