import path from "path";
import fs from "fs";
import { ensureGlobalConfigDir, getGlobalConfigDir, generateSessionId, getCurrentWorkspaceIdentifier, listHistorySessions } from "../config.js";
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
    const wsId = getCurrentWorkspaceIdentifier(agent.workingDirectory || undefined);
    const sanitizedPath = wsId.replace(/[^a-zA-Z0-9]/g, "_");
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
      let val = autoResume.trim();
      if (val.startsWith("sess/") || val.startsWith("session/")) {
        val = val.replace(/\//g, "_");
      }
      if (fs.existsSync(val) && val.endsWith(".json")) {
        return val;
      }
      const possibleDir = path.join(historyDir, val);
      const possibleFile = path.join(possibleDir, `${val}.json`);
      if (fs.existsSync(possibleFile)) {
        return possibleFile;
      }

      // Check alternate mode's history directory
      const otherMode = mode === "multi" ? "single" : "multi";
      const otherHistoryDir = path.join(getGlobalConfigDir(), "history", otherMode);
      const otherPossibleDir = path.join(otherHistoryDir, val);
      const otherPossibleFile = path.join(otherPossibleDir, `${val}.json`);
      if (fs.existsSync(otherPossibleFile)) {
        return otherPossibleFile;
      }

      try {
        const allSessions = listHistorySessions(agent.isMultiAgent, true, undefined, undefined, undefined, "all");
        const matched = allSessions.find(s => s.id === val || s.id.endsWith("_" + val) || s.id.endsWith(val));
        if (matched) {
          return matched.filePath;
        }
      } catch {}

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

      if (fs.existsSync(otherHistoryDir)) {
        const dirs = fs.readdirSync(otherHistoryDir);
        const match = dirs.find(d => d.toLowerCase() === val.toLowerCase() || d.toLowerCase().endsWith("_" + val.toLowerCase()));
        if (match) {
          const matchFile = path.join(otherHistoryDir, match, `${match}.json`);
          if (fs.existsSync(matchFile)) {
            return matchFile;
          }
        }
      }

      if (!val.includes("/") && !val.includes("\\")) {
        return possibleFile;
      }
    }

    if (autoResume) {
      try {
        const sessions = listHistorySessions(agent.isMultiAgent, false, agent.workingDirectory);
        if (sessions.length > 0) {
          return sessions[0].filePath;
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
    if (!agent.sessionId && current) {
      agent.sessionId = path.basename(current, ".json");
    }
    return current;
  }
}
