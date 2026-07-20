import path from "path";
import fs from "fs";
import { ensureGlobalConfigDir, getGlobalConfigDir, generateSessionId } from "../config.js";
import { normalizeAndCheckSubpath } from "../permissions.js";
import { getTaskHistoryPath } from "../taskChecklist.js";
import type { Agent } from "../agent.js";


export class PathResolver {
  public static getPlanFilePath(agent: Agent): string {
    const historyPath = agent.getCurrentHistoryFilePath();
    return historyPath.replace(/\.json$/, "_implementation_plan.md");
  }

  public static getTaskFilePath(agent: Agent): string {
    const historyPath = agent.getCurrentHistoryFilePath();
    return historyPath.replace(/\.json$/, "_task.md");
  }

  public static getWalkthroughFilePath(agent: Agent): string {
    const historyPath = agent.getCurrentHistoryFilePath();
    return historyPath.replace(/\.json$/, "_walkthrough.md");
  }

  public static getTaskHistoryFilePath(agent: Agent): string {
    return getTaskHistoryPath(this.getTaskFilePath(agent));
  }

  public static resolveHistoryFilePath(agent: Agent, autoResume: boolean | string): string {
    ensureGlobalConfigDir();
    const sanitizedPath = agent.workingDirectory.replace(/[^a-zA-Z0-9]/g, "_");
    const mode = agent.isMultiAgent ? "multi" : "single";
    let historyDir = path.join(getGlobalConfigDir(), "history", mode);

    if (agent.tier === "subagent" || agent.tier === "superagent") {
      const parentSessionPath = process.env.SUPERAGENT_SESSION_PATH;
      if (parentSessionPath) {
        const parentSessionDir = path.dirname(parentSessionPath);
        const resolvedParent = path.resolve(parentSessionDir);
        const resolvedGlobal = path.resolve(getGlobalConfigDir());
        if (resolvedParent.startsWith(resolvedGlobal)) {
          historyDir = path.join(parentSessionDir, agent.tier === "subagent" ? "subagents" : "superagents");
        } else {
          historyDir = path.join(historyDir, agent.tier === "subagent" ? "subagents" : "superagents");
        }
      } else {
        historyDir = path.join(historyDir, agent.tier === "subagent" ? "subagents" : "superagents");
      }
    }

    if (typeof autoResume === "string" && autoResume.trim() !== "") {
      const val = autoResume.trim();
      if (fs.existsSync(val) && val.endsWith(".json")) {
        return val;
      }
      const possibleDir = path.join(historyDir, val);
      const possibleFile = path.join(possibleDir, `${val}.json`);
      if (fs.existsSync(possibleFile)) {
        return possibleFile;
      }
      if (fs.existsSync(historyDir)) {
        const dirs = fs.readdirSync(historyDir);
        const match = dirs.find(d => d.toLowerCase() === val.toLowerCase() || d.toLowerCase().endsWith("_" + val.toLowerCase()));
        if (match) {
          const matchFile = path.join(historyDir, match, `${match}.json`);
          if (fs.existsSync(matchFile)) {
            return matchFile;
          }
        }
      }
    }

    if (autoResume) {
      try {
        if (fs.existsSync(historyDir)) {
          const dirs = fs.readdirSync(historyDir);
          const matchedDirs = dirs.filter(d => {
            const nameLower = d.toLowerCase();
            const cleanNameLower = nameLower.replace(/_\d+$/, "");
            return cleanNameLower === sanitizedPath.toLowerCase() || cleanNameLower.startsWith(sanitizedPath.toLowerCase() + "_");
          });

          if (matchedDirs.length > 0) {
            const sorted = matchedDirs.map(d => {
              const dirPath = path.join(historyDir, d);
              const filePath = path.join(dirPath, `${d}.json`);
              const match = d.match(/_(\d+)$/);
              let mtime = match ? parseInt(match[1], 10) : 0;
              if (mtime === 0) {
                try {
                  mtime = fs.statSync(filePath).mtime.getTime();
                } catch {
                  try {
                    mtime = fs.statSync(dirPath).mtime.getTime();
                  } catch {}
                }
              }
              return { filePath, mtime };
            }).sort((a, b) => b.mtime - a.mtime);

            for (const item of sorted) {
              try {
                const content = fs.readFileSync(item.filePath, "utf-8");
                const parsed = JSON.parse(content);
                if (parsed && parsed.workingDirectory) {
                  if (normalizeAndCheckSubpath(parsed.workingDirectory, agent.workingDirectory)) {
                    return item.filePath;
                  }
                } else {
                  const cleanNameLower = path.basename(item.filePath, ".json").toLowerCase().replace(/_\d+$/, "");
                  if (cleanNameLower === sanitizedPath.toLowerCase()) {
                     return item.filePath;
                  }
                }
              } catch {}
            }
          }
        }
      } catch {}
    }

    const sessionId = generateSessionId();
    const sessionDir = path.join(historyDir, sessionId);
    return path.join(sessionDir, `${sessionId}.json`);

  }

  public static getCurrentHistoryFilePath(agent: Agent): string {
    let current = (agent as any).currentHistoryFilePath;
    if (!current) {
      current = this.resolveHistoryFilePath(agent, false);
      (agent as any).currentHistoryFilePath = current;
    }
    process.env.SUPERAGENT_SESSION_PATH = current;
    return current;
  }
}
