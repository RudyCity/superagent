import {
  getModelPresets,
  applyModelPreset,
  closeHistoryDb
} from "../config.js";
import type { PresetMode, ModelPreset } from "../config/presets.js";

export function printPresetHelp(): void {
  console.log(`
Usage: superagent preset <command> [options]

Commands:
  list, ls                        List available model presets (multi & single)
  use, apply <name> [options]     Apply preset globally to model configuration
  show <name> [options]           Show detailed models configured in a preset

Options:
  -s, --single                    Target single-agent mode (default is multi-agent mode)
  -m, --mode <single|multi>       Explicitly specify mode ("multi" or "single")

Examples:
  superagent preset list
  superagent preset use dev
  superagent preset use dev --single
  superagent preset show dev
`);
}

function parseMode(args: string[]): PresetMode {
  if (args.includes("--single") || args.includes("-s")) {
    return "single";
  }
  const modeIdx = args.findIndex(a => a === "--mode" || a === "-m");
  if (modeIdx !== -1 && args[modeIdx + 1]) {
    const val = args[modeIdx + 1].toLowerCase();
    if (val === "single" || val === "s") return "single";
  }
  return "multi";
}

function cleanPresetArg(args: string[]): string {
  const flags = new Set(["--single", "-s", "--mode", "-m", "multi", "single"]);
  const filtered = args.filter((a, idx) => {
    if (flags.has(a)) return false;
    const prev = args[idx - 1];
    if (prev === "--mode" || prev === "-m") return false;
    return true;
  });
  return filtered[0] || "";
}

export async function handlePresetCliCommand(args: string[]): Promise<void> {
  const subcommand = args[0]?.toLowerCase();

  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    printPresetHelp();
    try { closeHistoryDb(); } catch {}
    process.exit(0);
  }

  if (subcommand === "list" || subcommand === "ls") {
    const multiPresets = getModelPresets("multi");
    const singlePresets = getModelPresets("single");

    console.log("\n📦 Superagent Model Presets:\n");

    console.log("--- Multi-Agent Mode Presets ---");
    if (multiPresets.length === 0) {
      console.log("  (No multi-agent presets found)");
    } else {
      for (const p of multiPresets) {
        console.log(`  • ${p.name.padEnd(20)} - ${p.description || "No description"}`);
      }
    }

    console.log("\n--- Single-Agent Mode Presets ---");
    if (singlePresets.length === 0) {
      console.log("  (No single-agent presets found)");
    } else {
      for (const p of singlePresets) {
        console.log(`  • ${p.name.padEnd(20)} - ${p.description || "No description"}`);
      }
    }

    console.log("\nUse 'superagent preset use <name>' to activate a preset globally.\n");
    try { closeHistoryDb(); } catch {}
    process.exit(0);
  }

  if (subcommand === "use" || subcommand === "apply") {
    const mode = parseMode(args.slice(1));
    const presetName = cleanPresetArg(args.slice(1));

    if (!presetName) {
      console.error("Error: Please provide a preset name. Usage: superagent preset use <name> [--single]");
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    try {
      applyModelPreset(presetName, mode, true);
      console.log(`✅ Successfully applied preset "${presetName}" globally for ${mode}-agent mode.`);
      try { closeHistoryDb(); } catch {}
      process.exit(0);
    } catch (err: any) {
      console.error(`❌ Failed to apply preset: ${err.message}`);
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }
  }

  if (subcommand === "show" || subcommand === "view") {
    const mode = parseMode(args.slice(1));
    const presetName = cleanPresetArg(args.slice(1));

    if (!presetName) {
      console.error("Error: Please provide a preset name. Usage: superagent preset show <name> [--single]");
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    const presets = getModelPresets(mode);
    const target = presets.find(p => p.name.toLowerCase() === presetName.toLowerCase());

    if (!target) {
      console.error(`Error: Preset "${presetName}" not found in ${mode}-agent mode.`);
      console.error(`Run 'superagent preset list' to see available presets.`);
      try { closeHistoryDb(); } catch {}
      process.exit(1);
    }

    console.log(`\n📋 Preset: ${target.name} (${mode}-agent mode)`);
    console.log(`Description: ${target.description || "None"}\n`);
    console.log("Models:");
    if (!target.models || Object.keys(target.models).length === 0) {
      console.log("  (Default models)");
    } else {
      for (const [k, v] of Object.entries(target.models)) {
        console.log(`  - ${k}: ${v}`);
      }
    }
    console.log("");
    try { closeHistoryDb(); } catch {}
    process.exit(0);
  }

  console.error(`Unknown preset subcommand: "${subcommand}".`);
  printPresetHelp();
  try { closeHistoryDb(); } catch {}
  process.exit(1);
}
