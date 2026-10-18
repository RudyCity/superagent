export const MEMORY_RECORD_SCHEMA_VERSION = 1 as const;

export type MemoryRecordScope = "global" | "project";
export type MemoryValidationStatus = "unverified" | "candidate" | "verified" | "stale" | "rejected";
export type MemoryEvidenceKind = "task" | "test" | "build" | "user_feedback" | "source" | "other";
export type MemoryReviewState = "unreviewed" | "reviewed" | "quarantined";
export type MemoryLifecycleState = "active" | "conflicted" | "superseded" | "expired";
export type MemoryRetentionClass = "durable" | "temporary" | "environment" | "decision" | "task-summary" | "superseded";

export interface MemoryEvidenceReference {
  id: string;
  kind: MemoryEvidenceKind;
  reference?: string;
  summary?: string;
  status?: string;
  recordedAt?: string;
}

export interface MemoryRecordProvenance {
  source: string;
  agentTier?: string;
  sessionId?: string;
  taskId?: string;
}

export interface MemoryRecordMetadata extends Record<string, unknown> {
  schemaVersion: typeof MEMORY_RECORD_SCHEMA_VERSION;
  memoryId: string;
  type: "memory";
  memoryType: string;
  scope: MemoryRecordScope;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
  validationStatus: MemoryValidationStatus;
  reviewState?: MemoryReviewState;
  lifecycleState?: MemoryLifecycleState;
  retentionClass?: MemoryRetentionClass;
  assertionKey?: string;
  lastVerifiedAt?: string;
  expiresAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  quarantineReason?: string;
  conflictWithMemoryIds?: string[];
  conflictDetectedAt?: string;
  conflictDetectedBy?: string;
  conflictReason?: string;
  supersedesMemoryId?: string;
  supersededByMemoryId?: string;
  supersededAt?: string;
  revisionNumber?: number;
  mappedFromLegacyId?: string;
  mappedAt?: string;
  mappingReason?: string;
  provenance: MemoryRecordProvenance;
  evidence?: MemoryEvidenceReference[];
}

export interface CreateMemoryRecordMetadataInput {
  memoryId: string;
  memoryType?: string;
  scope: MemoryRecordScope;
  projectId?: string;
  sessionId?: string;
  taskId?: string;
  source: string;
  agentTier?: string;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  now?: string | Date;
  validationStatus?: MemoryValidationStatus;
  evidence?: MemoryEvidenceReference[];
  existingMetadata?: unknown;
}

