import fs from "fs";
import path from "path";
import { getGlobalConfigDir } from "./paths.js";

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

interface FileMetadataCacheEntry {
  mtimeMs: number;
  displayName: string;
  messageCount: number;
  preview: string;
  workingDirectory?: string;
  legacyMatch: boolean;
}

const fileMetadataCache = new Map<string, FileMetadataCacheEntry>();
const masterMetadataLoaded = new Set<string>();

function loadMasterMetadata(historyDir: string): void {
  if (process.env.VITEST || masterMetadataLoaded.has(historyDir)) return;
  masterMetadataLoaded.add(historyDir);
  try {
    const masterPath = path.join(historyDir, "history-metadata.json");
    if (fs.existsSync(masterPath)) {
      const raw = fs.readFileSync(masterPath, "utf-8");
      const masterData = JSON.parse(raw);
      if (masterData && typeof masterData === "object") {
        for (const [sid, meta] of Object.entries(masterData)) {
          const filePath = path.join(historyDir, sid, `${sid}.json`);
          fileMetadataCache.set(filePath, {
            mtimeMs: (meta as any).mtimeMs,
            displayName: (meta as any).displayName,
            messageCount: (meta as any).messageCount,
            preview: (meta as any).preview,
            workingDirectory: (meta as any).workingDirectory,
            legacyMatch: false,
          });
        }
      }
    }
  } catch {
    // Ignore load failures
  }
}

function saveMasterMetadata(historyDir: string): void {
  if (process.env.VITEST) return;
  try {
    const masterPath = path.join(historyDir, "history-metadata.json");
    const masterData: Record<string, any> = {};
    for (const [filePath, entry] of fileMetadataCache.entries()) {
      if (filePath.startsWith(historyDir)) {
        const sid = path.basename(filePath, ".json");
        masterData[sid] = {
          mtimeMs: entry.mtimeMs,
          displayName: entry.displayName,
          messageCount: entry.messageCount,
          preview: entry.preview,
          workingDirectory: entry.workingDirectory,
        };
      }
    }
    fs.writeFileSync(masterPath, JSON.stringify(masterData), "utf-8");
  } catch {
    // Ignore write failures
  }
}

import { listSessionsFromDb, deleteSessionFromDb } from "../storage/historyDb.js";

