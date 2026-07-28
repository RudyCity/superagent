import fs from "fs";
import path from "path";
import { getGlobalConfigDir, ensureGlobalConfigDir } from "./config/paths.js";

export interface AdvisorEvent {
  timestamp: string;
  agentId?: string;
  action: "warn_agent" | "pause_execution";
  reason: "loop_warning" | "loop_pause" | "hallucinated_tool" | "consecutive_errors" | "pattern_memory_warning";
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
  Promise.resolve().then(async () => {
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
  });
}

// -------------------------------------------------------------------

export function logAdvisorEvent(event: Omit<AdvisorEvent, "timestamp">): void {
  // Fire-and-forget: async write so we don't block the event loop
  Promise.resolve().then(async () => {
    try {
      ensureGlobalConfigDir();
      const filePath = getAdvisorEventsFilePath();
      const fullEvent: AdvisorEvent = {
        timestamp: new Date().toISOString(),
        ...event,
      };

      let events: AdvisorEvent[] = [];
      try {
        const raw = await fs.promises.readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) events = parsed;
      } catch {
        events = [];
      }

      events.push(fullEvent);
      if (events.length > MAX_EVENTS) {
        events = events.slice(events.length - MAX_EVENTS);
      }

      await fs.promises.writeFile(filePath, JSON.stringify(events, null, 2), "utf-8");
    } catch {
      // Non-blocking log failure
    }
  });
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

  // Persist to disk async (non-blocking)
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
  try {
    const filePath = getAdvisorEventsFilePath();
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    let events: AdvisorEvent[] = JSON.parse(raw);
    if (!Array.isArray(events)) return [];

    if (agentId) {
      events = events.filter(e => !e.agentId || e.agentId === agentId);
    }

    return events.slice(-limit);
  } catch {
    return [];
  }
}

export function clearAdvisorEvents(): boolean {
  try {
    // Clear in-memory pattern cache
    patternCache.clear();
    patternCacheLoaded = true; // Mark as loaded so we don't re-read stale disk data

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
    if (!fs.existsSync(filePath)) return null;

    const exportPath = targetPath || path.join(process.cwd(), `advisor-events-export-${Date.now()}.json`);
    const data = fs.readFileSync(filePath, "utf-8");
    fs.writeFileSync(exportPath, data, "utf-8");
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
