import { DEFAULT_SELF_DEV_CONFIG, SELFDEV_LIMITS, type SelfDevConfig } from "../selfdev/types.js";

/** Pure JSON boundary: invalid booleans disable the system, never coerce truthy values. */
export function normalizeSelfDevConfig(value: unknown): SelfDevConfig {
  const result: SelfDevConfig = { ...DEFAULT_SELF_DEV_CONFIG };
  if (value === undefined) return result;
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const data = value as Record<string, unknown>;
  const booleans = ["enabled", "collectionEnabled", "injectionEnabled", "redactSecrets", "requireKnownEvidence"] as const;
  let invalid = false;
  for (const key of booleans) {
    if (data[key] === undefined) continue;
    if (typeof data[key] !== "boolean") invalid = true;
    else result[key] = data[key];
  }
  if (invalid) result.enabled = false;
  // Evidence is never persisted with secrets, regardless of legacy configuration.
  result.redactSecrets = true;
  const caps = {
    maxEventsPerWorkspace: SELFDEV_LIMITS.MAX_EVENTS_PER_WORKSPACE,
    maxBatchSize: SELFDEV_LIMITS.MAX_BATCH_SIZE,
    maxLessons: SELFDEV_LIMITS.MAX_LESSONS,
  } as const;
  for (const key of Object.keys(caps) as Array<keyof typeof caps>) {
    const n = data[key];
    if (typeof n === "number" && Number.isFinite(n)) result[key] = Math.max(1, Math.min(caps[key], Math.floor(n)));
  }
  if (typeof data.storePath === "string" && data.storePath.trim() && data.storePath.length <= 4096) {
    result.storePath = data.storePath;
  }
  return result;
}
