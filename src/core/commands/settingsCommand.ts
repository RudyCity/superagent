import { registry } from "./registry.js";
import { SlashCommand } from "./types.js";
import { getSettings, updateSettings, getContextWindowLimit, getEffectiveMasterModel, DEFAULT_VISION_TOKEN_SAVING_THRESHOLD } from "../config.js";

import { getConfiguredProviders, getTierModelWithProvider } from "../config/providers.js";
import fs from "fs";
import os from "os";
import path from "path";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { spawnRmemoryGateway } from "../rmemorySetup.js";
import { execa } from "execa";

// Active terminal window viewer state for RMemory
let activeViewerProcess: any = null;
let activeCloseSignalPath: string | null = null;

function showRmemoryWindow(ctx: any) {
  const globalDataDir = path.join(os.homedir(), ".superagent-r", "rmemory");
  const logDir = path.join(globalDataDir, "logs");
  const logPath = path.join(logDir, "gateway.log");

  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logPath, "", "utf8");
  }

  // If already open and active, do nothing
  if (activeViewerProcess && activeCloseSignalPath && fs.existsSync(activeCloseSignalPath)) {
    return;
  }

  const taskId = "rmemory-gateway-viewer";
  const windowLabel = "RMemory Memory Gateway Logs";
  const safeLog = logPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const safeTitle = windowLabel.replace(/"/g, "");
  const safeCwd = globalDataDir.replace(/"/g, "");

  const closeSignalPath = path.join(logDir, "rmemory-gateway-viewer.close");
  if (fs.existsSync(closeSignalPath)) {
    try { fs.unlinkSync(closeSignalPath); } catch {}
  }

  activeCloseSignalPath = closeSignalPath;

  try {
    if (process.platform === "win32") {
      const safeCloseSignal = closeSignalPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const viewerScript = [
        `$logPath = '${safeLog}'`,
        `$closeSignalPath = '${safeCloseSignal}'`,
        `$lastPos = 0`,
        `try {`,
        `  Write-Host "=== ${safeTitle} === (close window or run '/setting-rmemory hide' to hide)" -ForegroundColor Cyan`,
        `  Write-Host ''`,
        `  while ($true) {`,
        `    if (Test-Path $closeSignalPath) { break }`,
        `    try {`,
        `      $bytes = [System.IO.File]::ReadAllBytes($logPath)`,
        `      if ($bytes.Length -gt $lastPos) {`,
        `        $chunk = [System.Text.Encoding]::UTF8.GetString($bytes, $lastPos, $bytes.Length - $lastPos)`,
        `        Write-Host $chunk -NoNewline`,
        `        $lastPos = $bytes.Length`,
        `      }`,
        `    } catch {}`,
        `    Start-Sleep -Milliseconds 200`,
        `  }`,
        `} finally {`,
        `  try { Remove-Item $MyInvocation.MyCommand.Path -Force } catch {}`,
        `  try { Remove-Item $closeSignalPath -Force } catch {}`,
        `}`,
      ].join("\n");

      const viewerScriptPath = path.join(logDir, "rmemory-gateway-viewer.ps1");
      fs.writeFileSync(viewerScriptPath, viewerScript, "utf8");

      const viewerProc = execa(
        "cmd.exe",
        ["/c", `start /wait "${safeTitle}" /D "${safeCwd}" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${viewerScriptPath}"`],
        { detached: true, stdio: "ignore", windowsVerbatimArguments: true, reject: false }
      );

      activeViewerProcess = viewerProc;

      const handleViewerExit = () => {
        activeViewerProcess = null;
        activeCloseSignalPath = null;
        try { fs.unlinkSync(viewerScriptPath); } catch {}
        try { fs.unlinkSync(closeSignalPath); } catch {}
      };
      viewerProc.on("close", handleViewerExit);
      viewerProc.on("exit", handleViewerExit);
    } else if (process.platform === "darwin") {
      const script = `tell application "Terminal" to do script "tail -f '${safeLog}'"`;
      activeViewerProcess = execa("osascript", ["-e", script], { detached: true, stdio: "ignore" });
      activeViewerProcess.unref();
    } else {
      activeViewerProcess = execa("x-terminal-emulator", ["-e", `bash -c "tail -f '${safeLog}'"`],
        { detached: true, stdio: "ignore", reject: false });
      activeViewerProcess.unref();
    }
  } catch (err) {
    // ignore
  }
}

function hideRmemoryWindow() {
  if (activeCloseSignalPath) {
    try {
      fs.writeFileSync(activeCloseSignalPath, "close", "utf8");
    } catch {}
  }
  if (activeViewerProcess) {
    try {
      activeViewerProcess.kill();
    } catch {}
  }
  activeViewerProcess = null;
  activeCloseSignalPath = null;
}

// /settings command — show all settings from JSON config
export const settingsCommand: SlashCommand = {
  name: "settings",
  description: "Show current settings (rate limit, concurrency, streaming, focus, etc.)",
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
        `│ • Max Iterations     : ${s.maxIterations === 0 ? "0 (unlimited)" : s.maxIterations}`,
        `│ • Checklist Limit    : ${s.maxChecklistVisible} items`,
        `│ • History Limit      : ${s.maxHistoryVisible} items`,
        `│ • Processes Limit    : ${s.maxProcsVisible} items`,
        `│ • Focus Level (Depth): ${s.focus?.toUpperCase() ?? "OFF"}`,
        `│ • Focus Custom Budget: ${s.focusBudget} tokens`,
        `│ • Force Prompt Tools : ${s.forcePromptBasedToolCalling ? "ENABLED" : "DISABLED"}`,
        `│ • Auto Vision Token  : ${s.autoVisionTokenSaving ?? false ? "ENABLED" : "DISABLED"}`,
        `│ • Vision Threshold   : ${s.visionTokenSavingThreshold ?? DEFAULT_VISION_TOKEN_SAVING_THRESHOLD} chars`,
        `│ • Hide Timeline Line : ${s.hideTimeline ? "ENABLED" : "DISABLED"}`,
        `│ • Request Classifier : ${s.classifierEnabled !== false ? "ENABLED" : "DISABLED"}`,
        `│ • Classifier Threshold: ${s.classifierConfidenceThreshold ?? "high"}`,
        `│ • RMemory Active     : ${s.enableRmemory ? "ENABLED" : "DISABLED"}`,
        `│ • RMemory Provider   : ${s.rmemoryEmbeddingProvider || "local"}`,
        `│ • RMemory Model      : ${s.rmemoryEmbeddingProvider === "local" ? "nomic-embed-text-v1.5" : (s.rmemoryEmbeddingModel || "text-embedding-3-small")} (${s.rmemoryEmbeddingProvider === "local" ? 768 : (s.rmemoryEmbeddingDimensions || 1536)} dims)`,
        "│ ",
        "└─────────────────────────────────",
        "Configure these settings using:",
        "  /setting-concurrency <0|1>",
        "  /setting-rpm <number>",
        "  /setting-capacity <number>",
        "  /setting-streaming <on|off>",
        "  /setting-context-limit <number> (0 = auto)",
        "  /setting-max-iterations <number> (0 = unlimited)",
        "  /setting-checklist-limit <number>",
        "  /setting-history-limit <number>",
        "  /setting-procs-limit <number>",
        "  /setting-focus <off|low|medium|high|xhigh|max|custom>",
        "  /setting-focus-budget <number>",
        "  /setting-force-prompt-tools <on|off>",
        "  /setting-auto-vision <on|off>",
        "  /setting-vision-threshold <number>",
        "  /setting-hide-timeline <on|off>",
        "  /setting-classifier <on|off>",
        "  /setting-classifier-threshold <high|medium|low>",
        "  /setting-rmemory <on|off>",
        "  /setting-rmemory provider <local|openai>",
        "  /setting-rmemory model <model_name>",
        "  /setting-rmemory dimensions <number>"
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

      // Refresh ContextManager if it exists
      const cm = ctx.agent?.getContextManager?.();
      if (cm) {
        if (num > 0) {
          cm.setThreshold(num);
        } else {
          // Auto mode - reset to model default
          const currentModel = getEffectiveMasterModel("auto") || "gpt-4o";
          const modelLimit = getContextWindowLimit(currentModel);
          cm.setThreshold(modelLimit);
        }
        ctx.addLine({
          type: "system",
          content: `✓ Context window limit set to: ${num > 0 ? `${num} tokens` : "auto (model default)"}\n  ContextManager threshold updated.`,
          timestamp: now,
        });
      } else {
        ctx.addLine({
          type: "system",
          content: `✓ Context window limit set to: ${num > 0 ? `${num} tokens` : "auto (model default)"}`,
          timestamp: now,
        });
      }

      // Update UI context limit display
      if (ctx.setContextLimit) {
        ctx.setContextLimit(num > 0 ? num : 256000);
      }
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
      const current = getSettings().maxIterations;
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-max-iterations <number>\nCurrent value: ${current === 0 ? "0 (unlimited)" : current}`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 0) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a non-negative integer (0 for unlimited).",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ maxIterations: num });
      ctx.addLine({
        type: "system",
        content: `✓ Max iterations set to: ${num === 0 ? "unlimited" : num}`,
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

// /setting-checklist-limit command
export const settingChecklistLimitCommand: SlashCommand = {
  name: "setting-checklist-limit",
  description: "Set maximum visible items in active task checklist",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-checklist-limit <number>\nCurrent value: ${getSettings().maxChecklistVisible}`,
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
      updateSettings({ maxChecklistVisible: num });
      ctx.addLine({
        type: "system",
        content: `✓ Checklist visible limit set to: ${num}`,
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

// /setting-history-limit command
export const settingHistoryLimitCommand: SlashCommand = {
  name: "setting-history-limit",
  description: "Set maximum visible completed items in checklist history",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-history-limit <number>\nCurrent value: ${getSettings().maxHistoryVisible}`,
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
      updateSettings({ maxHistoryVisible: num });
      ctx.addLine({
        type: "system",
        content: `✓ History visible limit set to: ${num}`,
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

// /setting-procs-limit command
export const settingProcsLimitCommand: SlashCommand = {
  name: "setting-procs-limit",
  description: "Set maximum visible items in active background processes panel",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-procs-limit <number>\nCurrent value: ${getSettings().maxProcsVisible}`,
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
      updateSettings({ maxProcsVisible: num });
      ctx.addLine({
        type: "system",
        content: `✓ Processes visible limit set to: ${num}`,
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

export const settingRmemoryCommand: SlashCommand = {
  name: "setting-rmemory",
  description: "Configure RMemory memory settings (enable/disable, provider, model, dimensions)",
  execute(args, ctx) {
    const trimmed = args.trim();
    const parts = trimmed.split(/\s+/);
    const action = parts[0]?.toLowerCase();
    const value = parts[1];
    const now = Date.now();

    const current = getSettings();

    if (!action) {
      ctx.addLine({
        type: "system",
        content: [
          "Usage: /setting-rmemory <subcommand> [value]",
          "",
          "Subcommands:",
          `  /setting-rmemory <on|off>             Toggle RMemory (currently: ${current.enableRmemory ? "ON" : "OFF"})`,
          `  /setting-rmemory provider <local|openai> Set embedding provider (currently: ${current.rmemoryEmbeddingProvider})`,
          `  /setting-rmemory model <model_name>     Set remote embedding model (currently: ${current.rmemoryEmbeddingModel})`,
          `  /setting-rmemory dimensions <number>    Set remote embedding dimensions (currently: ${current.rmemoryEmbeddingDimensions})`,
        ].join("\n"),
        timestamp: now,
      });
      return;
    }

    if (action === "on" || action === "off" || action === "true" || action === "false") {
      const enable = action === "on" || action === "true";
      try {
        updateSettings({ enableRmemory: enable });
        ctx.addLine({
          type: "system",
          content: `✓ RMemory memory has been ${enable ? "ENABLED" : "DISABLED"}.`,
          timestamp: now,
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to save setting: ${err.message}`,
          timestamp: now,
        });
      }
      return;
    }

    if (action === "provider") {
      if (!value || (value !== "local" && value !== "openai")) {
        ctx.addLine({
          type: "error",
          content: "Usage: /setting-rmemory provider <local|openai>",
          timestamp: now,
        });
        return;
      }
      try {
        updateSettings({ rmemoryEmbeddingProvider: value as any });
        ctx.addLine({
          type: "system",
          content: `✓ RMemory embedding provider set to: ${value}`,
          timestamp: now,
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to save setting: ${err.message}`,
          timestamp: now,
        });
      }
      return;
    }

    if (action === "model") {
      if (!value) {
        ctx.addLine({
          type: "error",
          content: "Usage: /setting-rmemory model <model_name>",
          timestamp: now,
        });
        return;
      }
      try {
        updateSettings({ rmemoryEmbeddingModel: value });
        ctx.addLine({
          type: "system",
          content: `✓ RMemory remote embedding model set to: ${value}`,
          timestamp: now,
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to save setting: ${err.message}`,
          timestamp: now,
        });
      }
      return;
    }

    if (action === "dimensions") {
      const num = parseInt(value, 10);
      if (isNaN(num) || num <= 0) {
        ctx.addLine({
          type: "error",
          content: "Usage: /setting-rmemory dimensions <number>",
          timestamp: now,
        });
        return;
      }
      try {
        updateSettings({ rmemoryEmbeddingDimensions: num });
        ctx.addLine({
          type: "system",
          content: `✓ RMemory remote embedding dimensions set to: ${num}`,
          timestamp: now,
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to save setting: ${err.message}`,
          timestamp: now,
        });
      }
      return;
    }

    ctx.addLine({
      type: "error",
      content: `Unknown subcommand "${action}". Run '/setting-rmemory' to see options.`,
      timestamp: now,
    });
  }
};

// /setting-focus command
export const settingFocusCommand: SlashCommand = {
  name: "setting-focus",
  aliases: ["focus"],
  description: "Set reasoning focus depth level",
  execute(args, ctx) {
    const val = args.trim().toLowerCase();
    const now = Date.now();
    const validLevels = ["off", "low", "medium", "high", "xhigh", "max", "custom"];
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-focus <off|low|medium|high|xhigh|max|custom>\nCurrent value: ${getSettings().focus?.toUpperCase() ?? "OFF"}`,
        timestamp: now,
      });
      return;
    }
    if (!validLevels.includes(val)) {
      ctx.addLine({
        type: "error",
        content: `Invalid value. Must be one of: ${validLevels.join(", ")}`,
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ focus: val as any });
      if (ctx.setFocusLevel) {
        ctx.setFocusLevel(val);
      }
      ctx.addLine({
        type: "system",
        content: `✓ Focus depth set to: ${val.toUpperCase()}`,
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

// /setting-focus-budget command
export const settingFocusBudgetCommand: SlashCommand = {
  name: "setting-focus-budget",
  description: "Set reasoning focus custom budget tokens",
  execute(args, ctx) {
    const val = args.trim();
    const now = Date.now();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-focus-budget <number>\nCurrent value: ${getSettings().focusBudget} tokens`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 1024) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be an integer >= 1024 (Anthropic minimum budget).",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ focusBudget: num });
      ctx.addLine({
        type: "system",
        content: `✓ Focus custom budget set to: ${num} tokens`,
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

// /setting-force-prompt-tools command
export const settingForcePromptToolsCommand: SlashCommand = {
  name: "setting-force-prompt-tools",
  description: "Force prompt-based (XML) tool calling even if the model/endpoint supports native tools",
  execute(args, ctx) {
    const now = Date.now();
    const val = args.trim();
    if (!val || (val !== "on" && val !== "off")) {
      ctx.addLine({
        type: "error",
        content: "Usage: /setting-force-prompt-tools <on|off>",
        timestamp: now,
      });
      return;
    }
    const force = val === "on";
    try {
      updateSettings({ forcePromptBasedToolCalling: force });
      ctx.addLine({
        type: "system",
        content: `✓ Force prompt-based tool calling set to: ${force ? "ENABLED" : "DISABLED"}`,
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

// /setting-auto-vision command
export const settingAutoVisionCommand: SlashCommand = {
  name: "setting-auto-vision",
  description: "Enable or disable automatic text-to-image conversion for large prompt context",
  execute(args, ctx) {
    const now = Date.now();
    const val = args.trim();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-auto-vision <on|off>\nCurrent value: ${getSettings().autoVisionTokenSaving ?? false ? "on" : "off"}`,
        timestamp: now,
      });
      return;
    }
    if (val !== "on" && val !== "off") {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be 'on' or 'off'.",
        timestamp: now,
      });
      return;
    }
    const enable = val === "on";
    try {
      updateSettings({ autoVisionTokenSaving: enable });
      ctx.addLine({
        type: "system",
        content: `✓ Automatic vision token saving set to: ${enable ? "ENABLED" : "DISABLED"}`,
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

// /setting-vision-threshold command
export const settingVisionThresholdCommand: SlashCommand = {
  name: "setting-vision-threshold",
  description: "Set the character threshold above which prompt context is converted to image",
  execute(args, ctx) {
    const now = Date.now();
    const val = args.trim();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-vision-threshold <number>\nCurrent value: ${getSettings().visionTokenSavingThreshold ?? DEFAULT_VISION_TOKEN_SAVING_THRESHOLD} chars`,
        timestamp: now,
      });
      return;
    }
    const num = parseInt(val, 10);
    if (isNaN(num) || num < 0) {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be a non-negative number.",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ visionTokenSavingThreshold: num });
      ctx.addLine({
        type: "system",
        content: `✓ Vision token saving threshold set to: ${num} chars`,
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



// /setting-hide-timeline command
export const settingHideTimelineCommand: SlashCommand = {
  name: "setting-hide-timeline",
  description: "Hide or show the timeline lines connecting conversation turns",
  execute(args, ctx) {
    const now = Date.now();
    const val = args.trim();
    if (!val || (val !== "on" && val !== "off")) {
      ctx.addLine({
        type: "error",
        content: "Usage: /setting-hide-timeline <on|off>",
        timestamp: now,
      });
      return;
    }
    const hide = val === "on";
    try {
      updateSettings({ hideTimeline: hide });
      ctx.addLine({
        type: "system",
        content: `✓ Hide timeline set to: ${hide ? "ENABLED" : "DISABLED"}`,
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

// /setting-classifier command
export const settingClassifierCommand: SlashCommand = {
  name: "setting-classifier",
  aliases: ["classifier"],
  description: "Enable or disable the multi-category request classifier for token optimization",
  execute(args, ctx) {
    const now = Date.now();
    const val = args.trim();
    if (!val) {
      const settings = getSettings();
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-classifier <on|off>\nCurrent value: ${settings.classifierEnabled !== false ? "on" : "off"}\nConfidence threshold: ${settings.classifierConfidenceThreshold ?? "high"}`,
        timestamp: now,
      });
      return;
    }
    if (val !== "on" && val !== "off") {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be 'on' or 'off'.",
        timestamp: now,
      });
      return;
    }
    const enable = val === "on";
    try {
      updateSettings({ classifierEnabled: enable });
      ctx.addLine({
        type: "system",
        content: `✓ Request classifier set to: ${enable ? "ENABLED" : "DISABLED"}`,
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

// /setting-classifier-threshold command
export const settingClassifierThresholdCommand: SlashCommand = {
  name: "setting-classifier-threshold",
  aliases: ["classifier-threshold"],
  description: "Set the minimum heuristic confidence level to skip LLM classification (high|medium|low)",
  execute(args, ctx) {
    const now = Date.now();
    const val = args.trim().toLowerCase();
    if (!val) {
      ctx.addLine({
        type: "system",
        content: `Usage: /setting-classifier-threshold <high|medium|low>\nCurrent value: ${getSettings().classifierConfidenceThreshold ?? "high"}\n\n- high: Only skip LLM when heuristic is very confident (most LLM calls, highest accuracy)\n- medium: Skip LLM for medium+ confidence (balanced)\n- low: Skip LLM for any heuristic match (fewest LLM calls, fastest but less accurate)`,
        timestamp: now,
      });
      return;
    }
    if (val !== "high" && val !== "medium" && val !== "low") {
      ctx.addLine({
        type: "error",
        content: "Invalid value. Must be 'high', 'medium', or 'low'.",
        timestamp: now,
      });
      return;
    }
    try {
      updateSettings({ classifierConfidenceThreshold: val as any });
      ctx.addLine({
        type: "system",
        content: `✓ Classifier confidence threshold set to: ${val}`,
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
registry.register(settingChecklistLimitCommand);
registry.register(settingHistoryLimitCommand);
registry.register(settingProcsLimitCommand);
registry.register(settingRmemoryCommand);
registry.register(settingFocusCommand);
registry.register(settingFocusBudgetCommand);
registry.register(settingForcePromptToolsCommand);
registry.register(settingAutoVisionCommand);
registry.register(settingVisionThresholdCommand);
registry.register(settingHideTimelineCommand);
registry.register(settingClassifierCommand);
registry.register(settingClassifierThresholdCommand);
