import fs from "fs";
import path from "path";
import { getGlobalConfigDir, ensureGlobalConfigDir } from "./config/paths.js";

export type AdvisorReason =
  | "loop_warning"
  | "loop_pause"
  | "hallucinated_tool"
  | "consecutive_errors"
  | "consecutive_errors_pause"
  | "pattern_memory_warning"
  | "repeated_read_warning"
  | "repeated_read_loop"
  | "alternating_loop_warning"
  | "alternating_loop_pause";

export interface AdvisorEvent {
  timestamp: string;
  agentId?: string;
  action: "warn_agent" | "pause_execution";
  reason: AdvisorReason;
  toolNames?: string[];
  consecutiveCount?: number;
  message: string;
  suggestion?: string;
}

export interface AdvisorMetrics {
  totalEvents: number;
  totalWarnings: number;
  totalPauses: number;
  reasonsCount: Record<string, number>;
  topLoopTools: Array<{ tool: string; count: number }>;
}

export function getAdvisorEventsFilePath(): string {
  return path.join(getGlobalConfigDir(), "advisor-events.json");
}

export function getAdvisorPatternsFilePath(): string {
  return path.join(getGlobalConfigDir(), "advisor-patterns.json");
}

/** Max events kept in advisor-events.json */
const MAX_EVENTS = 500;

/** Max distinct patterns kept in advisor-patterns.json */
const MAX_PATTERNS = 200;

/** Patterns older than this are considered stale and evicted (24 hours) */
const PATTERN_TTL_MS = 24 * 60 * 60 * 1000;

// -------------------------------------------------------------------
// In-memory pattern cache: authoritative source for getFailedPattern()
// Disk is only for persistence across restarts; reads load into cache.
// -------------------------------------------------------------------
interface PatternEntry {
  toolName: string;
  errorMessage: string;
  failCount: number;
  lastFailed: string;
}

const patternCache: Map<string, PatternEntry> = new Map();
let patternCacheLoaded = false;
let patternFlushTimer: ReturnType<typeof setTimeout> | null = null;

function ensurePatternCacheLoaded(): void {
  if (patternCacheLoaded) return;
  patternCacheLoaded = true;
  try {
    const filePath = getAdvisorPatternsFilePath();
    if (!fs.existsSync(filePath)) return;
    const raw = fs.readFileSync(filePath, "utf-8");
    const patterns: Record<string, PatternEntry> = JSON.parse(raw) || {};
    const now = Date.now();
    for (const [sig, entry] of Object.entries(patterns)) {
      if (!entry.lastFailed || now - new Date(entry.lastFailed).getTime() <= PATTERN_TTL_MS) {
        patternCache.set(sig, entry);
      }
    }
  } catch {
    // Non-blocking load failure
  }
}

function persistPatternCacheAsync(): void {
  if (patternFlushTimer) return;
  patternFlushTimer = setTimeout(async () => {
    patternFlushTimer = null;
    try {
      ensureGlobalConfigDir();
      const filePath = getAdvisorPatternsFilePath();
      const obj: Record<string, PatternEntry> = {};
      for (const [sig, entry] of patternCache.entries()) {
        obj[sig] = entry;
      }
      await fs.promises.writeFile(filePath, JSON.stringify(obj, null, 2), "utf-8");
    } catch {
      // Non-blocking write failure
    }
  }, 250);
}

// -------------------------------------------------------------------
// In-memory events cache with debounced async flush
// -------------------------------------------------------------------
let eventsCache: AdvisorEvent[] | null = null;
let eventsFlushTimer: ReturnType<typeof setTimeout> | null = null;

function ensureEventsCacheLoaded(): AdvisorEvent[] {
  if (eventsCache !== null) return eventsCache;
  try {
    const filePath = getAdvisorEventsFilePath();
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        eventsCache = parsed;
        return eventsCache;
      }
    }
  } catch {
    // Non-blocking load fallback
  }
  eventsCache = [];
  return eventsCache;
}

function scheduleEventsFlush(): void {
  if (eventsFlushTimer) return;
  eventsFlushTimer = setTimeout(async () => {
    eventsFlushTimer = null;
    try {
      if (!eventsCache) return;
      ensureGlobalConfigDir();
      const filePath = getAdvisorEventsFilePath();
      await fs.promises.writeFile(filePath, JSON.stringify(eventsCache, null, 2), "utf-8");
    } catch {
      // Non-blocking log write failure
    }
  }, 250);
}

