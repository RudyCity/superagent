import { DEFAULT_SELF_DEV_CONFIG, SELFDEV_CONFIG_VERSION, SELFDEV_LIMITS, type SelfDevConfig } from "../selfdev/types.js";

/**
 * Normalize untrusted persisted JSON. Missing values inherit current defaults;
 * malformed booleans fail closed. Legacy migration is handled by settings.ts,
 * which has enough context to distinguish persisted config from test overrides.
 */
export function normalizeSelfDevConfig(value: unknown): SelfDevConfig {
  const result: SelfDevConfig = { ...DEFAULT_SELF_DEV_CONFIG };
  if (value === undefined) return result;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    result.enabled = false;
    return result;
  }

  const data = value as Record<string, unknown>;
  const booleans = [
    "enabled",
    "collectionEnabled",
    "injectionEnabled",
    "redactSecrets",
    "requireKnownEvidence",
    "userOptOut",
  ] as const;
  let invalid = false;
  for (const key of booleans) {
    if (data[key] === undefined) continue;
    if (typeof data[key] !== "boolean") invalid = true;
    else result[key] = data[key];
  }

  if (invalid) result.enabled = false;
  // A recorded opt-out always takes precedence over the master flag.
  if (result.userOptOut) result.enabled = false;

  if (typeof data.configVersion === "number" && Number.isSafeInteger(data.configVersion) && data.configVersion >= 0) {
    result.configVersion = data.configVersion;
  } else {
    result.configVersion = SELFDEV_CONFIG_VERSION;
  }

  // Evidence is never persisted with secrets, regardless of stored config.
  result.redactSecrets = true;

  const caps = {
    maxEventsPerWorkspace: SELFDEV_LIMITS.MAX_EVENTS_PER_WORKSPACE,
    maxBatchSize: SELFDEV_LIMITS.MAX_BATCH_SIZE,
    maxLessons: SELFDEV_LIMITS.MAX_LESSONS,
  } as const;
  for (const key of Object.keys(caps) as Array<keyof typeof caps>) {
    const n = data[key];
    if (typeof n === "number" && Number.isFinite(n)) {
      result[key] = Math.max(1, Math.min(caps[key], Math.floor(n)));
    }
  }

  if (typeof data.storePath === "string" && data.storePath.trim() && data.storePath.length <= 4096) {
    result.storePath = data.storePath;
  }

  return result;
}
