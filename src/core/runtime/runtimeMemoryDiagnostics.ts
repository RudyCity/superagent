/**
 * runtimeMemoryDiagnostics.ts — Process memory and lifecycle telemetry.
 *
 * Provides bounded process/session telemetry plus an early sustained-growth
 * detector so leaks are visible well before absolute GiB thresholds.
 */

import { getActivityJournal } from "../mcp/mcpActivityJournal.js";
import { getMcpProcessSessionTelemetry } from "../mcp/mcpSessionTelemetry.js";
import { getActiveSessionCount, getDetachedSessionCount } from "../tools/cliBridgeSession.js";
import { getActiveJobCount, getRetainedJobCount } from "../tools/cliBridgeDelegateJobs.js";
import {
  assessMemoryTrend, trimMemoryTrendSamples,
  type MemoryTrendAssessment, type MemoryTrendSample,
} from "./memoryTrend.js";

export type MemoryPressureLevel = "normal" | "elevated" | "critical";

export interface RuntimeMemorySnapshot {
  timestamp: number;
  uptimeSeconds: number;
  pid: number;
  memory: {
    rssBytes: number;
    rssMb: number;
    heapUsedBytes: number;
    heapUsedMb: number;
    heapTotalBytes: number;
    heapTotalMb: number;
    externalBytes: number;
    externalMb: number;
    arrayBuffersBytes?: number;
    arrayBuffersMb?: number;
  };
  trend: MemoryTrendAssessment;
  mcp: {
    activityJournalSizeBytes: number;
    activityJournalArchiveCount: number;
    activityJournalTotalSizeBytes: number;
    activeSessions: number;
    activePrincipals: number;
    largestPrincipalSessionCount: number;
    oldestSessionAgeMs: number;
    oldestIdleMs: number;
    rejectedTotal: number;
  };
  cliBridge: {
    activeSessions: number;
    detachedSessions: number;
    activeJobs: number;
    retainedJobs: number;
  };
  pressure: {
    level: MemoryPressureLevel;
    reasons: string[];
  };
}

/** Absolute guardrails remain a last line of defense. */
export const MEMORY_PRESSURE_THRESHOLDS = {
  ELEVATED_RSS_BYTES: 1024 * 1024 * 1024,       // 1 GB
  CRITICAL_RSS_BYTES: 3 * 1024 * 1024 * 1024,  // 3 GB
  ELEVATED_HEAP_BYTES: 512 * 1024 * 1024,       // 512 MB
  CRITICAL_HEAP_BYTES: 1.5 * 1024 * 1024 * 1024, // 1.5 GB
  ELEVATED_JOURNAL_BYTES: 128 * 1024 * 1024,    // 128 MB
};

const MEMORY_TREND_SAMPLE_INTERVAL_MS = 60_000;
const MEMORY_TREND_MIN_GAP_MS = 10_000;
const MEMORY_TREND_MAX_SAMPLES = 30;
const memoryTrendSamples: MemoryTrendSample[] = [];
let mockPressureLevel: MemoryPressureLevel | null = null;
let lastPressureWarningAt = 0;
const PRESSURE_WARNING_COOLDOWN_MS = 60_000;

function recordMemoryTrendSample(
  memory: NodeJS.MemoryUsage = process.memoryUsage(),
  at = Date.now(),
): void {
  const previous = memoryTrendSamples[memoryTrendSamples.length - 1];
  if (previous && at - previous.at < MEMORY_TREND_MIN_GAP_MS) return;
  const next = trimMemoryTrendSamples([
    ...memoryTrendSamples,
    { at, rssBytes: memory.rss, heapUsedBytes: memory.heapUsed },
  ], MEMORY_TREND_MAX_SAMPLES);
  memoryTrendSamples.splice(0, memoryTrendSamples.length, ...next);
}

const memoryTrendTimer = setInterval(
  () => recordMemoryTrendSample(),
  MEMORY_TREND_SAMPLE_INTERVAL_MS,
);
memoryTrendTimer.unref?.();
recordMemoryTrendSample();

export function __setMockMemoryPressureLevel(level: MemoryPressureLevel | null): void {
  mockPressureLevel = level;
}

export function warnMemoryPressureThrottling(reasons: string[]): boolean {
  const now = Date.now();
  if (now - lastPressureWarningAt < PRESSURE_WARNING_COOLDOWN_MS) return false;
  lastPressureWarningAt = now;
  const reasonText = reasons.length > 0 ? reasons.join("; ") : "threshold exceeded";
  console.warn(
    `[MEM_PRESSURE] Critical memory pressure detected: throttling optional observability enrichment. Reasons: ${reasonText}`,
  );
  return true;
}

