import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execa } from "execa";
import { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";
import { resolveWindowsShell, formatCommandForPowerShell } from "../tools/helpers.js";
import { getActiveQuestionHandler } from "../tools/state.js";
import { getAvailableHooks, getActiveHooksForProject, saveActiveHooksForProject } from "../tools/dynamicHooks.js";

export const internalHooksCommand: SlashCommand = {
  name: "internal-hooks",
  aliases: ["ih"],
  description: "Initialize, run a local development loop, or toggle active status for custom internal hook tools.",
  async execute(args, ctx) {
    const now = Date.now();
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subCommand = parts[0]?.toLowerCase();
    const hookName = parts[1];

    if (!subCommand || (subCommand !== "init" && subCommand !== "dev" && subCommand !== "active" && subCommand !== "list")) {
      ctx.addLine({
        type: "error",
        content: "Usage:\n  /ih init <namahook>  - Scaffold a new internal hook project\n  /ih dev <namahook>   - Set workspace focus to hook development and run dev loop\n  /ih list             - List all discovered internal hooks and their status\n  /ih active           - Interactively select which hooks to activate",
        timestamp: now,
      });
      return;
    }

    if (subCommand === "dev" && !hookName) {
      const hooks = getAvailableHooks();
      if (hooks.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No internal hooks found. Use `/ih init <namahook>` to create one first.",
          timestamp: now,
        });
        return;
      }

      let content = "Available internal hooks for development:\n\n";
      for (const hook of hooks) {
        const status = hook.active ? "🟢 Active" : "🔴 Inactive";
        
        let details = "";
        const hookDir = path.join(process.cwd(), "internal-hooks", hook.dirName);
        const configPath = path.join(hookDir, "hook.json");
        try {
          const configContent = fsSync.readFileSync(configPath, "utf-8");
          const config = JSON.parse(configContent);
          const hasTool = !!config.name && !!config.description;
          const slashCmds = config.slash_commands || config.slashCommands || [];
          const eventHooks = config.event_hooks || config.hooks || [];
          const features: string[] = [];
          if (hasTool) features.push("Tool AI");
          if (slashCmds.length > 0) features.push(`Slash Commands (${slashCmds.map((c: any) => `/${c.name}`).join(", ")})`);
          if (eventHooks.length > 0) features.push(`Event Hooks (${eventHooks.map((e: any) => e.event).join(", ")})`);
          
          const skillsDir = path.join(hookDir, "skills");
          if (fsSync.existsSync(skillsDir) && fsSync.statSync(skillsDir).isDirectory()) {
            features.push("Dynamic Skills");
          }
          details = features.length > 0 ? ` [Exposes: ${features.join(", ")}]` : " [No features exposed]";
        } catch {}

        content += `- **${hook.name}** (in \`internal-hooks/${hook.dirName}\`)\n  State: ${status}${details}\n\n`;
      }
      content += "To start development, run:\n  `/ih dev <namahook>`";
      ctx.addLine({
        type: "system",
        content: content.trim(),
        timestamp: Date.now(),
      });
      return;
    }

    if (subCommand === "init" && !hookName) {
      ctx.addLine({
        type: "error",
        content: `Error: Missing hook name. Usage: /ih init <namahook>`,
        timestamp: now,
      });
      return;
    }

    if (subCommand !== "active" && subCommand !== "list" && !/^[a-zA-Z0-9_-]+$/.test(hookName)) {
      ctx.addLine({
        type: "error",
        content: "Error: Hook name must contain only alphanumeric characters, hyphens, and underscores.",
        timestamp: now,
      });
      return;
    }

    const hookDir = hookName ? path.join(process.cwd(), "internal-hooks", hookName) : "";

    if (subCommand === "init") {
      ctx.addLine({
        type: "system",
        content: `Initializing internal hook "${hookName}" project workspace...`,
        timestamp: now,
      });

      try {
        await fs.mkdir(hookDir, { recursive: true });

        const hookJson = {
          name: hookName,
          description: `Custom internal hook tool for ${hookName}.`,
          parameters: {
            type: "object",
            properties: {
              exampleParam: {
                type: "string",
                description: "An example parameter description."
              }
            },
            required: ["exampleParam"]
          },
          command: "node index.js"
        };

        const packageJson = {
          name: `${hookName}-hook`,
          version: "1.0.0",
          type: "module",
          scripts: {
            dev: "node index.js"
          }
        };

        const indexJs = `import fs from "fs";

// Read args from stdin
const input = fs.readFileSync(0, "utf-8");
let args = {};
if (input.trim()) {
  try {
    args = JSON.parse(input);
  } catch (err) {
    console.error("Failed to parse JSON input:", err.message);
    process.exit(1);
  }
}

console.log("Hook executed successfully!");
console.log("Arguments:", JSON.stringify(args, null, 2));
console.log("Hook Directory:", process.env.SUPERAGENT_HOOK_DIR);
console.log("Active Workspace CWD:", process.cwd());
`;

        const testPayloadJson = {
          exampleParam: "hello world"
        };

        const todayDate = new Date().toISOString().split("T")[0];

        const readmeMd = `# ${hookName}

Custom internal hook tool for ${hookName}.

## Description
[Describe what this hook does and how the AI agent should use it.]

## File Structure
- \`hook.json\`: Tool definition, parameters, slash commands, and event hooks registration.
- \`package.json\`: Script triggers and dependency management.
- \`index.js\`: Script execution entrypoint.
- \`test-payload.json\`: Stdin payload for testing command \`/ih dev ${hookName}\` locally.
- \`README.md\`: Documentation for the hook.
- \`CHANGELOG.md\`: Version and change history logs.

## Usage
Run \`/ih dev ${hookName}\` inside the main project directory to test this hook locally.
`;

        const changelogMd = `# Changelog

All notable changes to the \`${hookName}\` hook will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - ${todayDate}

### Added
- Initial release of the \`${hookName}\` internal hook.
`;

        await fs.writeFile(path.join(hookDir, "hook.json"), JSON.stringify(hookJson, null, 2), "utf-8");
        await fs.writeFile(path.join(hookDir, "package.json"), JSON.stringify(packageJson, null, 2), "utf-8");
        await fs.writeFile(path.join(hookDir, "index.js"), indexJs, "utf-8");
        await fs.writeFile(path.join(hookDir, "test-payload.json"), JSON.stringify(testPayloadJson, null, 2), "utf-8");
        await fs.writeFile(path.join(hookDir, "README.md"), readmeMd, "utf-8");
        await fs.writeFile(path.join(hookDir, "CHANGELOG.md"), changelogMd, "utf-8");

        // Git initialize inside hook directory
        let gitInitSuccess = false;
        try {
          await execa("git", ["init"], { cwd: hookDir });
          gitInitSuccess = true;
        } catch (gitErr: any) {
          ctx.addLine({
            type: "system",
            content: `⚠ Warning: Failed to initialize Git repository in internal-hooks/${hookName}: ${gitErr.message}`,
            timestamp: Date.now(),
          });
        }

        // Run npm install inside hook directory to bootstrap dependencies (skip in Vitest to save test run time)
        let npmInstallSuccess = false;
        if (!process.env.VITEST) {
          try {
            ctx.addLine({
              type: "system",
              content: "Running npm install to bootstrap dependencies...",
              timestamp: Date.now(),
            });
            await execa("npm", ["install"], { cwd: hookDir });
            npmInstallSuccess = true;
          } catch (npmErr: any) {
            ctx.addLine({
              type: "system",
              content: `⚠ Warning: Failed to run npm install in internal-hooks/${hookName}: ${npmErr.message}`,
              timestamp: Date.now(),
            });
          }
        } else {
          npmInstallSuccess = true;
        }

        // Auto-activate the new hook if there's already a configured list
        const activeHooks = getActiveHooksForProject(process.cwd());
        if (activeHooks !== null) {
          if (!activeHooks.includes(hookName)) {
            activeHooks.push(hookName);
            saveActiveHooksForProject(process.cwd(), activeHooks);
          }
        }

        // Trigger dynamic tools reload so the new hook is loaded immediately
        try {
          const { refreshDynamicHooks } = await import("../tools/index.js");
          refreshDynamicHooks();
        } catch (reloadErr) {
          console.error("Failed to hot-reload dynamic hooks:", reloadErr);
        }

        ctx.addLine({
          type: "system",
          content: `✓ Successfully initialized internal hook project workspace!\nCreated directory: internal-hooks/${hookName}/\nFiles created:\n  - hook.json (Tool definition & inputs)\n  - package.json (Sub-project settings)\n  - index.js (Execution script entrypoint)\n  - test-payload.json (Mock inputs for dev testing)\n  - README.md (Hook documentation)\n  - CHANGELOG.md (Hook release notes)\n\n${gitInitSuccess ? "✓ Initialized clean Git repository in hook directory.\n" : ""}${npmInstallSuccess && !process.env.VITEST ? "✓ Installed project dependencies.\n" : ""}You can now edit these files and run "/ih dev ${hookName}" to test it!`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to initialize hook: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    if (subCommand === "dev") {
      const isClearKeyword = ["off", "stop", "clear", "none"].includes(hookName.toLowerCase());
      const hookExists = fsSync.existsSync(hookDir) && fsSync.existsSync(path.join(hookDir, "hook.json"));

      if (isClearKeyword && !hookExists) {
        if (ctx.setActiveDevHook) {
          ctx.setActiveDevHook(null);
          ctx.addLine({
            type: "system",
            content: `✓ Cleared active internal hook development workspace focus.`,
            timestamp: now,
          });
          return;
        }
      }

      if (!hookExists) {
        ctx.addLine({
          type: "error",
          content: `Error: Internal hook "${hookName}" does not exist. Run "/ih init ${hookName}" to create it first.`,
          timestamp: now,
        });
        return;
      }

      if (ctx.setActiveDevHook) {
        ctx.setActiveDevHook(hookName);
      }

      ctx.addLine({
        type: "system",
        content: `✓ Workspace focus set to internal hook "${hookName}" for development.`,
        timestamp: now,
      });
      return;
    }

    if (subCommand === "list") {
      const hooks = getAvailableHooks();
      if (hooks.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No internal hooks found. Use `/ih init <namahook>` to create one first.",
          timestamp: now,
        });
        return;
      }

      let content = "Discovered Internal Hooks:\n\n";
      for (const hook of hooks) {
        const status = hook.active ? "🟢 Active" : "🔴 Inactive";
        
        let details = "";
        const hookDir = path.join(process.cwd(), "internal-hooks", hook.dirName);
        const configPath = path.join(hookDir, "hook.json");
        try {
          const configContent = fsSync.readFileSync(configPath, "utf-8");
          const config = JSON.parse(configContent);
          const hasTool = !!config.name && !!config.description;
          const slashCmds = config.slash_commands || config.slashCommands || [];
          const eventHooks = config.event_hooks || config.hooks || [];
          const features: string[] = [];
          if (hasTool) features.push("Tool AI");
          if (slashCmds.length > 0) features.push(`Slash Commands (${slashCmds.map((c: any) => `/${c.name}`).join(", ")})`);
          if (eventHooks.length > 0) features.push(`Event Hooks (${eventHooks.map((e: any) => e.event).join(", ")})`);
          
          const skillsDir = path.join(hookDir, "skills");
          if (fsSync.existsSync(skillsDir) && fsSync.statSync(skillsDir).isDirectory()) {
            features.push("Dynamic Skills");
          }
          details = features.length > 0 ? ` [Exposes: ${features.join(", ")}]` : " [No features exposed]";
        } catch {}

        content += `- **${hook.name}** (in \`internal-hooks/${hook.dirName}\`)\n  State: ${status}${details}\n\n`;
      }
      ctx.addLine({
        type: "system",
        content: content.trim(),
        timestamp: Date.now(),
      });
      return;
    }

    if (subCommand === "active") {
      const hooks = getAvailableHooks();
      if (hooks.length === 0) {
        ctx.addLine({
          type: "system",
          content: "No internal hooks found. Use `/ih init <namahook>` to create one first.",
          timestamp: now,
        });
        return;
      }

      const handler = getActiveQuestionHandler();
      if (!handler) {
        ctx.addLine({
          type: "error",
          content: "Error: No active question handler found to display the selection dialog.",
          timestamp: now,
        });
        return;
      }

      // Format options: "<dirName> - <description>"
      const options = hooks.map(h => {
        const desc = h.description ? ` - ${h.description}` : "";
        return `${h.dirName}${desc}`;
      });

      // Find indices of active hooks
      const initialCheckedIndices: number[] = [];
      hooks.forEach((h, idx) => {
        if (h.active) {
          initialCheckedIndices.push(idx);
        }
      });

      try {
        ctx.addLine({
          type: "system",
          content: "Opening active hooks selection dialog...",
          timestamp: Date.now(),
        });

        const answer = await handler(
          "Select which internal hooks you want to activate (Space to check/uncheck, Enter to submit):",
          options,
          true,
          initialCheckedIndices
        );

        if (answer === "__CANCEL__") {
          ctx.addLine({
            type: "system",
            content: "Active hooks selection cancelled.",
            timestamp: Date.now(),
          });
          return;
        }

        // Parse response
        const selectedOptions = typeof answer === "string" 
          ? answer.split(", ").map(x => x.trim()).filter(Boolean)
          : (Array.isArray(answer) ? answer.map(x => String(x).trim()) : []);

        const activeHooksToSave: string[] = [];
        for (const opt of selectedOptions) {
          const match = hooks.find(h => {
            const desc = h.description ? ` - ${h.description}` : "";
            return `${h.dirName}${desc}` === opt;
          });
          if (match) {
            activeHooksToSave.push(match.dirName);
          }
        }

        // Save selection
        saveActiveHooksForProject(process.cwd(), activeHooksToSave);

        // Trigger dynamic tools reload
        try {
          const { refreshDynamicHooks } = await import("../tools/index.js");
          refreshDynamicHooks();
        } catch (reloadErr) {
          console.error("Failed to hot-reload dynamic hooks:", reloadErr);
        }

        ctx.addLine({
          type: "system",
          content: `✓ Successfully updated active hooks!\nActive hooks: ${activeHooksToSave.length > 0 ? activeHooksToSave.join(", ") : "none"}`,
          timestamp: Date.now(),
        });
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Failed to select active hooks: ${err.message}`,
          timestamp: Date.now(),
        });
      }
      return;
    }
  }
};

// Register command
registry.register(internalHooksCommand);
