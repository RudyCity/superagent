import fs from "fs";
import path from "path";
import os from "os";
import { getRootConfigDir } from "../config/paths.js";

export interface RemoteAgentConfig {
  botToken?: string;
  groupId?: string | number;
  museBotId?: string | number;
  defaultWorkspace?: string;
  workspaces?: string[];
  asRunner?: boolean;
  systemPrompt?: string;
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

/**
 * Returns an array of normalized absolute paths for all configured watched workspaces.
 * Falls back to defaultWorkspace or fallbackWorkspace or process.cwd().
 */
export function getWatchedWorkspaces(
  config?: RemoteAgentConfig,
  fallbackWorkspace?: string
): string[] {
  const cfg = config || loadRemoteAgentConfig();
  const rawList: string[] = [];

  if (Array.isArray(cfg.workspaces) && cfg.workspaces.length > 0) {
    rawList.push(...cfg.workspaces);
  }
  if (cfg.defaultWorkspace && !rawList.includes(cfg.defaultWorkspace)) {
    rawList.unshift(cfg.defaultWorkspace);
  }
  if (rawList.length === 0) {
    rawList.push(fallbackWorkspace || process.cwd());
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of rawList) {
    if (typeof item === "string" && item.trim()) {
      const resolved = path.resolve(item.trim());
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push(resolved);
      }
    }
  }

  return normalized.length > 0 ? normalized : [path.resolve(process.cwd())];
}

/**
 * Adds a workspace path to the configured watched workspaces.
 */
export function addWatchedWorkspace(
  workspacePath: string,
  customPath?: string
): RemoteAgentConfig {
  const existing = loadRemoteAgentConfig(customPath);
  const currentList = Array.isArray(existing.workspaces) ? [...existing.workspaces] : [];
  const resolved = path.resolve(workspacePath.trim());

  const exists = currentList.some((w) => {
    const r = path.resolve(w);
    return process.platform === "win32"
      ? r.toLowerCase() === resolved.toLowerCase()
      : r === resolved;
  });

  if (!exists) {
    currentList.push(resolved);
  }

  return updateRemoteAgentConfig(
    {
      workspaces: currentList,
      defaultWorkspace: existing.defaultWorkspace || resolved,
    },
    customPath
  );
}

/**
 * Removes a workspace path from the configured watched workspaces.
 */
export function removeWatchedWorkspace(
  workspacePath: string,
  customPath?: string
): RemoteAgentConfig {
  const existing = loadRemoteAgentConfig(customPath);
  const currentList = Array.isArray(existing.workspaces) ? [...existing.workspaces] : [];
  const resolved = path.resolve(workspacePath.trim());

  const filtered = currentList.filter((w) => {
    const r = path.resolve(w);
    return process.platform === "win32"
      ? r.toLowerCase() !== resolved.toLowerCase()
      : r !== resolved;
  });

  let newDefault = existing.defaultWorkspace;
  if (newDefault) {
    const defResolved = path.resolve(newDefault);
    const defMatches = process.platform === "win32"
      ? defResolved.toLowerCase() === resolved.toLowerCase()
      : defResolved === resolved;
    if (defMatches) {
      newDefault = filtered.length > 0 ? filtered[0] : undefined;
    }
  }

  return updateRemoteAgentConfig(
    {
      workspaces: filtered,
      defaultWorkspace: newDefault,
    },
    customPath
  );
}

/**
 * Sets the full list of watched workspaces.
 */
export function setWatchedWorkspaces(
  workspaces: string[],
  customPath?: string
): RemoteAgentConfig {
  const normalized = workspaces.map((w) => path.resolve(w.trim()));
  const first = normalized[0];
  return updateRemoteAgentConfig(
    {
      workspaces: normalized,
      defaultWorkspace: first,
    },
    customPath
  );
}