/** Capture an in-process memory and lifecycle diagnostic snapshot. */
export function getRuntimeMemorySnapshot(): RuntimeMemorySnapshot {
  const now = Date.now();
  const mem = process.memoryUsage();
  recordMemoryTrendSample(mem, now);
  const trend = assessMemoryTrend(memoryTrendSamples);
  const uptime = process.uptime();
  const journalStats = getActivityJournal().getJournalStats();
  const mcpSessions = getMcpProcessSessionTelemetry();

  let activeSessions = 0;
  let detachedSessions = 0;
  try {
    activeSessions = getActiveSessionCount();
    detachedSessions = getDetachedSessionCount();
  } catch {}

  let activeJobs = 0;
  let retainedJobs = 0;
  try {
    activeJobs = getActiveJobCount();
    retainedJobs = getRetainedJobCount();
  } catch {}

  const reasons: string[] = [];
  let level: MemoryPressureLevel = "normal";

  if (mem.rss >= MEMORY_PRESSURE_THRESHOLDS.CRITICAL_RSS_BYTES) {
    level = "critical";
    reasons.push(`Process RSS (${Math.round(mem.rss / 1024 / 1024)} MB) exceeds critical threshold (3072 MB)`);
  } else if (mem.rss >= MEMORY_PRESSURE_THRESHOLDS.ELEVATED_RSS_BYTES) {
    level = "elevated";
    reasons.push(`Process RSS (${Math.round(mem.rss / 1024 / 1024)} MB) exceeds elevated threshold (1024 MB)`);
  }

  if (mem.heapUsed >= MEMORY_PRESSURE_THRESHOLDS.CRITICAL_HEAP_BYTES) {
    level = "critical";
    reasons.push(`Heap used (${Math.round(mem.heapUsed / 1024 / 1024)} MB) exceeds critical threshold (1536 MB)`);
  } else if (mem.heapUsed >= MEMORY_PRESSURE_THRESHOLDS.ELEVATED_HEAP_BYTES) {
    if (level !== "critical") level = "elevated";
    reasons.push(`Heap used (${Math.round(mem.heapUsed / 1024 / 1024)} MB) exceeds elevated threshold (512 MB)`);
  }

  if (journalStats.activeSizeBytes >= MEMORY_PRESSURE_THRESHOLDS.ELEVATED_JOURNAL_BYTES) {
    if (level === "normal") level = "elevated";
    reasons.push(
      `Active activity journal size (${Math.round(journalStats.activeSizeBytes / 1024 / 1024)} MB) exceeds 128 MB`,
    );
  }

  if (trend.suspicious) {
    if (level === "normal") level = "elevated";
    reasons.push(
      `Sustained memory growth detected before absolute threshold (${trend.reasons.join(", ")})`,
    );
  }

  if (mockPressureLevel !== null) {
    level = mockPressureLevel;
    reasons.push(`Mock memory pressure active: ${mockPressureLevel}`);
  }

  const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;

  return {
    timestamp: now,
    uptimeSeconds: Math.round(uptime),
    pid: process.pid,
    memory: {
      rssBytes: mem.rss,
      rssMb: toMb(mem.rss),
      heapUsedBytes: mem.heapUsed,
      heapUsedMb: toMb(mem.heapUsed),
      heapTotalBytes: mem.heapTotal,
      heapTotalMb: toMb(mem.heapTotal),
      externalBytes: mem.external,
      externalMb: toMb(mem.external),
      arrayBuffersBytes: mem.arrayBuffers,
      arrayBuffersMb: mem.arrayBuffers ? toMb(mem.arrayBuffers) : undefined,
    },
    trend,
    mcp: {
      activityJournalSizeBytes: journalStats.activeSizeBytes,
      activityJournalArchiveCount: journalStats.archiveCount,
      activityJournalTotalSizeBytes: journalStats.totalSizeBytes,
      activeSessions: mcpSessions.activeSessions,
      activePrincipals: mcpSessions.activePrincipals,
      largestPrincipalSessionCount: mcpSessions.largestPrincipalSessionCount,
      oldestSessionAgeMs: mcpSessions.oldestSessionAgeMs,
      oldestIdleMs: mcpSessions.oldestIdleMs,
      rejectedTotal: mcpSessions.rejectedTotal,
    },
    cliBridge: {
      activeSessions,
      detachedSessions,
      activeJobs,
      retainedJobs,
    },
    pressure: { level, reasons },
  };
}

/**
 * Pressure guardrail: optional verbose observability is curtailed only under
 * critical pressure. Sustained-growth telemetry remains visible at elevated.
 */
export function shouldThrottleLargeObservability(): boolean {
  if (mockPressureLevel === "critical") {
    warnMemoryPressureThrottling(["mocked critical memory pressure"]);
    return true;
  }
  const snap = getRuntimeMemorySnapshot();
  if (snap.pressure.level === "critical") {
    warnMemoryPressureThrottling(snap.pressure.reasons);
    return true;
  }
  return false;
}