export function clearHistoryCache(): void {
  listCache.clear();
  if (!process.env.VITEST) {
    fileMetadataCache.clear();
    masterMetadataLoaded.clear();
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
    for (const s of dbSessions) {
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
    // Fallback to legacy file listing if DB query fails
  }

  // Fallback to disk scanning if DB returns no sessions
  if (sessions.length === 0) {
    const mode = isMulti ? "multi" : "single";
    const historyDir = path.join(getGlobalConfigDir(), "history", mode);
    if (!fs.existsSync(historyDir)) return [];

    if (!process.env.VITEST) {
      loadMasterMetadata(historyDir);
    }

    const currentSanitized = currentDir.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

    let dirs: string[];
    try {
      if (crossSession) {
        dirs = fs.readdirSync(historyDir).filter((d) => d !== "superagents" && d !== "subagents" && d !== "history-metadata.json");
      } else {
        dirs = fs.readdirSync(historyDir).filter((d) => {
          if (d === "superagents" || d === "subagents" || d === "history-metadata.json") return false;
          const nameLower = d.toLowerCase();
          const cleanNameLower = nameLower.replace(/_\d+$/, "");
          return cleanNameLower === currentSanitized || cleanNameLower.startsWith(currentSanitized + "_");
        });
      }
    } catch {
      return [];
    }

    let finalDirs = dirs;
    if (!process.env.VITEST) {
      const sortedDirs = dirs.map(d => {
        const match = d.match(/_(\d+)$/);
        const timestamp = match ? parseInt(match[1], 10) : 0;
        return { name: d, timestamp };
      }).sort((a, b) => b.timestamp - a.timestamp);

      finalDirs = limit !== undefined ? sortedDirs.slice(0, limit).map(x => x.name) : sortedDirs.map(x => x.name);
    }

    for (const d of finalDirs) {
      const cleanNameLower = d.toLowerCase().replace(/_\d+$/, "");
      const dirPath = path.join(historyDir, d);
      const filePath = path.join(dirPath, `${d}.json`);
      try {
        let displayName = "";
        let messageCount = 0;
        let preview = "";
        let sessionCwd: string | undefined;
        let legacyMatch = false;
        let mtimeMs = 0;

        let cachedFile: FileMetadataCacheEntry | undefined;
        if (process.env.VITEST) {
          try {
            const stat = fs.statSync(filePath);
            mtimeMs = stat.mtimeMs !== undefined ? stat.mtimeMs : stat.mtime.getTime();
            const entry = fileMetadataCache.get(filePath);
            if (entry && entry.mtimeMs === mtimeMs) {
              cachedFile = entry;
            }
          } catch {
            // Ignore
          }
        } else {
          cachedFile = fileMetadataCache.get(filePath);
        }

        if (cachedFile) {
          displayName = cachedFile.displayName;
          messageCount = cachedFile.messageCount;
          preview = cachedFile.preview;
          sessionCwd = cachedFile.workingDirectory;
          legacyMatch = cleanNameLower === currentSanitized;
          mtimeMs = cachedFile.mtimeMs;
        } else {
          if (!process.env.VITEST) {
            const match = d.match(/_(\d+)$/);
            mtimeMs = match ? parseInt(match[1], 10) : 0;
            if (mtimeMs === 0) {
              try {
                const stat = fs.statSync(filePath);
                mtimeMs = stat.mtimeMs !== undefined ? stat.mtimeMs : stat.mtime.getTime();
              } catch {
                try {
                  mtimeMs = fs.statSync(dirPath).mtime.getTime();
                } catch {}
              }
            }
          }

          const metadataPath = path.join(dirPath, "metadata.json");
          let metadataLoaded = false;
          try {
            const metaRaw = fs.readFileSync(metadataPath, "utf-8");
            const meta = JSON.parse(metaRaw);
            if (meta && typeof meta === "object" && meta.mtimeMs === mtimeMs) {
              displayName = meta.displayName;
              messageCount = meta.messageCount;
              preview = meta.preview;
              sessionCwd = meta.workingDirectory;
              legacyMatch = cleanNameLower === currentSanitized;
              metadataLoaded = true;

              fileMetadataCache.set(filePath, {
                mtimeMs,
                displayName,
                messageCount,
                preview,
                workingDirectory: sessionCwd,
                legacyMatch,
              });
            }
          } catch {
            // Ignore
          }

          if (!metadataLoaded) {
            const raw = fs.readFileSync(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            sessionCwd = parsed && typeof parsed === "object" ? parsed.workingDirectory : undefined;
            let messages: Array<{ role: string; content: string; timestamp?: number }> = [];
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
              messages = parsed.messages;
            } else if (Array.isArray(parsed)) {
              messages = parsed;
            } else {
              continue;
            }

            const userMessages = messages.filter((m) => m.role === "user");
            const lastUser = userMessages[userMessages.length - 1];
            preview = lastUser
              ? lastUser.content.slice(0, 60).replace(/\n/g, " ") + (lastUser.content.length > 60 ? "…" : "")
              : "(no user messages)";

            const cleanName = d.replace(/_\d+$/, "");
            const folderPathName = cleanName
              .replace(/^([a-zA-Z])__/, "$1:\\")
              .replace(/^_+/, "/")
              .replace(/_/g, "/");

            displayName = lastUser && lastUser.content && lastUser.content.trim()
              ? lastUser.content.trim().slice(0, 60).replace(/\n/g, " ") + (lastUser.content.trim().length > 60 ? "…" : "")
              : folderPathName;

            legacyMatch = cleanNameLower === currentSanitized;
            messageCount = messages.length;

            fileMetadataCache.set(filePath, {
              mtimeMs,
              displayName,
              messageCount,
              preview,
              workingDirectory: sessionCwd,
              legacyMatch,
            });
          }
        }

        if (!crossSession) {
          if (sessionCwd) {
            if (!normalizeAndCheckSubpath(sessionCwd, currentDir)) {
              continue;
            }
          } else {
            if (!legacyMatch) {
              continue;
            }
          }
        }

        sessions.push({
          id: d,
          filePath,
          displayName,
          messageCount,
          lastModified: new Date(mtimeMs),
          preview,
        });
      } catch {
        continue;
      }
    }
  }

  sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  const finalResult = limit !== undefined ? sessions.slice(0, limit) : sessions;
  listCache.set(cacheKey, { timestamp: now, data: finalResult });
  return finalResult;
}

