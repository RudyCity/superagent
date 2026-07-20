import path from "path";
import { listSessionsFromDb, deleteSessionFromDb } from "../storage/historyDb.js";

function resolveNormalizedPath(fp: string, baseDir?: string): string {
  let normalized = fp;
  if (process.platform === "win32") {
    if (/^\/[a-zA-Z]\//.test(normalized)) {
      normalized = normalized[1] + ":" + normalized.slice(2);
    } else if (/^\/[a-zA-Z]$/.test(normalized)) {
      normalized = normalized[1] + ":/";
    }
  }
  return baseDir ? path.resolve(baseDir, normalized) : path.resolve(normalized);
}

function normalizeAndCheckSubpath(childPath: string, parentPath: string): boolean {
  let resolvedChild = resolveNormalizedPath(childPath);
  let resolvedParent = resolveNormalizedPath(parentPath);
  if (process.platform === "win32") {
    resolvedChild = resolvedChild.toLowerCase();
    resolvedParent = resolvedParent.toLowerCase();
  }
  return resolvedChild.startsWith(resolvedParent + path.sep) || resolvedChild === resolvedParent;
}

export interface HistorySession {
  id: string;
  filePath: string;
  displayName: string;
  messageCount: number;
  lastModified: Date;
  preview: string;
}

interface HistoryCacheEntry {
  timestamp: number;
  data: HistorySession[];
}

const listCache = new Map<string, HistoryCacheEntry>();

export function clearHistoryCache(): void {
  listCache.clear();
}

export function listHistorySessions(isMulti = false, crossSession = false, workspaceDir?: string, limit?: number): HistorySession[] {
  const currentDir = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
  const cacheKey = `${isMulti}:${crossSession}:${currentDir}:${limit ?? "all"}`;
  const now = Date.now();
  const cached = listCache.get(cacheKey);
  if (!process.env.VITEST && cached && now - cached.timestamp < 30000) {
    return cached.data;
  }

  const sessions: HistorySession[] = [];
  try {
    const dbSessions = listSessionsFromDb(limit || 200);
    const modeIndicator = isMulti ? "/multi/" : "/single/";
    for (const s of dbSessions) {
      const normalizedPath = s.filePath.replace(/\\/g, "/");
      if (!normalizedPath.includes(modeIndicator)) {
        continue;
      }
      if (normalizedPath.includes("/superagents/") || normalizedPath.includes("/subagents/")) {
        continue;
      }
      if (!crossSession && s.workingDirectory) {
        if (!normalizeAndCheckSubpath(s.workingDirectory, currentDir)) {
          continue;
        }
      }
      sessions.push({
        id: s.id,
        filePath: s.filePath,
        displayName: s.displayName,
        messageCount: s.messageCount,
        lastModified: new Date(s.lastModified),
        preview: s.preview,
      });
    }
  } catch {
    // Return empty array if DB unavailable
  }

  sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const finalResult = limit !== undefined ? sessions.slice(0, limit) : sessions;
  listCache.set(cacheKey, { timestamp: now, data: finalResult });
  return finalResult;
}
