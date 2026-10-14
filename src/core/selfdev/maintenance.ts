import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { isValidLesson } from "./lessonValidation.js";
import { validateEvent } from "./eventValidation.js";
import type { CandidateStore } from "./candidateStore.js";
import type { FeedbackRecord, FeedbackTracker } from "./feedback.js";
import type { ReviewService } from "./reviewService.js";
import type { SelfDevEventStore } from "./eventStore.js";
import { SELFDEV_EVENT_KINDS, SELFDEV_LIMITS, type SelfDevEvent, type SelfDevLesson, type SelfDevReviewDecision } from "./types.js";

export const SELFDEV_BACKUP_FORMAT = "superagent-selfdev-backup";
export const SELFDEV_BACKUP_VERSION = 1;
export const SELFDEV_BACKUP_MAX_BYTES = 32 * 1024 * 1024;
const MAX_BUNDLE_EVENTS = SELFDEV_LIMITS.MAX_EVENTS_PER_WORKSPACE;
const MAX_BUNDLE_LESSONS = SELFDEV_LIMITS.MAX_LESSONS;
const MAX_BUNDLE_FEEDBACK = 5000;
const MAX_BUNDLE_DECISIONS = 500;

export interface SelfDevBundleData {
  events: SelfDevEvent[];
  lessons: SelfDevLesson[];
  feedback: FeedbackRecord[];
  reviewDecisions: SelfDevReviewDecision[];
}
export interface SelfDevBundleCounts {
  events: number;
  lessons: number;
  feedback: number;
  reviewDecisions: number;
}
export interface SelfDevBackupBundle {
  format: typeof SELFDEV_BACKUP_FORMAT;
  formatVersion: number;
  manifest: {
    createdAt: number;
    workspace: string;
    counts: SelfDevBundleCounts;
    redacted: true;
    sha256: string;
  };
  data: SelfDevBundleData;
}
export interface SelfDevMaintenanceStores {
  workspace: string;
  eventStore: SelfDevEventStore;
  candidateStore: CandidateStore;
  reviewService: ReviewService;
  feedbackTracker: FeedbackTracker;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactText(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi, "[REDACTED]")
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g, "[REDACTED]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, "[REDACTED]")
    .replace(/https?:\/\/[^\s)\]}]+/gi, "[URL REDACTED]");
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth >= 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redactValue(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[key] = /(?:api[_-]?key|access[_-]?token|token|secret|password|passwd|authorization|cookie)/i.test(key) ? "[REDACTED]" : redactValue(entry, depth + 1);
  }
  return output;
}

function sanitizeEvent(event: SelfDevEvent): SelfDevEvent {
  return {
    ...event,
    summary: redactText(event.summary),
    evidence: event.evidence.map(item => redactText(item)),
    tags: [...event.tags],
    ...(event.payload === undefined ? {} : { payload: redactValue(event.payload) as Record<string, unknown> }),
  };
}

function sanitizeLesson(lesson: SelfDevLesson): SelfDevLesson {
  return {
    ...lesson,
    statement: redactText(lesson.statement),
    ...(lesson.rationale === undefined ? {} : { rationale: redactText(lesson.rationale) }),
    ...(lesson.retiredReason === undefined ? {} : { retiredReason: redactText(lesson.retiredReason) }),
    evidenceIds: [...lesson.evidenceIds],
    tags: [...lesson.tags],
  };
}

function sanitizeDecision(decision: SelfDevReviewDecision): SelfDevReviewDecision {
  return { ...decision, ...(decision.reason === undefined ? {} : { reason: redactText(decision.reason).slice(0, 500) }) };
}

function countsFor(data: SelfDevBundleData): SelfDevBundleCounts {
  return {
    events: data.events.length,
    lessons: data.lessons.length,
    feedback: data.feedback.length,
    reviewDecisions: data.reviewDecisions.length,
  };
}

function checksumPayload(payload: {
  format: string;
  formatVersion: number;
  createdAt: number;
  workspace: string;
  counts: SelfDevBundleCounts;
  redacted: true;
  data: SelfDevBundleData;
}): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

