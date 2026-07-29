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

export function normalizeAndCheckSubpath(childPath: string, parentPath: string): boolean {
  let resolvedChild = resolveNormalizedPath(childPath);
  let resolvedParent = resolveNormalizedPath(parentPath);
  if (process.platform === "win32") {
    resolvedChild = resolvedChild.toLowerCase();
    resolvedParent = resolvedParent.toLowerCase();
  }
  const childSlash = resolvedChild.replace(/\\/g, "/");
  const parentSlash = resolvedParent.replace(/\\/g, "/");
  return resolvedChild.startsWith(resolvedParent + path.sep) || 
         resolvedChild === resolvedParent || 
         childSlash.startsWith(parentSlash + "/") || 
         childSlash === parentSlash ||
         resolvedParent.startsWith(resolvedChild + path.sep) ||
         parentSlash.startsWith(childSlash + "/");
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

/** Build a display label from firstChat/lastChat, falling back to displayName */
export function formatSessionLabel(s: HistorySession): string {
  const clean = (t?: string) => t
    ?.replace(/\[(RMemory|TencentDB|Emergency|Context|SYS|System)[^\]]*\]/gi, "")
    .replace(/<\/?user_request>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^(\/[a-zA-Z0-9_-]+\s*)+/g, "")
    .replace(/\n/g, " ")
    .trim() || "";
  const first = clean(s.firstChat);
  const last = clean(s.lastChat);
  if (first && last && first.toLowerCase() !== last.toLowerCase()) {
    const cap = (t: string, n: number) => t.length > n ? t.slice(0, n).trim() + "…" : t;
    return `${cap(first, 25)} → ${cap(last, 25)}`;
  }
  if (first) return first.length > 50 ? first.slice(0, 50).trim() + "…" : first;
  if (last) return last.length > 50 ? last.slice(0, 50).trim() + "…" : last;
  return s.displayName || s.id;
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

export function listHistorySessions(
  isMulti = false,
  crossSession = false,
  workspaceDir?: string,
  limit?: number,
  offset?: number,
  modeFilter?: "single" | "multi" | "all"
): HistorySession[] {
  const { sessions } = listHistorySessionsPaginated({
    isMulti,
    crossSession,
    workspaceDir,
    limit,
    offset,
    modeFilter,
  });
  return sessions;
}

export function listHistorySessionsPaginated(options: {
  isMulti?: boolean;
  crossSession?: boolean;
  workspaceDir?: string;
  limit?: number;
  offset?: number;
  modeFilter?: "single" | "multi" | "all";
}): { sessions: HistorySession[]; totalCount: number; hasMore: boolean } {
  const isMulti = options.isMulti ?? false;
  const crossSession = options.crossSession ?? false;
  const workspaceDir = options.workspaceDir;
  const limit = options.limit;
  const offset = options.offset ?? 0;
  const modeFilter = options.modeFilter ?? (isMulti ? "multi" : "single");

  const currentDir = workspaceDir ? path.resolve(workspaceDir) : process.cwd();
  const cacheKey = `${isMulti}:${crossSession}:${currentDir}:${limit ?? "all"}:${offset}:${modeFilter}`;
  const now = Date.now();
  const cached = listCache.get(cacheKey);
  if (!process.env.VITEST && cached && now - cached.timestamp < 30000) {
    const totalCount = cached.data.length;
    const paginated = limit !== undefined ? cached.data.slice(offset, offset + limit) : cached.data.slice(offset);
    const hasMore = limit !== undefined ? offset + limit < totalCount : false;
    return { sessions: paginated, totalCount, hasMore };
  }

  const sessions: HistorySession[] = [];
  try {
    const dbSessions = listSessionsFromDb(1000);
    for (const s of dbSessions) {
      const normalizedPath = s.filePath.replace(/\\/g, "/");

      if (modeFilter !== "all") {
        const modeIndicator = modeFilter === "multi" ? "/multi/" : "/single/";
        if (!normalizedPath.includes(modeIndicator)) {
          continue;
        }
      }

      if (normalizedPath.includes("/superagents/") || normalizedPath.includes("/subagents/")) {
        continue;
      }
      if (!crossSession) {
        if (!s.workingDirectory || !normalizeAndCheckSubpath(s.workingDirectory, currentDir)) {
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
  listCache.set(cacheKey, { timestamp: now, data: sessions });

  const totalCount = sessions.length;
  const paginated = limit !== undefined ? sessions.slice(offset, offset + limit) : sessions.slice(offset);
  const hasMore = limit !== undefined ? offset + limit < totalCount : false;

  return { sessions: paginated, totalCount, hasMore };
}


