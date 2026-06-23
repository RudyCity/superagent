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
  filePath: string;
  displayName: string;
  messageCount: number;
  lastModified: Date;
  preview: string;
}

export function listHistorySessions(isMulti = false, crossSession = false): HistorySession[] {
  const mode = isMulti ? "multi" : "single";
  const historyDir = path.join(getGlobalConfigDir(), "history", mode);
  if (!fs.existsSync(historyDir)) return [];

  const currentDir = process.cwd();
  const currentSanitized = currentDir.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

  let dirs: string[];
  try {
    if (crossSession) {
      // Cross-session: list ALL sessions regardless of working directory
      dirs = fs.readdirSync(historyDir);
    } else {
      // Workspace-scoped: only sessions matching current cwd
      dirs = fs.readdirSync(historyDir).filter((d) => {
        const nameLower = d.toLowerCase();
        const cleanNameLower = nameLower.replace(/_\d+$/, "");
        return cleanNameLower === currentSanitized || cleanNameLower.startsWith(currentSanitized + "_");
      });
    }
  } catch {
    return [];
  }

  const sessions: HistorySession[] = [];
  for (const d of dirs) {
    const dirPath = path.join(historyDir, d);
    const filePath = path.join(dirPath, `${d}.json`);
    if (!fs.existsSync(filePath)) continue;

    try {
      const stat = fs.statSync(filePath);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw);

      // Verify that the session actually belongs to this workspace
      if (!crossSession) {
        const sessionCwd = parsed && typeof parsed === "object" ? parsed.workingDirectory : undefined;
        if (sessionCwd) {
          if (!normalizeAndCheckSubpath(sessionCwd, currentDir)) {
            continue;
          }
        } else {
          // Legacy fallback: check if cleanName is exactly the sanitized path of current cwd
          const cleanNameLower = d.toLowerCase().replace(/_\d+$/, "");
          if (cleanNameLower !== currentSanitized) {
            continue;
          }
        }
      }

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
      const preview = lastUser
        ? lastUser.content.slice(0, 60).replace(/\n/g, " ") + (lastUser.content.length > 60 ? "…" : "")
        : "(no user messages)";

      // Reconstruct display name from sanitized filename as fallback
      // Strip trailing timestamp suffix if present (e.g. _1717999999)
      const cleanName = d.replace(/_\d+$/, "");
      const folderPathName = cleanName
        .replace(/^([a-zA-Z])__/, "$1:\\")
        .replace(/^_+/, "/")
        .replace(/_/g, "/");

      const displayName = lastUser && lastUser.content && lastUser.content.trim()
        ? lastUser.content.trim().slice(0, 60).replace(/\n/g, " ") + (lastUser.content.trim().length > 60 ? "…" : "")
        : folderPathName;

      sessions.push({
        filePath,
        displayName,
        messageCount: messages.length,
        lastModified: stat.mtime,
        preview,
      });
    } catch {
      // Skip corrupt/unreadable files
      continue;
    }
  }

  // Sort by most recently modified first
  sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  return sessions;
}