async function collectAllEvents(eventStore: SelfDevEventStore): Promise<SelfDevEvent[]> {
  const count = eventStore.getWorkspaceEventCount();
  if (count > MAX_BUNDLE_EVENTS) throw new Error("Workspace event count exceeds export limit");
  const result: SelfDevEvent[] = [];
  for (let offset = 0; offset < count; offset += 1000) {
    result.push(...eventStore.list({ limit: 1000, offset }));
  }
  if (result.length !== count) throw new Error("Event export was incomplete; no backup was written");
  return result;
}

export async function createSelfDevBackupBundle(stores: SelfDevMaintenanceStores): Promise<SelfDevBackupBundle> {
  if (!stores.workspace.trim() || stores.workspace.length > SELFDEV_LIMITS.MAX_CONTEXT_ID_LENGTH) throw new Error("Invalid workspace");
  const [rawEvents, rawLessons, rawDecisions] = await Promise.all([
    collectAllEvents(stores.eventStore),
    stores.candidateStore.list(),
    stores.candidateStore.getReviewDecisions(),
  ]);
  const feedbackCount = stores.feedbackTracker.getRecordCount(stores.workspace);
  if (feedbackCount > MAX_BUNDLE_FEEDBACK) throw new Error("Feedback count exceeds export limit");
  const feedback = stores.feedbackTracker.listRecords(stores.workspace);
  if (feedback.length !== feedbackCount) throw new Error("Feedback export was incomplete; no backup was written");
  if (rawLessons.length > MAX_BUNDLE_LESSONS || rawDecisions.length > MAX_BUNDLE_DECISIONS) throw new Error("Lesson or review audit count exceeds export limit");
  const data: SelfDevBundleData = {
    events: rawEvents.map(sanitizeEvent),
    lessons: rawLessons.map(sanitizeLesson),
    feedback: feedback.map(record => ({ ...record })),
    reviewDecisions: rawDecisions.map(sanitizeDecision),
  };
  const createdAt = Date.now();
  const counts = countsFor(data);
  const payload = {
    format: SELFDEV_BACKUP_FORMAT,
    formatVersion: SELFDEV_BACKUP_VERSION,
    createdAt,
    workspace: stores.workspace,
    counts,
    redacted: true as const,
    data,
  };
  const bundle: SelfDevBackupBundle = {
    format: SELFDEV_BACKUP_FORMAT,
    formatVersion: SELFDEV_BACKUP_VERSION,
    manifest: { createdAt, workspace: stores.workspace, counts, redacted: true, sha256: checksumPayload(payload) },
    data,
  };
  validateSelfDevBackupBundle(bundle, stores.workspace);
  return bundle;
}

