import fs from "fs";
import path from "path";
import os from "os";
import { getRootConfigDir } from "../config/paths.js";

export interface RemoteAgentConfig {
  botToken?: string;
  groupId?: string | number;
  museBotId?: string | number;
  defaultWorkspace?: string;
  asRunner?: boolean;
}

const DEFAULT_CONFIG: RemoteAgentConfig = {};

export function getRemoteAgentConfigPath(customPath?: string): string {
  if (customPath) return customPath;
  try {
    return path.join(getRootConfigDir(), "remote-agent.json");
  } catch {
    return path.join(os.homedir(), ".superagent-r", "remote-agent.json");
  }
}

export function loadRemoteAgentConfig(customPath?: string): RemoteAgentConfig {
  const filePath = getRemoteAgentConfigPath(customPath);
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_CONFIG,
        ...parsed,
      };
    }
  } catch (err: any) {
    // If parsing fails, return default empty config
  }
  return { ...DEFAULT_CONFIG };
}

export function saveRemoteAgentConfig(config: RemoteAgentConfig, customPath?: string): void {
  const filePath = getRemoteAgentConfigPath(customPath);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf-8");
  } catch (err: any) {
    throw new Error(`Failed to save remote agent config: ${err.message}`);
  }
}

export function updateRemoteAgentConfig(
  patch: Partial<RemoteAgentConfig>,
  customPath?: string
): RemoteAgentConfig {
  const existing = loadRemoteAgentConfig(customPath);
  const updated: RemoteAgentConfig = {
    ...existing,
    ...patch,
  };
  saveRemoteAgentConfig(updated, customPath);
  return updated;
}

/**
 * Masks a bot token so it can be safely displayed in the UI or CLI.
 * Never prints the raw token.
 */
export function maskToken(token?: string): string {
  if (!token || typeof token !== "string" || token.trim() === "") {
    return "(not configured)";
  }
  const trimmed = token.trim();
  if (trimmed.length <= 8) {
    return "********";
  }
  return trimmed.slice(0, 4) + "..." + trimmed.slice(-4);
}

/**
 * Checks if Muse is active as the default runner for chat prompts.
 * Requires asRunner to be true and all required Telegram parameters configured.
 */
export function isMuseRunnerActive(customPath?: string): boolean {
  const cfg = loadRemoteAgentConfig(customPath);
  return Boolean(cfg.asRunner && cfg.botToken && cfg.groupId && cfg.museBotId);
}

