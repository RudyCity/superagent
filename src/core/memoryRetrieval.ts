import { assessMemoryFreshness, detectScopedMemoryConflicts } from "./memoryLifecycle.js";

export interface MemorySearchHit {
  memory?: { id?: string; content?: string; metadata?: Record<string, any> };
  distance?: number;
  score?: number;
}

export interface MemoryRankedHit {
  id: string;
  content: string;
  type: string;
  score: number;
  metadata?: Record<string, any>;
}

/**
 * Merge independent hybrid search lists without comparing incompatible raw
 * distances. Scope and lifecycle validation occur *before* top-K truncation.
 * Reciprocal rank fusion also prevents any one index from dominating by scale.
 */
export function fuseScopedMemoryHits(
  lists: readonly (readonly MemorySearchHit[])[],
  projectId: string,
  limit: number,
  now: number = Date.now(),
): MemoryRankedHit[] {
  const k = Math.max(1, Math.min(50, Number.isFinite(limit) ? Math.floor(limit) : 5));
  const matchesScope = (hit: MemorySearchHit): boolean => {
    const m = hit.memory;
    if (!m?.id || !m.content) return false;
    const meta = m.metadata || {};
    if (meta.type === "memory_revision" || meta.internalProbe) return false;
    if (meta.scope === "global") return true;
    if (meta.scope === "project") return meta.projectId === projectId;
    if (meta.scope) return false;
    // Only legacy rows with an unambiguous exact prefix can be recovered.
    return m.content.startsWith("[global]") || m.content.startsWith(`[project:${projectId}]`);
  };

  const pooled = new Map<string, { hit: MemorySearchHit; points: number }>();
  for (const hits of lists) {
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (!matchesScope(hit)) continue;
      const id = String(hit.memory!.id);
      const prev = pooled.get(id);
      const points = 1 / (60 + i + 1);
      if (prev) prev.points += points;
      else pooled.set(id, { hit, points });
    }
  }
  const candidates = [...pooled.values()].map(({ hit, points }) => {
    const memory = hit.memory!;
    return { id: String(memory.id), content: String(memory.content), metadata: memory.metadata || {},
      type: String(memory.metadata?.memoryType || memory.metadata?.type || "memory"), score: points };
  });
  const conflicts = detectScopedMemoryConflicts(candidates
    .filter(m => m.metadata?.type !== "message" && !m.metadata?.session));
  const blocked = new Set(conflicts.flatMap(x => x.memoryIds));
  const eligible = candidates.filter(record =>
    !blocked.has(record.id) && (record.metadata?.type === "message" || record.metadata?.session ||
      assessMemoryFreshness(record, now).shouldInject));
  // Identical assertions in the same scope should not waste context budget.
  // Conflicting assertions are handled above, never auto-merged.
  const dedup = new Map<string, (typeof eligible)[number]>();
  for (const record of eligible) {
    const scope = record.metadata.scope === "global" || record.content.startsWith("[global]")
      ? "global" : projectId;
    const key = `${scope}\0${record.content.replace(/^\[(?:global|project:[^\]]+)\]\s*/, "").trim().replace(/\s+/g, " ").toLowerCase()}`;
    const verification = record.metadata.validationStatus === "verified" ? 0.001 : 0;
    const recency = Date.parse(record.metadata.lastVerifiedAt || record.metadata.updatedAt || "") || 0;
    const existing = dedup.get(key);
    const quality = (r: typeof record) => r.score + (r.metadata.validationStatus === "verified" ? 0.001 : 0);
    if (!existing || record.score + verification > quality(existing) ||
        (record.score + verification === quality(existing) && recency > (Date.parse(existing.metadata.updatedAt || "") || 0))) {
      dedup.set(key, record);
    }
  }
  return [...dedup.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k);
}
