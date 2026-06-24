import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execa } from "execa";
import { SlashCommand, SlashCommandContext } from "./types.js";
import { registry } from "./registry.js";
import { resolveWindowsShell, formatCommandForPowerShell } from "../tools/helpers.js";

export const internalHooksCommand: SlashCommand = {
  name: "internal-hooks",
  aliases: ["ih"],
  description: "Initialize or run a local development loop for custom internal hook tools.",
  async execute(args, ctx) {
    const now = Date.now();
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const subCommand = parts[0]?.toLowerCase();
    const hookName = parts[1];

    if (!subCommand || (subCommand !== "init" && subCommand !== "dev")) {
      ctx.addLine({
        type: "error",
        content: "Usage:\n  /ih init <namahook>  - Scaffold a new internal hook project\n  /ih dev <namahook>   - Run local development/test loop inside hook workspace",
        timestamp: now,
      });
      return;
    }

    if (!hookName) {
      ctx.addLine({
        type: "error",
        content: `Error: Missing hook name. Usage: /ih ${subCommand} <namahook>`,
        timestamp: now,
      });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(hookName)) {
      ctx.addLine({
        type: "error",
        content: "Error: Hook name must contain only alphanumeric characters, hyphens, and underscores.",
        timestamp: now,
      });
      return;
    }

    const hookDir = path.join(process.cwd(), "internal-hooks", hookName);

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

        await fs.writeFile(path.join(hookDir, "hook.json"), JSON.stringify(hookJson, null, 2), "utf-8");
        await fs.writeFile(path.join(hookDir, "package.json"), JSON.stringify(packageJson, null, 2), "utf-8");
        await fs.writeFile(path.join(hookDir, "index.js"), indexJs, "utf-8");
        await fs.writeFile(path.join(hookDir, "test-payload.json"), JSON.stringify(testPayloadJson, null, 2), "utf-8");

        ctx.addLine({
          type: "system",
          content: `✓ Successfully initialized internal hook project workspace!\nCreated directory: internal-hooks/${hookName}/\nFiles created:\n  - hook.json (Tool definition & inputs)\n  - package.json (Sub-project settings)\n  - index.js (Execution script entrypoint)\n  - test-payload.json (Mock inputs for dev testing)\n\nYou can now edit these files and run "/ih dev ${hookName}" to test it!`,
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
    }
  }
};

// Register command
registry.register(internalHooksCommand);
