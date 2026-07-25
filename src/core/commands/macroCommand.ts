import { SlashCommand } from "./types.js";
import { registry } from "./registry.js";
import {
  getBrowserMacros,
  deleteBrowserMacro,
  resolveSteps,
  dryRunSteps,
} from "../config/browserMacros.js";
import { sendRemoteCommand } from "../tools/remoteChromeBridge.js";

export const macroCommand: SlashCommand = {
  name: "macro",
  description: "Manage and run browser macro presets. Subcommands: list, run <name> [arg=val], delete <name>",
  async execute(args, ctx) {
    const now = Date.now();
    const trimmed = args.trim();
    const parts = trimmed.split(/\s+/).filter(Boolean);
    const subcommand = parts[0]?.toLowerCase();

    if (!subcommand || subcommand === "list") {
      const macros = getBrowserMacros();
      if (macros.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No browser macros saved yet.",
          timestamp: now,
        });
        return;
      }

      const listStr = macros.map(m => {
        const paramList = m.params
          ? Object.entries(m.params).map(([k, v]) => `    - {{${k}}}: ${v}`).join("\n")
          : "    (none)";
        return `• ${m.name} (v${m.version ?? 1}): ${m.description}\n  Params:\n${paramList}\n  Steps: ${m.steps.length} actions`;
      }).join("\n\n");

      ctx.addLine({
        type: "system",
        content: `### Saved Browser Macros\n${listStr}`,
        timestamp: now,
      });
      return;
    }

    if (subcommand === "delete") {
      const macroName = parts[1];
      if (!macroName) {
        ctx.addLine({
          type: "error",
          content: "Usage: /macro delete <macro_name>",
          timestamp: now,
        });
        return;
      }
      const deleted = deleteBrowserMacro(macroName);
      if (deleted) {
        ctx.addLine({
          type: "system",
          content: `✓ Macro "${macroName}" deleted successfully.`,
          timestamp: now,
        });
      } else {
        ctx.addLine({
          type: "error",
          content: `Macro "${macroName}" not found.`,
          timestamp: now,
        });
      }
      return;
    }

    if (subcommand === "run") {
      const macroName = parts[1];
      if (!macroName) {
        ctx.addLine({
          type: "error",
          content: "Usage: /macro run <macro_name> [key=value ...]",
          timestamp: now,
        });
        return;
      }

      const macros = getBrowserMacros();
      const macro = macros.find(m => m.name.toLowerCase() === macroName.toLowerCase());
      if (!macro) {
        ctx.addLine({
          type: "error",
          content: `Macro "${macroName}" not found. Type /macro list to see saved macros.`,
          timestamp: now,
        });
        return;
      }

      // Parse key=value arguments
      const argsMap: Record<string, string> = {};
      for (let i = 2; i < parts.length; i++) {
        const [k, ...vParts] = parts[i].split("=");
        if (k && vParts.length > 0) {
          argsMap[k] = vParts.join("=");
        }
      }

      ctx.addLine({
        type: "system",
        content: `Running macro "${macro.name}" (${macro.steps.length} steps)...`,
        timestamp: now,
      });

      const resolvedSteps = resolveSteps(macro.steps, argsMap);
      let stepIndex = 0;

      for (const step of resolvedSteps) {
        stepIndex++;
        const label = step.label ? `"${step.label}"` : `${step.action} -> ${step.target}`;
        ctx.addLine({
          type: "system",
          content: `Step ${stepIndex}/${resolvedSteps.length}: ${label}`,
          timestamp: Date.now(),
        });

        try {
          const res = await sendRemoteCommand(step.action, step.target || "", step.value);
          ctx.addLine({
            type: "system",
            content: `  ✓ ${res}`,
            timestamp: Date.now(),
          });
        } catch (err: any) {
          ctx.addLine({
            type: "error",
            content: `  ✗ Step ${stepIndex} failed: ${err.message}`,
            timestamp: Date.now(),
          });
          if (step.onError === "stop" || !step.onError) {
            ctx.addLine({
              type: "error",
              content: `Macro "${macro.name}" aborted at step ${stepIndex}.`,
              timestamp: Date.now(),
            });
            return;
          }
        }
      }

      ctx.addLine({
        type: "system",
        content: `✓ Macro "${macro.name}" finished executing all ${resolvedSteps.length} steps.`,
        timestamp: Date.now(),
      });
      return;
    }

    ctx.addLine({
      type: "error",
      content: `Unknown subcommand "${subcommand}". Usage: /macro [list | run <name> | delete <name>]`,
      timestamp: now,
    });
  },
};

registry.register(macroCommand);
