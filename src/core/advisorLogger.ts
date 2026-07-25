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

export function logAdvisorEvent(event: Omit<AdvisorEvent, "timestamp">): void {
  try {
    ensureGlobalConfigDir();
    const filePath = getAdvisorEventsFilePath();
    const fullEvent: AdvisorEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };

    let events: AdvisorEvent[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, "utf-8");
        events = JSON.parse(raw);
        if (!Array.isArray(events)) {
          events = [];
        }
      } catch {
        events = [];
      }
    }

    events.push(fullEvent);
    if (events.length > 500) {
      events = events.slice(events.length - 500);
    }

    fs.writeFileSync(filePath, JSON.stringify(events, null, 2), "utf-8");
  } catch {
    // Non-blocking log failure
  }
}

export function logFailedPattern(callSignature: string, toolName: string, errorMessage: string): void {
  try {
    ensureGlobalConfigDir();
    const filePath = getAdvisorPatternsFilePath();
    let patterns: Record<string, { toolName: string; errorMessage: string; failCount: number; lastFailed: string }> = {};

    if (fs.existsSync(filePath)) {
      try {
        patterns = JSON.parse(fs.readFileSync(filePath, "utf-8")) || {};
      } catch {
        patterns = {};
      }
    }

    const existing = patterns[callSignature] || { toolName, errorMessage, failCount: 0, lastFailed: "" };
    existing.failCount += 1;
    existing.lastFailed = new Date().toISOString();
    existing.errorMessage = errorMessage;
    patterns[callSignature] = existing;

    fs.writeFileSync(filePath, JSON.stringify(patterns, null, 2), "utf-8");
  } catch {
    // Non-blocking write
  }
}

export function getFailedPattern(callSignature: string): { toolName: string; errorMessage: string; failCount: number } | null {
  try {
    const filePath = getAdvisorPatternsFilePath();
    if (!fs.existsSync(filePath)) return null;
    const patterns = JSON.parse(fs.readFileSync(filePath, "utf-8")) || {};
    const item = patterns[callSignature];
    return item && item.failCount >= 2 ? item : null;
  } catch {
    return null;
  }
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
