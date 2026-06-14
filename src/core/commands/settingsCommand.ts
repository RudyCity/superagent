import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { updateEnvFile } from "../config.js";

// /settings command
export const settingsCommand: SlashCommand = {
  name: "settings",
  description: "Show current rate limit & concurrency settings",
  execute(args, ctx) {
    const concurrency = process.env.SUPERAGENT_MAX_CONCURRENCY || "0 (disabled)";
    const rpm = process.env.SUPERAGENT_RATE_LIMIT_RPM || "60";
    const capacity = process.env.SUPERAGENT_RATE_LIMIT_CAPACITY || "60";
    ctx.addLine({
      type: "system",
      content: [
        "┌───[ ⚙️ SUPERAGENT SETTINGS ]",
        "│ ",
        `│ • Concurrency Limit : ${concurrency === "1" ? "1 (enabled)" : "0 (disabled)"}`,
        `│ • Rate Limit (RPM)  : ${rpm === "0" ? "0 (disabled)" : `${rpm} RPM`}`,
        `│ • Limit Capacity    : ${capacity}`,
        "│ ",
        "└─────────────────────────────",
        "Configure these settings using:",
        "  /setting-concurrency <0|1>",
        "  /setting-rpm <number>",
        "  /setting-capacity <number>"
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
        content: `Usage: /setting-concurrency <0|1>\nCurrent value: ${process.env.SUPERAGENT_MAX_CONCURRENCY || "0 (disabled)"}`,
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
      updateEnvFile({ SUPERAGENT_MAX_CONCURRENCY: val });
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
        content: `Usage: /setting-rpm <number>\nCurrent value: ${process.env.SUPERAGENT_RATE_LIMIT_RPM || "60"}`,
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
      updateEnvFile({ SUPERAGENT_RATE_LIMIT_RPM: val });
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
        content: `Usage: /setting-capacity <number>\nCurrent value: ${process.env.SUPERAGENT_RATE_LIMIT_CAPACITY || "60"}`,
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
      updateEnvFile({ SUPERAGENT_RATE_LIMIT_CAPACITY: val });
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

registry.register(settingsCommand);
registry.register(settingConcurrencyCommand);
registry.register(settingRpmCommand);
registry.register(settingCapacityCommand);