export function validateSelfDevBackupBundle(input: unknown, expectedWorkspace?: string): SelfDevBackupBundle {
  if (!isRecord(input) || input.format !== SELFDEV_BACKUP_FORMAT || input.formatVersion !== SELFDEV_BACKUP_VERSION ||
      !isRecord(input.manifest) || !isRecord(input.manifest.counts) || !isRecord(input.data)) {
    throw new Error("Unsupported or malformed Selfdev backup format");
  }
  const manifest = input.manifest;
  const data = input.data as unknown as SelfDevBundleData;
  if (typeof manifest.workspace !== "string" || !manifest.workspace.trim() ||
      manifest.workspace.length > SELFDEV_LIMITS.MAX_CONTEXT_ID_LENGTH ||
      (expectedWorkspace !== undefined && manifest.workspace !== expectedWorkspace)) {
    throw new Error("Backup workspace mismatch");
  }
  if (!Number.isSafeInteger(manifest.createdAt) || manifest.createdAt < 0 || manifest.redacted !== true ||
      typeof manifest.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.sha256)) {
    throw new Error("Invalid backup manifest or checksum");
  }
  if (!Array.isArray(data.events) || !Array.isArray(data.lessons) || !Array.isArray(data.feedback) || !Array.isArray(data.reviewDecisions)) {
    throw new Error("Backup data arrays are missing");
  }
  const counts = countsFor(data);
  if (JSON.stringify(counts) !== JSON.stringify(manifest.counts) ||
      counts.events > MAX_BUNDLE_EVENTS || counts.lessons > MAX_BUNDLE_LESSONS ||
      counts.feedback > MAX_BUNDLE_FEEDBACK || counts.reviewDecisions > MAX_BUNDLE_DECISIONS) {
    throw new Error("Backup record counts are invalid or exceed limits");
  }
  const checksum = checksumPayload({
    format: input.format,
    formatVersion: input.formatVersion,
    createdAt: manifest.createdAt,
    workspace: manifest.workspace,
    counts,
    redacted: true,
    data,
  });
  if (checksum !== manifest.sha256) throw new Error("Backup checksum mismatch");

  const eventIds = new Set<string>();
  for (const event of data.events) {
    if (!isRecord(event) || event.workspace !== manifest.workspace || typeof event.id !== "string" || !event.id.trim() ||
        !Number.isSafeInteger(event.ts) || event.ts < 0 || typeof event.sessionId !== "string" ||
        !SELFDEV_EVENT_KINDS.includes(event.kind) || typeof event.summary !== "string" ||
        event.summary.length > SELFDEV_LIMITS.MAX_SUMMARY_LENGTH || !Array.isArray(event.evidence) || !Array.isArray(event.tags) ||
        !Number.isSafeInteger(event.redactionCount) || event.redactionCount < 0 || eventIds.has(event.id)) {
      throw new Error("Invalid event data or cross-workspace event");
    }
    try {
      const { redactionCount: _redactionCount, ...eventInput } = event;
      validateEvent(eventInput, manifest.workspace);
    } catch {
      throw new Error("Invalid event payload or cross-workspace data");
    }
    eventIds.add(event.id);
  }
  const lessonIds = new Set<string>();
  for (const lesson of data.lessons) {
    if (!isValidLesson(lesson) || lesson.workspace !== manifest.workspace || lessonIds.has(lesson.id)) {
      throw new Error("Invalid lesson data or cross-workspace lesson");
    }
    lessonIds.add(lesson.id);
    if (lesson.status !== "retired" && lesson.evidenceIds.some(id => !eventIds.has(id))) {
      throw new Error(`Lesson ${lesson.id} has missing evidence; restore is refused`);
    }
  }
  const feedbackKeys = new Set<string>();
  for (const record of data.feedback) {
    if (!isRecord(record) || record.workspace !== manifest.workspace || typeof record.sessionId !== "string" ||
        !record.sessionId.trim() || typeof record.lessonId !== "string" || !record.lessonId.trim() ||
        !Number.isSafeInteger(record.version) || record.version < 1 || !Number.isSafeInteger(record.ts) || record.ts < 0 ||
        !["injected", "applied", "helped", "harmed"].includes(record.metric)) throw new Error("Invalid feedback record");
    const key = JSON.stringify([record.sessionId, record.lessonId, record.version, record.metric]);
    if (feedbackKeys.has(key)) throw new Error("Duplicate feedback record");
    feedbackKeys.add(key);
  }
  for (const decision of data.reviewDecisions) {
    if (!isRecord(decision) || decision.workspace !== manifest.workspace || typeof decision.lessonId !== "string" ||
        !Number.isSafeInteger(decision.lessonVersion) || decision.lessonVersion < 1 ||
        !["approved", "rejected", "retired", "edited"].includes(decision.action) ||
        typeof decision.actor !== "string" || !decision.actor.trim() ||
        !Number.isSafeInteger(decision.timestamp) || decision.timestamp < 0 ||
        (decision.reason !== undefined && (typeof decision.reason !== "string" || decision.reason.length > 500))) {
      throw new Error("Invalid review audit record");
    }
  }
  return input as SelfDevBackupBundle;
}

export async function readSelfDevBackupBundle(filePath: string, expectedWorkspace?: string): Promise<SelfDevBackupBundle> {
  const handle = await open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > SELFDEV_BACKUP_MAX_BYTES) throw new Error("Backup file exceeds size limit or is not a regular file");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > SELFDEV_BACKUP_MAX_BYTES) throw new Error("Backup file grew beyond size limit while reading");
    return validateSelfDevBackupBundle(JSON.parse(text) as unknown, expectedWorkspace);
  } finally {
    await handle.close();
  }
}

