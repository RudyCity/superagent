import { loadModelConfig, updateSettings } from "../config/jsonConfig.js";
import { normalizeSelfDevConfig } from "../config/selfdevConfig.js";
import { SELFDEV_CONFIG_VERSION, type SelfDevConfig } from "./types.js";

export { normalizeSelfDevConfig } from "../config/selfdevConfig.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Upgrade old persisted settings once. The previous implementation's default
 * was OFF, so a legacy enabled:false without an explicit opt-out marker is
 * treated as the old default. New opt-outs are always persisted explicitly.
 */
function migratePersistedSelfDevConfig(raw: unknown): SelfDevConfig {
  if (!isRecord(raw)) {
    return normalizeSelfDevConfig({
      ...{},
      enabled: raw === undefined ? true : false,
      userOptOut: false,
      configVersion: SELFDEV_CONFIG_VERSION,
    });
  }

  const explicitOptOut = raw.userOptOut === true;
  const hasValidLegacyEnabled = raw.enabled === undefined || typeof raw.enabled === "boolean";
  const enabled = explicitOptOut ? false : hasValidLegacyEnabled ? true : false;

  return normalizeSelfDevConfig({
    ...raw,
    enabled,
    userOptOut: explicitOptOut,
    configVersion: SELFDEV_CONFIG_VERSION,
  });
}

export function getSelfDevConfig(): SelfDevConfig {
  const raw = loadModelConfig().settings?.selfdev as unknown;
  if (isRecord(raw) &&
      typeof raw.configVersion === "number" &&
      raw.configVersion >= SELFDEV_CONFIG_VERSION) {
    return normalizeSelfDevConfig(raw);
  }

  // No Selfdev config on disk means a fresh install: persist the default-on
  // baseline once. Legacy false values are migrated unless explicitly opted out.
  const config = migratePersistedSelfDevConfig(raw);
  updateSettings({ selfdev: config });
  return config;
}

export function updateSelfDevConfig(updates: Partial<SelfDevConfig>): SelfDevConfig {
  const current = getSelfDevConfig();
  const next: Partial<SelfDevConfig> = { ...current, ...updates };

  if (Object.prototype.hasOwnProperty.call(updates, "enabled")) {
    next.userOptOut = updates.enabled === false;
    next.configVersion = SELFDEV_CONFIG_VERSION;
  } else {
    // Always save with the current schema/version once a user changes settings.
    next.configVersion = SELFDEV_CONFIG_VERSION;
  }

  const config = normalizeSelfDevConfig(next);
  updateSettings({ selfdev: config });
  return config;
}
