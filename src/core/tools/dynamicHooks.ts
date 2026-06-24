import fs from "fs";
import path from "path";
import { execa } from "execa";
import { Tool } from "./types.js";
import { resolveWindowsShell, formatCommandForPowerShell } from "./helpers.js";

export function loadDynamicHooks(): Tool[] {
  const dynamicTools: Tool[] = [];
  const hooksRoot = path.join(process.cwd(), "internal-hooks");

  if (!fs.existsSync(hooksRoot)) {
    return dynamicTools;
  }

  try {
    const items = fs.readdirSync(hooksRoot, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        const hookDir = path.join(hooksRoot, item.name);
        const configPath = path.join(hookDir, "hook.json");
        if (fs.existsSync(configPath)) {
          try {
            const configContent = fs.readFileSync(configPath, "utf-8");
            const config = JSON.parse(configContent);
            if (!config.name || !config.description) {
              console.warn(`[Dynamic Hooks] Missing name or description in hook.json at ${hookDir}`);
              continue;
            }

            const toolName = config.name.trim();
            const toolDescription = config.description.trim();
            const toolParameters = config.parameters || { type: "object", properties: {}, required: [] };
            const runCmd = config.command ? config.command.trim() : "node index.js";

            const tool: Tool = {
              name: toolName,
              description: toolDescription,
              parameters: toolParameters,
              async execute(args, cwd, signal) {
                // Resolve Windows shell if on Windows
                let shellPath: string | boolean = true;
                let finalCommand = runCmd;
                if (process.platform === "win32") {
                  const resolved = resolveWindowsShell();
                  shellPath = resolved.shellPath;
                  if (!resolved.isBash) {
                    finalCommand = formatCommandForPowerShell(finalCommand);
                  }
                }

                const argsJson = JSON.stringify(args);

                try {
                  const result = await execa(finalCommand, {
                    shell: shellPath,
                    cwd, // execute inside active agent CWD (workspace)
                    env: {
                      ...process.env,
                      SUPERAGENT_HOOK_DIR: hookDir,
                      SUPERAGENT_CWD: cwd,
                      SUPERAGENT_WORKSPACE: cwd,
                    },
                    input: argsJson, // pipe parameters to stdin
                    reject: true,
                  });

                  return result.stdout.trim();
                } catch (err: any) {
                  const stderrOutput = err.stderr ? err.stderr.trim() : "";
                  const stdoutOutput = err.stdout ? err.stdout.trim() : "";
                  const errorMsg = stderrOutput || stdoutOutput || err.message;
                  throw new Error(`[Hook Execution Error] ${errorMsg}`);
                }
              }
            };

            dynamicTools.push(tool);
          } catch (err: any) {
            console.error(`[Dynamic Hooks] Failed to load hook from ${hookDir}:`, err.message);
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[Dynamic Hooks] Failed to read internal-hooks directory:`, err.message);
  }

  return dynamicTools;
}
