/**
 * Agent-side Selfdev integration.
 *
 * Selfdev must remain best-effort: failures are counted with sanitized reason
 * codes, never propagated into the main agent task.
 */
import type { SelfDevEventInput } from "./types.js";
import type { SelfDevCollector } from "./collector.js";
import type { SelfDevLesson } from "./types.js";
import { SELFDEV_LIMITS } from "./types.js";
import type { FeedbackTracker } from "./feedback.js";

type CollectorEntry = {
  signature: string;
  collector: import("./collector.js").SelfDevCollector;
};

export interface SelfDevRuntimeMetrics {
  eventAttempts: number;
  eventsRecorded: number;
  eventRecordSkipped: number;
  eventRecordFailures: number;
  distillationRuns: number;
  distillationSuccesses: number;
  distillationFailures: number;
  distillationCoalesced: number;
  distillationBelowThreshold: number;
  distillationDurationMsTotal: number;
  promptInjectionFailures: number;
  lastErrorCode?: string;
  lastErrorAt?: number;
}

const initialMetrics = (): SelfDevRuntimeMetrics => ({
  eventAttempts: 0,
  eventsRecorded: 0,
  eventRecordSkipped: 0,
  eventRecordFailures: 0,
  distillationRuns: 0,
  distillationSuccesses: 0,
  distillationFailures: 0,
  distillationCoalesced: 0,
  distillationBelowThreshold: 0,
  distillationDurationMsTotal: 0,
  promptInjectionFailures: 0,
});

const runtimeMetrics = initialMetrics();
let feedbackTracker: FeedbackTracker | null = null;
const collectors = new Map<string, CollectorEntry>();
const distillInFlight = new Map<string, Promise<number>>();
const lastProcessedEventIds = new Map<string, Set<string>>();

// Require enough new evidence to avoid distilling after every individual task.
const MIN_NEW_EVENTS_FOR_AUTO_DISTILL = 4;
const MAX_CACHED_WORKSPACES = 32;

function recordError(code: string): void {
  runtimeMetrics.lastErrorCode = code;
  runtimeMetrics.lastErrorAt = Date.now();
}

function getWorkspaceKey(workspace: string): string {
  return workspace.trim();
}

async function getCollector(workspace: string): Promise<SelfDevCollector | null> {
  try {
    const { getSelfDevConfig } = await import("./settings.js");
    const cfg = getSelfDevConfig();
    if (!cfg.enabled || !cfg.collectionEnabled) return null;

    const key = getWorkspaceKey(workspace);
    if (!key) return null;
    const signature = JSON.stringify(cfg);
    const cached = collectors.get(key);
    if (cached?.signature === signature) return cached.collector;

    const { getHistoryDb } = await import("../storage/historyDb.js");
    const { SelfDevEventStore } = await import("./eventStore.js");
    const { SelfDevCollector } = await import("./collector.js");
    const store = new SelfDevEventStore({
      workspace: key,
      getDb: () => getHistoryDb() as any,
      config: cfg,
    });
    const entry = { signature, collector: new SelfDevCollector(store) };
    collectors.delete(key);
    collectors.set(key, entry);

    // Bound cache size for long-lived hosts that open many workspaces.
    while (collectors.size > MAX_CACHED_WORKSPACES) {
      const oldestKey = collectors.keys().next().value;
      if (oldestKey === undefined) break;
      collectors.delete(oldestKey);
    }
    return entry.collector;
  } catch {
    recordError("collector_initialization_failed");
    return null;
  }
}

/** Returns a copy of bounded in-process metrics; never includes event content. */
export function getSelfDevRuntimeMetrics(): SelfDevRuntimeMetrics {
  return { ...runtimeMetrics };
}

/** Test hook; resets counters only, not persisted events or lessons. */
export function resetSelfDevRuntimeMetrics(): void {
  Object.assign(runtimeMetrics, initialMetrics());
}

/** Reset cached collector(s), e.g. after tests or host workspace reconfiguration. */
export function resetSelfDevCollector(workspace?: string): void {
  if (workspace) {
    const key = getWorkspaceKey(workspace);
    collectors.delete(key);
    lastProcessedEventIds.delete(key);
  } else {
    collectors.clear();
    lastProcessedEventIds.clear();
    feedbackTracker = null;
  }
}

/** Records a safe, redacted event. Returns false rather than throwing on failure. */
export async function recordSelfDevEvent(input: SelfDevEventInput): Promise<boolean> {
  runtimeMetrics.eventAttempts += 1;
  try {
    const collector = await getCollector(input.workspace);
    if (!collector) {
      runtimeMetrics.eventRecordSkipped += 1;
      return false;
    }
    const result = collector.record(input);
    if (result.recorded) {
      runtimeMetrics.eventsRecorded += 1;
      return true;
    }
    runtimeMetrics.eventRecordSkipped += 1;
    if (result.reason && result.reason !== "disabled") recordError(result.reason);
    return false;
  } catch {
    runtimeMetrics.eventRecordFailures += 1;
    recordError("event_record_failed");
    return false;
  }
}

