import { previewMemoryRetention, redactMemorySecrets } from "./memoryLifecycle.js";
import { getRMemoryClient, getRMemoryProjectId } from "./rmemoryUtil.js";

export interface MemoryRetentionSweepOptions {
  projectPath?: string;
  apply?: boolean;
  limit?: number;
  exportLimit?: number;
  now?: number | Date | string;
  /** Test seam; production callers use the configured RMemory client. */
  client?: any;
}

export interface MemoryRetentionSweepResult {
  mode: "preview_only" | "applied";
  projectId: string;
  scanned: number;
  eligibleToExpire: number;
  skippedQuarantined: number;
  byScope: { global: number; project: number };
  exportTruncated: boolean;
  items: Array<{
    id: string;
    scope: "global" | "project";
    projectId?: string;
    expectedUpdatedAt?: string;
    state: "stale" | "expired";
    reason: string;
    ageDays?: number;
  }>;
  markedExpired?: number;
  conflicts?: number;
  skipped?: number;
  failed?: number;
  results?: Array<{ id: string; scope: "global" | "project"; status: string; reason?: string }>;
}

/**
 * Preview or non-destructively expire stale memories in the active project plus
 * global scope. This routine never deletes content. Oldest-first paging plus a
 * compare-and-set update makes repeated scheduled runs advance through large
 * collections without repeatedly selecting the same freshly-updated records.
 */
export async function runMemoryRetentionSweep(
  options: MemoryRetentionSweepOptions = {},
): Promise<MemoryRetentionSweepResult> {
  const projectPath = options.projectPath || process.cwd();
  const projectId = getRMemoryProjectId(projectPath);
  const client = options.client || getRMemoryClient(10_000);
  const requestedExportLimit = options.exportLimit ?? 500;
  const exportLimit = Number.isFinite(requestedExportLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedExportLimit)))
    : 500;
  const requestedLimit = options.limit ?? 200;
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
    : 200;

  const exported = await client.exportAtomic({
    projectId,
    includeGlobal: true,
    limit: exportLimit,
    sortBy: "updatedAtAsc",
  });
  const preview = previewMemoryRetention(exported.items || [], { now: options.now, limit });
  const result: MemoryRetentionSweepResult = {
    mode: options.apply ? "applied" : "preview_only",
    projectId,
    scanned: preview.scanned,
    eligibleToExpire: preview.eligibleToMarkStale,
    skippedQuarantined: preview.skippedQuarantined,
    byScope: preview.byScope,
    exportTruncated: !!exported.truncated,
    items: preview.items,
  };

  if (!options.apply) return result;

  const results: NonNullable<MemoryRetentionSweepResult["results"]> = [];
  for (const item of preview.items) {
    if (!item.expectedUpdatedAt) {
      results.push({ id: item.id, scope: item.scope, status: "skipped", reason: "missing_updated_at_compare_token" });
      continue;
    }
    try {
      const updated = await client.markAtomicExpired({
        id: item.id,
        scope: item.scope,
        projectId,
        expectedUpdatedAt: item.expectedUpdatedAt,
        reason: "system-memory-retention-sweep:" + item.reason,
      });
      results.push({
        id: item.id,
        scope: item.scope,
        status: String(updated?.status || "unknown"),
        ...(updated?.status === "conflict" ? { reason: "memory_changed_since_sweep_preview" } : {}),
        ...(updated?.status === "needs_migration" ? { reason: "legacy_scope_requires_review" } : {}),
      });
    } catch (error) {
      results.push({
        id: item.id,
        scope: item.scope,
        status: "failed",
        reason: redactMemorySecrets(error instanceof Error ? error.message : String(error)).slice(0, 240),
      });
    }
  }

  result.results = results;
  result.markedExpired = results.filter((entry) => entry.status === "marked_expired").length;
  result.conflicts = results.filter((entry) => entry.status === "conflict").length;
  result.skipped = results.filter((entry) => entry.status === "skipped" || entry.status === "not_found" || entry.status === "needs_migration").length;
  result.failed = results.filter((entry) => entry.status === "failed").length;
  return result;
}
