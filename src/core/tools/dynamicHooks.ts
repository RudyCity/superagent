import fs from "fs";
import path from "path";
import { execa } from "execa";
import { Tool } from "./types.js";
import { resolveWindowsShell, formatCommandForPowerShell } from "./helpers.js";
import { loadModelConfig, mutateModelConfig } from "../config/jsonConfig.js";
import { registry } from "../commands/registry.js";
import { SlashCommand } from "../commands/types.js";

let registeredDynamicCommands: string[] = [];

export interface HookMetadata {
  name: string;
  dirName: string;
  description: string;
  active: boolean;
}

export function getActiveHooksForProject(projectPath: string): string[] | null {
  try {
    const config = loadModelConfig();
    const active = config.activeHooks?.[projectPath];
    if (Array.isArray(active)) {
      return active;
    }
  } catch (err) {
    console.error(`[Dynamic Hooks] Failed to read active hooks config from model-config.json:`, err);
  }
  return null;
}

export function saveActiveHooksForProject(projectPath: string, activeHooks: string[]): void {
  try {
    mutateModelConfig((config) => {
      if (!config.activeHooks) {
        config.activeHooks = {};
      }
      config.activeHooks[projectPath] = activeHooks;
    });
  } catch (err) {
    console.error(`[Dynamic Hooks] Failed to save active hooks config to model-config.json:`, err);
  }
}

export function getAvailableHooks(): HookMetadata[] {
  const hooks: HookMetadata[] = [];
  const hooksRoot = path.join(process.cwd(), "internal-hooks");

  if (!fs.existsSync(hooksRoot)) {
    return hooks;
  }

  const projectPath = process.cwd();
  const activeHooks = getActiveHooksForProject(projectPath);

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
            if (config.name) {
              const isActive = activeHooks === null || activeHooks.includes(item.name);
              hooks.push({
                name: config.name.trim(),
                dirName: item.name,
                description: (config.description || "").trim(),
                active: isActive,
              });
            }
          } catch (err: any) {
            console.error(`[Dynamic Hooks] Failed to read hook metadata from ${hookDir}:`, err.message);
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[Dynamic Hooks] Failed to read internal-hooks directory:`, err.message);
  }

  return hooks;
}

export function loadDynamicHooks(): Tool[] {
  // Unregister previously loaded dynamic commands
  for (const cmdName of registeredDynamicCommands) {
    registry.unregister(cmdName);
  }
  registeredDynamicCommands = [];

  const dynamicTools: Tool[] = [];
  const hooksRoot = path.join(process.cwd(), "internal-hooks");

  if (!fs.existsSync(hooksRoot)) {
    return dynamicTools;
  }

  const projectPath = process.cwd();
  const activeHooks = getActiveHooksForProject(projectPath);

  try {
    const items = fs.readdirSync(hooksRoot, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        const hookDir = path.join(hooksRoot, item.name);
        const configPath = path.join(hookDir, "hook.json");
        if (fs.existsSync(configPath)) {
          // If activeHooks is defined, filter out inactive hooks
          if (activeHooks !== null && !activeHooks.includes(item.name)) {
            continue;
          }

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

            // Register custom slash commands configured in this hook
            const slashCommands = config.slash_commands || config.slashCommands;
            if (Array.isArray(slashCommands)) {
              for (const cmdConfig of slashCommands) {
                if (!cmdConfig.name) continue;
                const cmdName = cmdConfig.name.trim();
                const cmdRunCmd = cmdConfig.command || "node index.js";
                const cmdDesc = cmdConfig.description || `Custom slash command for hook ${toolName}`;
                const cmdAliases = cmdConfig.aliases || [];

                const slashCmd: SlashCommand = {
                  name: cmdName,
                  aliases: cmdAliases,
                  description: cmdDesc,
                  async execute(args, ctx) {
                    let shellPath: string | boolean = true;
                    let finalCommand = cmdRunCmd;
                    if (args) {
                      finalCommand = `${finalCommand} ${args}`;
                    }
                    if (process.platform === "win32") {
                      const resolved = resolveWindowsShell();
                      shellPath = resolved.shellPath;
                      if (!resolved.isBash) {
                        finalCommand = formatCommandForPowerShell(finalCommand);
                      }
                    }

                    ctx.addLine({
                      type: "system",
                      content: `[Hook Command] Running: ${finalCommand}`,
                      timestamp: Date.now()
                    });

                    try {
                      const result = await execa(finalCommand, {
                        shell: shellPath,
                        cwd: process.cwd(),
                        env: {
                          ...process.env,
                          SUPERAGENT_HOOK_DIR: hookDir,
                          SUPERAGENT_CWD: process.cwd(),
                          SUPERAGENT_WORKSPACE: process.cwd(),
                        },
                        reject: true,
                      });
                      if (result.stdout.trim()) {
                        ctx.addLine({
                          type: "system",
                          content: result.stdout.trim(),
                          timestamp: Date.now()
                        });
                      }
                    } catch (err: any) {
                      const stderrOutput = err.stderr ? err.stderr.trim() : "";
                      const stdoutOutput = err.stdout ? err.stdout.trim() : "";
                      const errorMsg = stderrOutput || stdoutOutput || err.message;
                      ctx.addLine({
                        type: "error",
                        content: `[Hook Command Error] ${errorMsg}`,
                        timestamp: Date.now()
                      });
                    }
                  }
                };

                registry.register(slashCmd);
                registeredDynamicCommands.push(cmdName);
              }
            }

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

export async function runEventHooks(
  event: "pre_tool" | "post_tool" | "pre_command" | "post_command",
  contextData: any
): Promise<void> {
  const hooksRoot = path.join(process.cwd(), "internal-hooks");
  if (!fs.existsSync(hooksRoot)) {
    return;
  }

  const projectPath = process.cwd();
  const activeHooks = getActiveHooksForProject(projectPath);

  try {
    const items = fs.readdirSync(hooksRoot, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        if (activeHooks !== null && !activeHooks.includes(item.name)) {
          continue;
        }

        const hookDir = path.join(hooksRoot, item.name);
        const configPath = path.join(hookDir, "hook.json");
        if (fs.existsSync(configPath)) {
          try {
            const configContent = fs.readFileSync(configPath, "utf-8");
            const config = JSON.parse(configContent);
            const eventHooks = config.event_hooks || config.hooks;
            if (Array.isArray(eventHooks)) {
              for (const eh of eventHooks) {
                if (eh && eh.event === event && eh.command) {
                  let shellPath: string | boolean = true;
                  let finalCommand = eh.command.trim();
                  if (process.platform === "win32") {
                    const resolved = resolveWindowsShell();
                    shellPath = resolved.shellPath;
                    if (!resolved.isBash) {
                      finalCommand = formatCommandForPowerShell(finalCommand);
                    }
                  }

                  await execa(finalCommand, {
                    shell: shellPath,
                    cwd: process.cwd(),
                    env: {
                      ...process.env,
                      SUPERAGENT_HOOK_DIR: hookDir,
                      SUPERAGENT_CWD: process.cwd(),
                      SUPERAGENT_WORKSPACE: process.cwd(),
                      SUPERAGENT_EVENT: event,
                    },
                    input: JSON.stringify(contextData),
                    reject: false,
                  });
                }
              }
            }
          } catch (err: any) {
            console.warn(`[Dynamic Hooks] Event hook execution failed for ${item.name}:`, err.message);
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[Dynamic Hooks] Error reading hooks root for events:`, err.message);
  }
}