/**
 * Builds the bounded prompt block from explicitly approved lessons.
 * Returns empty text on failure, without leaking file paths or raw errors.
 */
export async function buildSelfDevInjectionBlock(workspace: string, sessionId?: string): Promise<string> {
  try {
    const { getSelfDevConfig } = await import("./settings.js");
    const cfg = getSelfDevConfig();
    if (!cfg.enabled || !cfg.injectionEnabled) return "";

    const { buildPromptInjectionBlock } = await import("./injector.js");
    const { getSelfDevLessonsPath } = await import("../config/paths.js");
    const injectedLessons: SelfDevLesson[] = [];
    const promptBlock = await buildPromptInjectionBlock({
      workspace,
      storePath: cfg.storePath || getSelfDevLessonsPath(),
      config: cfg,
      onLessonsInjected: lessons => injectedLessons.push(...lessons),
    });

    // Telemetry follows actual prompt block construction and is best-effort.
    // No lesson text is persisted to the feedback table.
    if (promptBlock && sessionId && injectedLessons.length > 0 && cfg.enabled) {
      const { getHistoryDb } = await import("../storage/historyDb.js");
      const { FeedbackTracker } = await import("./feedback.js");
      feedbackTracker ??= new FeedbackTracker({
        getDb: () => getHistoryDb() as any,
        enabled: () => cfg.enabled,
      });
      for (const lesson of injectedLessons) {
        feedbackTracker.record(workspace, sessionId, lesson.id, lesson.version, "injected");
      }
    }
    return promptBlock;
  } catch {
    runtimeMetrics.promptInjectionFailures += 1;
    recordError("prompt_injection_failed");
    return "";
  }
}

async function runAutoDistill(workspace: string): Promise<number> {
  const startedAt = Date.now();
  runtimeMetrics.distillationRuns += 1;
  try {
    const { getSelfDevConfig } = await import("./settings.js");
    const cfg = getSelfDevConfig();
    if (!cfg.enabled || !cfg.collectionEnabled) return 0;

    const { getHistoryDb } = await import("../storage/historyDb.js");
    const { SelfDevEventStore } = await import("./eventStore.js");
    const { CandidateStore } = await import("./candidateStore.js");
    const { distillAndStore } = await import("./distiller.js");
    const { getSelfDevLessonsPath } = await import("../config/paths.js");

    const eventStore = new SelfDevEventStore({
      workspace,
      getDb: () => getHistoryDb() as any,
      config: cfg,
    });
    const events = eventStore.list({ limit: Math.min(100, SELFDEV_LIMITS.MAX_LIST_LIMIT) });
    if (events.length === 0) return 0;

    const processed = lastProcessedEventIds.get(workspace) ?? new Set<string>();
    const fresh = events.filter(event => !processed.has(event.id));
    if (fresh.length < MIN_NEW_EVENTS_FOR_AUTO_DISTILL) {
      runtimeMetrics.distillationBelowThreshold += 1;
      return 0;
    }

    const storePath = cfg.storePath || getSelfDevLessonsPath();
    const candidateStore = new CandidateStore({
      storePath,
      workspace,
      enabled: () => {
        const live = getSelfDevConfig();
        return live.enabled;
      },
    });
    const existingLessons = await candidateStore.list();
    const saved = await distillAndStore({
      workspace,
      events,
      existingLessons,
      candidateStore,
      maxCandidates: 5,
      validateEvidence: id => eventStore.hasEvidence(id),
    });

    // Mark the observed event window only after a successful distillation pass.
    // Keep a bounded ID window so the cache does not grow with task history.
    lastProcessedEventIds.set(workspace, new Set(events.map(event => event.id)));
    runtimeMetrics.distillationSuccesses += 1;
    return saved.length;
  } catch {
    runtimeMetrics.distillationFailures += 1;
    recordError("distillation_failed");
    return 0;
  } finally {
    runtimeMetrics.distillationDurationMsTotal += Date.now() - startedAt;
  }
}

/**
 * Automatically distill bounded recent events. Concurrent calls for one
 * workspace share one operation; different workspaces remain independent.
 */
export async function maybeAutoDistill(workspace: string): Promise<number> {
  const key = getWorkspaceKey(workspace);
  if (!key) return 0;
  const existing = distillInFlight.get(key);
  if (existing) {
    runtimeMetrics.distillationCoalesced += 1;
    return existing;
  }

  const task = runAutoDistill(key);
  distillInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (distillInFlight.get(key) === task) distillInFlight.delete(key);
  }
}
