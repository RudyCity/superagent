/**
 * mcpRegistration.ts — Helper to register the Superagent MCP Server into Antigravity (AGY) configuration.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

export interface AgyMcpConfig {
  mcpServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    disabled?: boolean;
    serverUrl?: string;
  }>;
}

/**
 * Returns the path to the global Antigravity MCP config file.
 */
export function getAgyMcpConfigPath(): string {
  return path.join(os.homedir(), ".gemini", "config", "mcp_config.json");
}

/**
 * Register or update the Superagent MCP Server definition in the Antigravity configuration.
 */
export function registerToAgyConfig(customCliPath?: string): { success: boolean; configPath: string; message: string } {
  const configPath = getAgyMcpConfigPath();
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });

  let config: AgyMcpConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = JSON.parse(raw);
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Resolve CLI path
  let cliPath = customCliPath;
  if (!cliPath) {
    // Current package's dist/cli.js
    const currentFile = fileURLToPath(import.meta.url);
    const rootDir = path.resolve(path.join(path.dirname(currentFile), "..", "..", ".."));
    cliPath = path.join(rootDir, "dist", "cli.js");
  }

  // Normalize path with forward slashes for cross-platform compatibility in JSON
  const normalizedCliPath = cliPath.replace(/\\/g, "/");

  config.mcpServers["superagent"] = {
    command: "node",
    args: [normalizedCliPath, "--mcp"],
    env: {
      NODE_ENV: "production",
    },
  };

  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return {
      success: true,
      configPath,
      message: `Successfully registered Superagent MCP server in Antigravity config at ${configPath}`,
    };
  } catch (err: any) {
    return {
      success: false,
      configPath,
      message: `Failed to write Antigravity MCP config: ${err.message || String(err)}`,
    };
  }
}