export function logAdvisorEvent(event: Omit<AdvisorEvent, "timestamp">): void {
  const cache = ensureEventsCacheLoaded();
  const fullEvent: AdvisorEvent = {
    timestamp: new Date().toISOString(),
    ...event,
  };
  cache.push(fullEvent);
  if (cache.length > MAX_EVENTS) {
    eventsCache = cache.slice(cache.length - MAX_EVENTS);
  }
  scheduleEventsFlush();
}

export function logFailedPattern(callSignature: string, toolName: string, errorMessage: string): void {
  // Synchronously update in-memory cache so getFailedPattern() sees it immediately
  ensurePatternCacheLoaded();
  const now = Date.now();

  // Evict stale entries
  for (const [sig, entry] of patternCache.entries()) {
    if (entry.lastFailed && now - new Date(entry.lastFailed).getTime() > PATTERN_TTL_MS) {
      patternCache.delete(sig);
    }
  }

  // LRU cap: remove oldest entries if over limit
  if (patternCache.size >= MAX_PATTERNS) {
    const sorted = [...patternCache.entries()].sort(
      ([, a], [, b]) => new Date(a.lastFailed).getTime() - new Date(b.lastFailed).getTime()
    );
    const toRemove = sorted.slice(0, patternCache.size - MAX_PATTERNS + 1);
    for (const [k] of toRemove) patternCache.delete(k);
  }

  const existing = patternCache.get(callSignature) || { toolName, errorMessage, failCount: 0, lastFailed: "" };
  existing.failCount += 1;
  existing.lastFailed = new Date().toISOString();
  existing.errorMessage = errorMessage;
  patternCache.set(callSignature, existing);

  // Debounced persist to disk
  persistPatternCacheAsync();
}

export function getFailedPattern(callSignature: string): { toolName: string; errorMessage: string; failCount: number } | null {
  ensurePatternCacheLoaded();
  const item = patternCache.get(callSignature);
  if (!item || item.failCount < 2) return null;
  // Skip stale patterns even on read
  if (item.lastFailed && Date.now() - new Date(item.lastFailed).getTime() > PATTERN_TTL_MS) {
    patternCache.delete(callSignature);
    return null;
  }
  return item;
}

export function getAdvisorEvents(limit = 50, agentId?: string): AdvisorEvent[] {
  const cache = ensureEventsCacheLoaded();
  let result = cache;
  if (agentId) {
    result = result.filter(e => !e.agentId || e.agentId === agentId);
  }
  return result.slice(-limit);
}

export function clearAdvisorEvents(): boolean {
  try {
    if (eventsFlushTimer) {
      clearTimeout(eventsFlushTimer);
      eventsFlushTimer = null;
    }
    if (patternFlushTimer) {
      clearTimeout(patternFlushTimer);
      patternFlushTimer = null;
    }
    patternCache.clear();
    patternCacheLoaded = true;
    eventsCache = [];

    const filePath = getAdvisorEventsFilePath();
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify([], null, 2), "utf-8");
    }
    const patternsPath = getAdvisorPatternsFilePath();
    if (fs.existsSync(patternsPath)) {
      fs.writeFileSync(patternsPath, JSON.stringify({}, null, 2), "utf-8");
    }
    return true;
  } catch {
    return false;
  }
}

export function exportAdvisorEvents(targetPath?: string): string | null {
  try {
    const filePath = getAdvisorEventsFilePath();
    const cache = ensureEventsCacheLoaded();
    const exportPath = targetPath || path.join(process.cwd(), `advisor-events-export-${Date.now()}.json`);
    fs.writeFileSync(exportPath, JSON.stringify(cache, null, 2), "utf-8");
    return exportPath;
  } catch {
    return null;
  }
}

export function getAdvisorMetrics(): AdvisorMetrics {
  const events = getAdvisorEvents(500);
  const reasonsCount: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  let totalWarnings = 0;
  let totalPauses = 0;

  for (const e of events) {
    if (e.action === "warn_agent") totalWarnings++;
    if (e.action === "pause_execution") totalPauses++;

    reasonsCount[e.reason] = (reasonsCount[e.reason] || 0) + 1;

    if (e.toolNames) {
      for (const t of e.toolNames) {
        toolCounts[t] = (toolCounts[t] || 0) + 1;
      }
    }
  }

  const topLoopTools = Object.entries(toolCounts)
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalEvents: events.length,
    totalWarnings,
    totalPauses,
    reasonsCount,
    topLoopTools,
  };
}
