import path from "path";
import fs from "fs";
import { listSessionsFromDb, deleteSessionFromDb, purgeEmptySessionsFromDb, loadSessionFromDb, saveSessionToDb } from "../storage/historyDb.js";

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
  firstChat?: string;
  lastChat?: string;
}

interface HistoryCacheEntry {
  timestamp: number;
  data: HistorySession[];
}

const listCache = new Map<string, HistoryCacheEntry>();

export function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

export function clearHistoryCache(): void {
  listCache.clear();
}

export function purgeEmptySessions(maxAgeHours: number = 24): { purgedCount: number } {
  const maxAgeMs = maxAgeHours * 3600 * 1000;
  const { purgedCount, purgedFilePaths } = purgeEmptySessionsFromDb(maxAgeMs);
  
  for (const fp of purgedFilePaths) {
    try {
      if (fs.existsSync(fp)) {
        fs.unlinkSync(fp);
      }
      const dir = path.dirname(fp);
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {}
  }
  clearHistoryCache();
  return { purgedCount };
}

export function exportSession(sessionId: string, format: "json" | "markdown" = "markdown"): string | null {
  const { session, messages } = loadSessionFromDb(sessionId);
  if (!session) return null;

  if (format === "json") {
    return JSON.stringify({ session, messages }, null, 2);
  }

  const lines: string[] = [
    `# Session Export: ${session.displayName || session.id}`,
    `- **Session ID**: ${session.id}`,
    `- **Date**: ${new Date(session.lastModified).toISOString()}`,
    `- **Workspace**: ${session.workingDirectory || "N/A"}`,
    `- **Messages**: ${session.messageCount}`,
    "",
    "---",
    "",
  ];

  for (const m of messages) {
    const roleTitle = m.role.toUpperCase();
    lines.push(`### ${roleTitle} (${new Date(m.timestamp).toLocaleString()})`);
    lines.push(m.content);
    lines.push("");
  }

  return lines.join("\n");
}

export function importSession(filePath: string): { success: boolean; id?: string; error?: string } {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed.session || !parsed.session.id) {
      return { success: false, error: "Invalid session export format. Missing session object or id." };
    }
    saveSessionToDb(parsed.session, parsed.messages || []);
    clearHistoryCache();
    return { success: true, id: parsed.session.id };
  } catch (err: any) {
    return { success: false, error: err.message || String(err) };
  }
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
        firstChat: s.firstChat || undefined,
        lastChat: s.lastChat || undefined,
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

