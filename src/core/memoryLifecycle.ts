import type { MemoryRetentionClass, MemoryValidationStatus } from "./memoryRecord.js";

export interface AtomicMemoryForReview {
  id: string;
  content: string;
  scope?: "global" | "project";
  metadata?: Record<string, unknown>;
}
export type MemoryFreshnessState = "fresh" | "unverified" | "stale" | "expired" | "conflicted" | "quarantined" | "superseded" | "rejected";
export interface MemoryFreshnessAssessment {
  state: MemoryFreshnessState;
  shouldInject: boolean;
  warning?: string;
  reason: string;
  ageDays?: number;
  retentionClass?: MemoryRetentionClass;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RETENTION_REVIEW_ITEMS = 500;
const RETENTION_MAX_AGE_DAYS: Partial<Record<MemoryRetentionClass, number>> = {
  temporary: 7, environment: 30, decision: 180, "task-summary": 30,
};
function asMetadata(record: AtomicMemoryForReview): Record<string, unknown> {
  return record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata) ? record.metadata : {};
}
function parseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function inferRetentionClass(metadata: Record<string, unknown>): MemoryRetentionClass | undefined {
  const explicit = metadata.retentionClass;
  if (["durable", "temporary", "environment", "decision", "task-summary", "superseded"].includes(String(explicit))) return explicit as MemoryRetentionClass;
  const type = String(metadata.memoryType ?? metadata.type ?? "").toLowerCase();
  if (/preference|convention|persona|stable|durable/.test(type)) return "durable";
  if (/temporary|incident|deadline|ephemeral|short.?lived/.test(type)) return "temporary";
  if (/environment|runtime|deployment|version|host.?state/.test(type)) return "environment";
  if (/decision|architecture|project.?decision/.test(type)) return "decision";
  if (/task.?summary|task-summary/.test(type)) return "task-summary";
  return undefined;
}

