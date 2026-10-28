/**
 * runtimeMemoryDiagnostics.ts — Process memory and lifecycle telemetry.
 *
 * Provides:
 * - Runtime memory snapshots (RSS, heapUsed, heapTotal, external, arrayBuffers).
 * - Component lifecycle counters (MCP sessions, journal footprint, CLI Bridge sessions, delegate jobs).
 * - Memory pressure classification ("normal" | "elevated" | "critical") with soft guardrails.
 * - Operator-safe diagnostic summaries without secret or credential leakage.
 */

import os from "node:os";
import { getActivityJournal } from "../mcp/mcpActivityJournal.js";
import { getActiveSessionCount, getDetachedSessionCount } from "../tools/cliBridgeSession.js";
import { getActiveJobCount, getRetainedJobCount } from "../tools/cliBridgeDelegateJobs.js";

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
  mcp: {
    activityJournalSizeBytes: number;
    activityJournalArchiveCount: number;
    activityJournalTotalSizeBytes: number;
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

/** Thresholds in bytes for memory pressure evaluation */
export const MEMORY_PRESSURE_THRESHOLDS = {
  ELEVATED_RSS_BYTES: 1024 * 1024 * 1024,      // 1 GB
  CRITICAL_RSS_BYTES: 3 * 1024 * 1024 * 1024,  // 3 GB
  ELEVATED_HEAP_BYTES: 512 * 1024 * 1024,     // 512 MB
  CRITICAL_HEAP_BYTES: 1.5 * 1024 * 1024 * 1024, // 1.5 GB
  ELEVATED_JOURNAL_BYTES: 128 * 1024 * 1024,  // 128 MB
};

let mockPressureLevel: MemoryPressureLevel | null = null;
let lastPressureWarningAt = 0;
const PRESSURE_WARNING_COOLDOWN_MS = 60_000; // Rate limit warnings to once per 60s

export function __setMockMemoryPressureLevel(level: MemoryPressureLevel | null): void {
  mockPressureLevel = level;
}

export function warnMemoryPressureThrottling(reasons: string[]): boolean {
  const now = Date.now();
  if (now - lastPressureWarningAt < PRESSURE_WARNING_COOLDOWN_MS) {
    return false;
  }
  lastPressureWarningAt = now;
  const reasonText = reasons.length > 0 ? reasons.join("; ") : "threshold exceeded";
  console.warn(`[MEM_PRESSURE] Critical memory pressure detected: throttling optional observability enrichment. Reasons: ${reasonText}`);
  return true;
}

/**
 * Capture an in-process memory and lifecycle diagnostic snapshot.
 */
export function getRuntimeMemorySnapshot(): RuntimeMemorySnapshot {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const journalStats = getActivityJournal().getJournalStats();

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
    reasons.push(`Active activity journal size (${Math.round(journalStats.activeSizeBytes / 1024 / 1024)} MB) exceeds 128 MB`);
  }

  if (mockPressureLevel !== null) {
    level = mockPressureLevel;
    reasons.push(`Mock memory pressure active: ${mockPressureLevel}`);
  }

  const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;

  return {
    timestamp: Date.now(),
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
    mcp: {
      activityJournalSizeBytes: journalStats.activeSizeBytes,
      activityJournalArchiveCount: journalStats.archiveCount,
      activityJournalTotalSizeBytes: journalStats.totalSizeBytes,
    },
    cliBridge: {
      activeSessions,
      detachedSessions,
      activeJobs,
      retainedJobs,
    },
    pressure: {
      level,
      reasons,
    },
  };
}

/**
 * Pressure guardrail: whether optional verbose observability enrichment
 * should be deferred or curtailed to preserve memory under high load.
 * Rate-limits warning logs to at most once per 60s.
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