const VALIDATION_STATUSES = new Set<MemoryValidationStatus>([
  "unverified",
  "candidate",
  "verified",
  "stale",
  "rejected",
]);
const EVIDENCE_KINDS = new Set<MemoryEvidenceKind>([
  "task",
  "test",
  "build",
  "user_feedback",
  "source",
  "other",
]);
const REVIEW_STATES = new Set<MemoryReviewState>(["unreviewed", "reviewed", "quarantined"]);
const LIFECYCLE_STATES = new Set<MemoryLifecycleState>(["active", "conflicted", "superseded", "expired"]);
const RETENTION_CLASSES = new Set<MemoryRetentionClass>(["durable", "temporary", "environment", "decision", "task-summary", "superseded"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().slice(0, maxLength);
  return clean || undefined;
}

function requiredIdentifier(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty identifier`);
  const clean = value.trim();
  if (clean.length > maxLength) throw new Error(`${label} must not exceed ${maxLength} characters`);
  return clean;
}

function optionalIdentifier(value: unknown, maxLength: number): string | undefined {
  return cleanString(value, maxLength);
}

function cleanIdentifierList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = Array.from(new Set(value.flatMap((entry) => {
    const id = cleanString(entry, 160);
    return id ? [id] : [];
  }))).slice(0, 20);
  return ids.length ? ids : undefined;
}

function validTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isFinite(value.getTime())) return undefined;
  const raw = value instanceof Date ? value.toISOString() : typeof value === "string" ? value : undefined;
  if (!raw || !Number.isFinite(Date.parse(raw))) return undefined;
  return new Date(raw).toISOString();
}

function sanitizeEvidence(evidence: unknown): MemoryEvidenceReference[] | undefined {
  if (!Array.isArray(evidence)) return undefined;
  const result: MemoryEvidenceReference[] = [];
  for (const raw of evidence.slice(0, 20)) {
    const item = asRecord(raw);
    const id = cleanString(item.id, 160);
    if (!id) continue;
    const kind = EVIDENCE_KINDS.has(item.kind as MemoryEvidenceKind)
      ? item.kind as MemoryEvidenceKind
      : "other";
    const reference = cleanString(item.reference, 240);
    const summary = cleanString(item.summary, 240);
    const status = cleanString(item.status, 32);
    const recordedAt = validTimestamp(item.recordedAt);
    result.push({
      id,
      kind,
      ...(reference ? { reference } : {}),
      ...(summary ? { summary } : {}),
      ...(status ? { status } : {}),
      ...(recordedAt ? { recordedAt } : {}),
    });
  }
  return result;
}

/**
 * Creates the canonical v1 metadata envelope for a persistent atomic memory.
 * The physical RMemory key remains the storage ID; memoryId records the stable
 * logical identity so exported records keep their identity across migrations.
 */
export function createMemoryRecordMetadata(
  input: CreateMemoryRecordMetadataInput,
): MemoryRecordMetadata {
  const memoryId = requiredIdentifier(input.memoryId, "memoryId", 160);

  if (input.scope !== "global" && input.scope !== "project") {
    throw new Error("scope must be either global or project");
  }

  const projectId = input.projectId === undefined ? undefined : requiredIdentifier(input.projectId, "projectId", 128);
  if (input.scope === "project" && !projectId) {
    throw new Error("projectId is required for project-scoped memory");
  }

  const source = cleanString(input.source, 80);
  if (!source) throw new Error("source must be a non-empty provenance label");

  const existing = asRecord(input.existingMetadata);
  const existingProvenance = asRecord(existing.provenance);
  const now = validTimestamp(input.now) || new Date().toISOString();
  const createdAt = validTimestamp(input.createdAt)
    || validTimestamp(existing.createdAt)
    || now;
  const updatedAt = validTimestamp(input.updatedAt) || now;
  const memoryType = cleanString(input.memoryType, 64) || "fact";
  const sessionId = cleanString(input.sessionId, 128);
  const taskId = cleanString(input.taskId, 128);
  const agentTier = cleanString(input.agentTier, 40);
  const validationStatus = input.validationStatus && VALIDATION_STATUSES.has(input.validationStatus)
    ? input.validationStatus
    : "unverified";
  const evidence = sanitizeEvidence(input.evidence);
  const reviewState = REVIEW_STATES.has(existing.reviewState as MemoryReviewState)
    ? existing.reviewState as MemoryReviewState
    : "unreviewed";
  const lifecycleState = LIFECYCLE_STATES.has(existing.lifecycleState as MemoryLifecycleState)
    ? existing.lifecycleState as MemoryLifecycleState
    : "active";
  const retentionClass = RETENTION_CLASSES.has(existing.retentionClass as MemoryRetentionClass)
    ? existing.retentionClass as MemoryRetentionClass
    : undefined;
  const assertionKey = optionalIdentifier(existing.assertionKey, 160);
  const lastVerifiedAt = validTimestamp(existing.lastVerifiedAt);
  const expiresAt = validTimestamp(existing.expiresAt);
  const reviewedAt = validTimestamp(existing.reviewedAt);
  const reviewedBy = optionalIdentifier(existing.reviewedBy, 128);
  const quarantineReason = cleanString(existing.quarantineReason, 240);
  const conflictWithMemoryIds = cleanIdentifierList(existing.conflictWithMemoryIds);
  const conflictDetectedAt = validTimestamp(existing.conflictDetectedAt);
  const conflictDetectedBy = optionalIdentifier(existing.conflictDetectedBy, 128);
  const conflictReason = cleanString(existing.conflictReason, 240);
  const supersedesMemoryId = optionalIdentifier(existing.supersedesMemoryId, 160);
  const supersededByMemoryId = optionalIdentifier(existing.supersededByMemoryId, 160);
  const supersededAt = validTimestamp(existing.supersededAt);
  const revisionNumber = Number.isSafeInteger(existing.revisionNumber) && Number(existing.revisionNumber) >= 1
    ? Math.min(100000, Number(existing.revisionNumber))
    : undefined;
  const mappedFromLegacyId = optionalIdentifier(existing.mappedFromLegacyId, 160);
  const mappedAt = validTimestamp(existing.mappedAt);
  const mappingReason = cleanString(existing.mappingReason, 200);

  return {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    memoryId,
    type: "memory",
    memoryType,
    scope: input.scope,
    ...(input.scope === "project" ? { projectId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(taskId ? { taskId } : {}),
    createdAt,
    updatedAt,
    validationStatus,
    reviewState,
    lifecycleState,
    ...(retentionClass ? { retentionClass } : {}),
    ...(assertionKey ? { assertionKey } : {}),
    ...(lastVerifiedAt ? { lastVerifiedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(reviewedAt ? { reviewedAt } : {}),
    ...(reviewedBy ? { reviewedBy } : {}),
    ...(quarantineReason ? { quarantineReason } : {}),
    ...(conflictWithMemoryIds ? { conflictWithMemoryIds } : {}),
    ...(conflictDetectedAt ? { conflictDetectedAt } : {}),
    ...(conflictDetectedBy ? { conflictDetectedBy } : {}),
    ...(conflictReason ? { conflictReason } : {}),
    ...(supersedesMemoryId ? { supersedesMemoryId } : {}),
    ...(supersededByMemoryId ? { supersededByMemoryId } : {}),
    ...(supersededAt ? { supersededAt } : {}),
    ...(revisionNumber ? { revisionNumber } : {}),
    ...(mappedFromLegacyId ? { mappedFromLegacyId } : {}),
    ...(mappedAt ? { mappedAt } : {}),
    ...(mappingReason ? { mappingReason } : {}),
    provenance: {
      source,
      ...(agentTier ? { agentTier } : {}),
      ...(sessionId || cleanString(existing.sessionId, 128) || cleanString(existingProvenance.sessionId, 128)
        ? { sessionId: sessionId || cleanString(existing.sessionId, 128) || cleanString(existingProvenance.sessionId, 128) }
        : {}),
      ...(taskId || cleanString(existing.taskId, 128) || cleanString(existingProvenance.taskId, 128)
        ? { taskId: taskId || cleanString(existing.taskId, 128) || cleanString(existingProvenance.taskId, 128) }
        : {}),
    },
    ...(evidence && evidence.length > 0 ? { evidence } : {}),
  };
}

function isValidEvidenceArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > 20) return false;
  return value.every((raw) => {
    const item = asRecord(raw);
    if (!cleanString(item.id, 160) || !EVIDENCE_KINDS.has(item.kind as MemoryEvidenceKind)) return false;
    if (item.reference !== undefined && (typeof item.reference !== "string" || item.reference.length > 240)) return false;
    if (item.summary !== undefined && (typeof item.summary !== "string" || item.summary.length > 240)) return false;
    if (item.status !== undefined && (typeof item.status !== "string" || item.status.length > 32)) return false;
    if (item.recordedAt !== undefined && !validTimestamp(item.recordedAt)) return false;
    return true;
  });
}

export function isMemoryRecordMetadata(value: unknown): value is MemoryRecordMetadata {
  const metadata = asRecord(value);
  if (metadata.schemaVersion !== MEMORY_RECORD_SCHEMA_VERSION) return false;
  if (!cleanString(metadata.memoryId, 160) || metadata.type !== "memory") return false;
  if (!cleanString(metadata.memoryType, 64)) return false;
  if (metadata.scope !== "global" && metadata.scope !== "project") return false;
  if (metadata.scope === "project" && !cleanString(metadata.projectId, 128)) return false;
  if (metadata.scope === "global" && metadata.projectId !== undefined) return false;
  if (!validTimestamp(metadata.createdAt) || !validTimestamp(metadata.updatedAt)) return false;
  if (!VALIDATION_STATUSES.has(metadata.validationStatus as MemoryValidationStatus)) return false;
  if (metadata.reviewState !== undefined && !REVIEW_STATES.has(metadata.reviewState as MemoryReviewState)) return false;
  if (metadata.lifecycleState !== undefined && !LIFECYCLE_STATES.has(metadata.lifecycleState as MemoryLifecycleState)) return false;
  if (metadata.retentionClass !== undefined && !RETENTION_CLASSES.has(metadata.retentionClass as MemoryRetentionClass)) return false;
  if (metadata.assertionKey !== undefined && !cleanString(metadata.assertionKey, 160)) return false;
  for (const timestampKey of ["lastVerifiedAt", "expiresAt", "reviewedAt", "supersededAt"] as const) {
    if (metadata[timestampKey] !== undefined && !validTimestamp(metadata[timestampKey])) return false;
  }
  for (const identifierKey of ["reviewedBy", "supersedesMemoryId", "supersededByMemoryId"] as const) {
    if (metadata[identifierKey] !== undefined && !cleanString(metadata[identifierKey], 160)) return false;
  }
  if (metadata.quarantineReason !== undefined && !cleanString(metadata.quarantineReason, 240)) return false;
  if (metadata.conflictWithMemoryIds !== undefined && (!Array.isArray(metadata.conflictWithMemoryIds) || metadata.conflictWithMemoryIds.length > 20 || !metadata.conflictWithMemoryIds.every((id) => cleanString(id, 160)))) return false;
  if (metadata.conflictDetectedAt !== undefined && !validTimestamp(metadata.conflictDetectedAt)) return false;
  if (metadata.conflictDetectedBy !== undefined && !cleanString(metadata.conflictDetectedBy, 128)) return false;
  if (metadata.conflictReason !== undefined && !cleanString(metadata.conflictReason, 240)) return false;
  if (metadata.revisionNumber !== undefined && (!Number.isSafeInteger(metadata.revisionNumber) || Number(metadata.revisionNumber) < 1 || Number(metadata.revisionNumber) > 100000)) return false;
  if (metadata.mappedFromLegacyId !== undefined && !cleanString(metadata.mappedFromLegacyId, 160)) return false;
  if (metadata.mappedAt !== undefined && !validTimestamp(metadata.mappedAt)) return false;
  if (metadata.mappingReason !== undefined && !cleanString(metadata.mappingReason, 200)) return false;
  if (!cleanString(asRecord(metadata.provenance).source, 80)) return false;
  if (metadata.evidence !== undefined && !isValidEvidenceArray(metadata.evidence)) return false;
  return true;
}