/** Type-aware freshness. Unknown types have no inferred TTL; durable preferences do not age out. */
export function assessMemoryFreshness(record: AtomicMemoryForReview, now: number | Date | string = Date.now()): MemoryFreshnessAssessment {
  const metadata = asMetadata(record);
  const nowMs = parseTime(now instanceof Date ? now.getTime() : now) ?? Date.now();
  const retentionClass = inferRetentionClass(metadata);
  const lifecycle = String(metadata.lifecycleState ?? "active");
  const validation = String(metadata.validationStatus ?? "unverified") as MemoryValidationStatus;
  const review = String(metadata.reviewState ?? "unreviewed");
  const expiredAt = parseTime(metadata.expiresAt);
  if (review === "quarantined") return { state: "quarantined", shouldInject: false, reason: "owner_review_required", retentionClass };
  if (lifecycle === "superseded" || metadata.supersededByMemoryId || retentionClass === "superseded") return { state: "superseded", shouldInject: false, reason: "superseded_by_revision", retentionClass };
  if (lifecycle === "conflicted" || (Array.isArray(metadata.conflictWithMemoryIds) && metadata.conflictWithMemoryIds.length > 0)) return { state: "conflicted", shouldInject: false, warning: "Conflicting assertions are preserved for owner review.", reason: "scoped_assertion_conflict", retentionClass };
  if (lifecycle === "expired" || (expiredAt !== undefined && expiredAt <= nowMs)) return { state: "expired", shouldInject: false, warning: "This memory has passed its explicit expiry; review before reuse.", reason: "explicit_expiry_reached", retentionClass };
  if (validation === "rejected") return { state: "rejected", shouldInject: false, reason: "rejected_by_review", retentionClass };
  if (validation === "stale") return { state: "stale", shouldInject: false, warning: "This memory is marked stale and should be revalidated before use.", reason: "explicitly_marked_stale", retentionClass };
  const maxAgeDays = retentionClass ? RETENTION_MAX_AGE_DAYS[retentionClass] : undefined;
  const anchor = parseTime(metadata.lastVerifiedAt) ?? parseTime(metadata.updatedAt) ?? parseTime(metadata.createdAt);
  if (maxAgeDays !== undefined && anchor !== undefined) {
    const ageMs = Math.max(0, nowMs - anchor);
    if (ageMs > maxAgeDays * DAY_MS) return { state: "stale", shouldInject: false, warning: `This ${retentionClass} memory is older than its ${maxAgeDays}-day review interval.`, reason: `type_specific_freshness_interval_exceeded_${maxAgeDays}_days`, ageDays: Math.floor(ageMs / DAY_MS), retentionClass };
    if (validation === "unverified" || validation === "candidate") return { state: "unverified", shouldInject: true, warning: "This memory is not verified; age alone does not validate it.", reason: "not_verified", ageDays: Math.floor(ageMs / DAY_MS), retentionClass };
    return { state: "fresh", shouldInject: true, reason: "within_type_specific_freshness_interval", ageDays: Math.floor(ageMs / DAY_MS), retentionClass };
  }
  if (validation === "unverified" || validation === "candidate") return { state: "unverified", shouldInject: true, warning: "This memory is not verified; treat it as reference, not authority.", reason: "not_verified", retentionClass };
  return { state: "fresh", shouldInject: true, reason: "no_expiry_policy_triggered", retentionClass };
}
function scopedIdentity(metadata: Record<string, unknown>): string | undefined {
  if (metadata.scope === "global") return "global";
  if (metadata.scope === "project" && typeof metadata.projectId === "string" && metadata.projectId.trim()) return `project:${metadata.projectId}`;
  return undefined;
}
function normalizedAssertion(content: string): string {
  return content.replace(/^\[(?:global|project(?::[^\]]+)?)\]\s*/i, "").trim().replace(/\s+/g, " ").toLowerCase();
}
/** Similarity is never conflict proof: both records need the same explicit assertion key and exact scope. */
export function detectScopedMemoryConflicts(records: AtomicMemoryForReview[]): Array<{ assertionKey: string; scopeKey: string; memoryIds: [string, string] }> {
  const groups = new Map<string, AtomicMemoryForReview[]>();
  for (const record of records) {
    const meta = asMetadata(record);
    const assertionKey = typeof meta.assertionKey === "string" ? meta.assertionKey.trim() : "";
    const scopeKey = scopedIdentity(meta);
    if (!assertionKey || !scopeKey || !record.id || meta.reviewState === "quarantined" || meta.lifecycleState === "superseded") continue;
    const key = `${scopeKey}\0${assertionKey}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const conflicts: Array<{ assertionKey: string; scopeKey: string; memoryIds: [string, string] }> = [];
  for (const [key, group] of groups) {
    const [scopeKey, assertionKey] = key.split("\0");
    const uniqueAssertions = new Map<string, AtomicMemoryForReview>();
    for (const record of group) {
      const normalized = normalizedAssertion(record.content);
      if (!uniqueAssertions.has(normalized)) uniqueAssertions.set(normalized, record);
    }
    const representatives = [...uniqueAssertions.values()];
    for (let i = 0; i < representatives.length; i++) for (let j = i + 1; j < representatives.length; j++) {
      if (representatives[i].id !== representatives[j].id) conflicts.push({ assertionKey, scopeKey, memoryIds: [representatives[i].id, representatives[j].id] });
    }
  }
  return conflicts;
}

export interface MemoryRecallFilterResult<T extends AtomicMemoryForReview> {
  items: T[];
  scopedCount: number;
  withheldCount: number;
  crossScopeRejectedCount: number;
  conflictPairCount: number;
  conflictingRecordCount: number;
}

/** Canonical scope-first recall filter for HTTP, CLI and tools. Ambiguous legacy rows fail closed. */
export function filterEligibleMemoryRecords<T extends AtomicMemoryForReview>(
  records: T[], options: { projectId: string; scope?: "all" | "project" | "global"; now?: number | Date | string },
): MemoryRecallFilterResult<T> {
  const scope = options.scope ?? "all";
  const scoped: T[] = [];
  for (const record of records) {
    const metadata = asMetadata(record);
    if (metadata.type === "memory_revision") continue;
    const content = String(record.content || "");
    const recordScope = metadata.scope;
    const isGlobal = recordScope === "global" || (!recordScope && content.startsWith("[global]"));
    const isProject = (recordScope === "project" && metadata.projectId === options.projectId)
      || (!recordScope && content.startsWith(`[project:${options.projectId}]`));
    if ((scope === "global" && !isGlobal) || (scope === "project" && !isProject)
      || (scope === "all" && !isGlobal && !isProject)) continue;
    scoped.push(record);
  }
  const atomicForConflict = scoped.filter(record => {
    const metadata = asMetadata(record);
    return metadata.type !== "message" && !metadata.session;
  });
  const conflicts = detectScopedMemoryConflicts(atomicForConflict);
  const conflictingIds = new Set(conflicts.flatMap(conflict => conflict.memoryIds));
  const eligible = scoped.filter(record => {
    const metadata = asMetadata(record);
    if (metadata.type === "message" || metadata.session) return true;
    if (conflictingIds.has(record.id)) return false;
    return assessMemoryFreshness(record, options.now).shouldInject;
  });
  return {
    items: eligible,
    scopedCount: scoped.length,
    withheldCount: scoped.length - eligible.length,
    crossScopeRejectedCount: records.length - scoped.length,
    conflictPairCount: conflicts.length,
    conflictingRecordCount: conflictingIds.size,
  };
}

export interface MemoryRetentionPreview {
  scanned: number;
  eligibleToMarkStale: number;
  skippedQuarantined: number;
  byScope: Record<"global" | "project", number>;
  items: Array<{ id: string; scope: "global" | "project"; projectId?: string; expectedUpdatedAt?: string; reason: string; ageDays?: number }>;
}
/** Preview-only policy: never deletes and excludes quarantined, durable, conflicted and superseded records. */
export function previewMemoryRetention(records: AtomicMemoryForReview[], options: { now?: number | Date | string; limit?: number } = {}): MemoryRetentionPreview {
  const limit = Math.max(1, Math.min(MAX_RETENTION_REVIEW_ITEMS, Math.floor(options.limit ?? 100)));
  const items: MemoryRetentionPreview["items"] = [];
  let skippedQuarantined = 0;
  for (const record of records) {
    const metadata = asMetadata(record);
    if (metadata.reviewState === "quarantined") { skippedQuarantined++; continue; }
    if (metadata.validationStatus === "stale" || metadata.lifecycleState === "superseded" || metadata.lifecycleState === "conflicted") continue;
    const assessment = assessMemoryFreshness(record, options.now);
    if (assessment.state !== "stale" && assessment.state !== "expired") continue;
    const scope = metadata.scope === "global" ? "global" : metadata.scope === "project" ? "project" : record.scope;
    if (scope !== "global" && scope !== "project") continue;
    if (scope === "project" && typeof metadata.projectId !== "string") continue;
    if (!metadata.retentionClass && !assessment.retentionClass && !metadata.expiresAt) continue;
    items.push({
      id: record.id, scope,
      ...(scope === "project" && typeof metadata.projectId === "string" ? { projectId: metadata.projectId } : {}),
      ...(typeof metadata.updatedAt === "string" ? { expectedUpdatedAt: metadata.updatedAt } : {}),
      reason: assessment.reason,
      ...(assessment.ageDays !== undefined ? { ageDays: assessment.ageDays } : {}),
    });
    if (items.length >= limit) break;
  }
  return { scanned: records.length, eligibleToMarkStale: items.length, skippedQuarantined,
    byScope: { global: items.filter(item => item.scope === "global").length, project: items.filter(item => item.scope === "project").length }, items };
}

/** Redact common credentials and tokens before task summaries or evidence are persisted. */
export function redactMemorySecrets(input: string): string {
  return input
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, "[REDACTED_AUTH]")
    .replace(/\b(cookie|set-cookie)\b["\']?\s*[:=]\s*[^\r\n]*/gi, "$1 [REDACTED_COOKIE]")
    .replace(/(--(?:api-key|token|password|secret|cookie|authorization))\s+\S+/gi, "$1 [REDACTED]")
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s/]+@[^\s]+/gi, "[REDACTED_CONNECTION_STRING]")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_JWT]")
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)(["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, "$1$2[REDACTED]")
    .slice(0, 4000);
}

export interface CompletedTaskSummaryInput {
  taskId: string;
  projectId: string;
  terminalEventPersisted: boolean;
  terminalEvent: { id: string; kind: string; payload?: Record<string, unknown>; summary?: string };
  evidence: Array<{ id: string; taskId: string; persisted: boolean; kind: string; verifiedSuccess?: boolean }>;
  changedFiles?: string[];
  blockers?: string[];
  followUp?: string;
}
/** Builds a structured candidate summary only for a persisted completed event and evidence belonging to that task. */
export function buildCompletedTaskSummary(input: CompletedTaskSummaryInput) {
  if (!input.taskId.trim() || !input.projectId.trim() || !input.terminalEvent.id.trim()) return null;
  if (!input.terminalEventPersisted || input.terminalEvent.kind !== "task_completed" || input.terminalEvent.payload?.taskId !== input.taskId) return null;
  const evidence = input.evidence.filter(item => item.persisted && item.id.trim() && item.taskId === input.taskId);
  const evidenceIds = Array.from(new Set(evidence.map(item => item.id))).slice(0, 50);
  const verificationEvidence = evidence.filter(item => item.kind === "test_result" || item.kind === "build_result");
  const validationStatus = evidenceIds.length > 0 && verificationEvidence.length > 0 && verificationEvidence.every(item => item.verifiedSuccess === true) ? "verified" as const : "unverified" as const;
  return {
    taskId: input.taskId, projectId: input.projectId, outcome: "completed" as const,
    terminalEventId: input.terminalEvent.id, evidenceIds, validationStatus,
    summary: redactMemorySecrets(input.terminalEvent.summary ?? "Task completed").slice(0, 300),
    changedFiles: Array.from(new Set((input.changedFiles ?? []).map(value => redactMemorySecrets(value).slice(0, 240)))).slice(0, 50),
    blockers: Array.from(new Set((input.blockers ?? []).map(value => redactMemorySecrets(value).slice(0, 240)))).slice(0, 20),
    ...(input.followUp ? { followUp: redactMemorySecrets(input.followUp).slice(0, 500) } : {}),
  };
}