export async function writeSelfDevBackupBundle(filePath: string, bundle: SelfDevBackupBundle, overwrite = false): Promise<void> {
  validateSelfDevBackupBundle(bundle, bundle.manifest.workspace);
  const resolved = path.resolve(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  if (!overwrite) {
    try {
      await access(resolved);
      throw new Error("Destination already exists; specify --overwrite to replace it");
    } catch (error) {
      if (isRecord(error) && error.message === "Destination already exists; specify --overwrite to replace it") throw error;
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  const bytes = Buffer.from(JSON.stringify(bundle, null, 2), "utf8");
  if (bytes.length > SELFDEV_BACKUP_MAX_BYTES) throw new Error("Generated backup exceeds maximum file size");
  const tempPath = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  const temp = await open(tempPath, "wx", 0o600);
  let renamed = false;
  try {
    try { await temp.writeFile(bytes); await temp.sync(); }
    finally { await temp.close(); }
    if (!overwrite) {
      try {
        await access(resolved);
        throw new Error("Destination appeared while writing; backup was not replaced");
      } catch (error) {
        if (isRecord(error) && error.message === "Destination appeared while writing; backup was not replaced") throw error;
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
    }
    await rename(tempPath, resolved);
    renamed = true;
  } finally {
    if (!renamed) await unlink(tempPath).catch(() => {});
  }
}

export async function inspectSelfDevRetention(stores: SelfDevMaintenanceStores, days: number) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new Error("Retention days must be an integer from 1 to 3650");
  const events = await collectAllEvents(stores.eventStore);
  const lessons = await stores.candidateStore.list();
  const protectedIds = new Set(lessons.flatMap(lesson => lesson.evidenceIds));
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const eligible = events.filter(event => event.ts < cutoffMs);
  const protectedEvents = eligible.filter(event => protectedIds.has(event.id));
  const deletable = eligible.filter(event => !protectedIds.has(event.id));
  return {
    workspace: stores.workspace,
    days,
    cutoffMs,
    totalEvents: events.length,
    oldEvents: eligible.length,
    protectedEvents: protectedEvents.length,
    deletableEvents: deletable.length,
    protectedIds: protectedEvents.map(event => event.id),
    deletableIds: deletable.map(event => event.id),
  };
}

export async function applySelfDevRetention(stores: SelfDevMaintenanceStores, days: number): Promise<number> {
  const report = await inspectSelfDevRetention(stores, days);
  return stores.eventStore.deleteEventsById(report.deletableIds);
}

export async function restoreSelfDevBackupBundle(stores: SelfDevMaintenanceStores, bundle: SelfDevBackupBundle): Promise<void> {
  validateSelfDevBackupBundle(bundle, stores.workspace);
  const [currentEvents, currentLessons, currentFeedback] = [
    stores.eventStore.getWorkspaceEventCount(),
    (await stores.candidateStore.list()).length,
    stores.feedbackTracker.getRecordCount(stores.workspace),
  ];
  const currentDecisions = await stores.candidateStore.getReviewDecisions();
  if (currentEvents !== 0 || currentLessons !== 0 || currentFeedback !== 0 || currentDecisions.length !== 0) {
    throw new Error("Restore requires an empty target workspace across events, lessons, review audit, and feedback");
  }
  let lessonsWritten = false;
  let eventsWritten = false;
  let feedbackWritten = false;
  try {
    await stores.candidateStore.restoreWorkspaceRecords(bundle.data.lessons, bundle.data.reviewDecisions);
    lessonsWritten = true;
    stores.eventStore.restoreWorkspaceEvents(bundle.data.events);
    eventsWritten = true;
    stores.feedbackTracker.restoreRecords(stores.workspace, bundle.data.feedback);
    feedbackWritten = true;
  } catch (error) {
    const rollbackFailures: string[] = [];
    if (feedbackWritten || stores.feedbackTracker.getRecordCount(stores.workspace) > 0) {
      stores.feedbackTracker.removeWorkspaceRecords(stores.workspace);
        if (stores.feedbackTracker.getRecordCount(stores.workspace) !== 0) rollbackFailures.push("feedback");
    }
    if (eventsWritten || stores.eventStore.getWorkspaceEventCount() > 0) {
      try { stores.eventStore.deleteEventsById(bundle.data.events.map(event => event.id)); }
      catch { rollbackFailures.push("events"); }
    }
    if (lessonsWritten) {
      try { await stores.candidateStore.removeWorkspaceRecords(); }
      catch { rollbackFailures.push("lessons"); }
    }
    if (rollbackFailures.length) throw new Error(`Restore failed and compensating rollback was incomplete for: ${rollbackFailures.join(", ")}`);
    throw error;
  }
}
