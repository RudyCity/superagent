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

    if (!subCommand || (subCommand !== "init" && subCommand !== "dev" && subCommand !== "active")) {
      ctx.addLine({
        type: "error",
        content: "Usage:\n  /ih init <namahook>  - Scaffold a new internal hook project\n  /ih dev <namahook>   - Run local development/test loop inside hook workspace\n  /ih active           - Interactively select which hooks to activate",
        timestamp: now,
      });
      return;
    }

    if (subCommand !== "active" && !hookName) {
      ctx.addLine({
        type: "error",
        content: `Error: Missing hook name. Usage: /ih ${subCommand} <namahook>`,
        timestamp: now,
      });
      return;
    }

    if (subCommand !== "active" && !/^[a-zA-Z0-9_-]+$/.test(hookName)) {
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
          content: `✓ Successfully initialized internal hook project workspace!\nCreated directory: internal-hooks/${hookName}/\nFiles created:\n  - hook.json (Tool definition & inputs)\n  - package.json (Sub-project settings)\n  - index.js (Execution script entrypoint)\n  - test-payload.json (Mock inputs for dev testing)\n  - README.md (Hook documentation)\n  - CHANGELOG.md (Hook release notes)\n\n${gitInitSuccess ? "✓ Initialized clean Git repository in hook directory.\n" : ""}You can now edit these files and run "/ih dev ${hookName}" to test it!`,
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
      if (!fsSync.existsSync(hookDir) || !fsSync.existsSync(path.join(hookDir, "hook.json"))) {
        ctx.addLine({
          type: "error",
          content: `Error: Internal hook "${hookName}" does not exist. Run "/ih init ${hookName}" to create it first.`,
          timestamp: now,
        });
        return;
      }

      ctx.addLine({
        type: "system",
        content: `Entering workspace "internal-hooks/${hookName}" to run dev process...`,
        timestamp: now,
      });

      try {
        // Resolve target run command
        let runCmd = "node index.js";
        const pkgJsonPath = path.join(hookDir, "package.json");
        if (fsSync.existsSync(pkgJsonPath)) {
          try {
            const pkgData = JSON.parse(await fs.readFile(pkgJsonPath, "utf-8"));
            if (pkgData.scripts && pkgData.scripts.dev) {
              runCmd = pkgData.scripts.dev;
            }
          } catch {}
        } else {
          try {
            const hookData = JSON.parse(await fs.readFile(path.join(hookDir, "hook.json"), "utf-8"));
            if (hookData.command) {
              runCmd = hookData.command.trim();
            }
          } catch {}
        }

        // Load test payload
        let payload = {};
        const testPayloadPath = path.join(hookDir, "test-payload.json");
        if (fsSync.existsSync(testPayloadPath)) {
          try {
            payload = JSON.parse(await fs.readFile(testPayloadPath, "utf-8"));
          } catch {}
        }

        const argsJson = JSON.stringify(payload);
        const env = {
          ...process.env,
          SUPERAGENT_HOOK_DIR: hookDir,
          SUPERAGENT_CWD: process.cwd(),
          SUPERAGENT_WORKSPACE: process.cwd(),
        };

        // Format command for Windows if needed
        let shellPath: string | boolean = true;
        let finalCommand = runCmd;
        if (process.platform === "win32") {
          const resolved = resolveWindowsShell();
          shellPath = resolved.shellPath;
          if (!resolved.isBash) {
            finalCommand = formatCommandForPowerShell(finalCommand);
          }
        }

        const startTime = Date.now();
        if (ctx.runInteractiveProcess) {
          ctx.addLine({
            type: "system",
            content: `Running interactive command: ${runCmd}\n(Press Ctrl+C to terminate if it is long-running/watching)`,
            timestamp: Date.now(),
          });
          const exitCode = await ctx.runInteractiveProcess(finalCommand, hookDir, env);
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          ctx.addLine({
            type: "system",
            content: `Process exited with code ${exitCode} after ${duration}s.`,
            timestamp: Date.now(),
          });
        } else {
          ctx.addLine({
            type: "system",
            content: `Executing dev command: ${runCmd}...`,
            timestamp: Date.now(),
          });
          const result = await execa(finalCommand, {
            shell: shellPath,
            cwd: hookDir,
            env,
            input: argsJson,
            reject: false,
          });
          const duration = ((Date.now() - startTime) / 1000).toFixed(2);
          if (result.failed) {
            ctx.addLine({
              type: "error",
              content: `Execution failed (exit code ${result.exitCode || 1}) in ${duration}s.\nStdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
              timestamp: Date.now(),
            });
          } else {
            ctx.addLine({
              type: "system",
              content: `✓ Execution succeeded in ${duration}s!\nStdout:\n${result.stdout}\nStderr:\n${result.stderr}`,
              timestamp: Date.now(),
            });
          }
        }
      } catch (err: any) {
        ctx.addLine({
          type: "error",
          content: `Dev run failed: ${err.message}`,
          timestamp: Date.now(),
        });
      }
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
