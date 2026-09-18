import { getSettings, updateSettings } from "../config/jsonConfig.js";
import { normalizeSelfDevConfig } from "../config/selfdevConfig.js";
import type { SelfDevConfig } from "./types.js";

export { normalizeSelfDevConfig } from "../config/selfdevConfig.js";

export function getSelfDevConfig(): SelfDevConfig {
  return normalizeSelfDevConfig(getSettings().selfdev);
}

export function updateSelfDevConfig(updates: Partial<SelfDevConfig>): SelfDevConfig {
  const config = normalizeSelfDevConfig({ ...getSelfDevConfig(), ...updates });
  updateSettings({ selfdev: config });
  return config;
}
