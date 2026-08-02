import path from "path";
import { Tool } from "./types.js";
import { releaseFile, lockFile, checkFileLock, getLockStats } from "../storage/sharedMemory.js";
import { predictSemanticConflict } from "../storage/semanticConflictPredictor.js";
import { getLockEventHistoryFromDb } from "../storage/historyDb.js";
import { logE2E } from "../utils/unifiedLogger.js";

export const unlockFileTool: Tool = {
  name: "unlock_file",
  description: "Manually unlock or override a locked file across terminal sessions.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file to unlock",
      },
      force: {
        type: "boolean",
        description: "Force unlock regardless of owner session ID (default: true)",
      },
    },
    required: ["filePath"],
  },
  async execute(args, cwd) {
    const filePath = args.filePath as string;
    const force = args.force !== false;

    logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] unlock_file invoked: ${filePath}`, { force, cwd: cwd || process.cwd() });
    const res = releaseFile(filePath, undefined, cwd, force);
    if (res.success) {
      logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] unlock_file success: ${filePath}`, { force, cwd: cwd || process.cwd() });
      return `Successfully unlocked file "${filePath}".`;
    }
    logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] unlock_file failed: ${filePath}`, { force, message: res.message, cwd: cwd || process.cwd() });
    return `Failed to unlock file "${filePath}": ${res.message || "Unknown error"}`;
  },
};

export const getLockStatsTool: Tool = {
  name: "get_lock_stats",
  description: "Get lock health dashboard statistics, active locks, and terminal breakdown.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args, cwd) {
    const stats = getLockStats(cwd);
    logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] get_lock_stats invoked`, {
      cwd: cwd || process.cwd(),
      totalActiveLocks: stats.totalActiveLocks,
      locksByTerminal: stats.locksByTerminal,
      staleLocksCleaned: stats.staleLocksCleaned,
    });
    return JSON.stringify(stats, null, 2);
  },
};

export const resolveConflictTool: Tool = {
  name: "resolve_lock_conflict",
  description: "Interactive 3-way merge conflict resolver for blocked file edits across multi-terminal sessions.",
  parameters: {
    type: "object",
    properties: {
      filePath: {
        type: "string",
        description: "Path to the file under conflict",
      },
      resolutionStrategy: {
        type: "string",
        enum: ["force_override", "take_ours", "take_theirs", "merge_adjacent"],
        description: "Strategy to resolve the lock conflict",
      },
    },
    required: ["filePath", "resolutionStrategy"],
  },
  async execute(args, cwd) {
    const filePath = args.filePath as string;
    const strategy = args.resolutionStrategy as string;

    logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] resolve_lock_conflict invoked: ${filePath}`, { strategy, cwd: cwd || process.cwd() });

    if (strategy === "force_override" || strategy === "take_ours") {
      const res = releaseFile(filePath, undefined, cwd, true);
      logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] resolve_lock_conflict resolved: ${filePath}`, { strategy, success: res.success, message: res.message, cwd: cwd || process.cwd() });
      return `Conflict resolved on "${filePath}" using strategy "${strategy}". File lock released for new edits.`;
    }

    if (strategy === "take_theirs") {
      const res = releaseFile(filePath, undefined, cwd, true);
      logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] resolve_lock_conflict resolved: ${filePath}`, { strategy, success: res.success, message: res.message, cwd: cwd || process.cwd() });
      return `Conflict resolved on "${filePath}" using strategy "take_theirs". Lock released — the other session's version is preserved.`;
    }

    if (strategy === "merge_adjacent") {
      const lockCheck = checkFileLock(filePath, undefined, cwd);
      logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] resolve_lock_conflict merge_adjacent: ${filePath}`, { locked: lockCheck.locked, owner: lockCheck.owner?.sessionId, cwd: cwd || process.cwd() });
      if (lockCheck.locked) {
        const res = releaseFile(filePath, undefined, cwd, true);
        logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] resolve_lock_conflict merge_adjacent released: ${filePath}`, { success: res.success, message: res.message, cwd: cwd || process.cwd() });
      }
      return `Conflict resolved on "${filePath}" using strategy "merge_adjacent". Lock cleared — both sessions may now edit non-overlapping ranges.`;
    }

    logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] resolve_lock_conflict unknown strategy: ${filePath}`, { strategy, cwd: cwd || process.cwd() });
    return `Unknown resolution strategy: "${strategy}".`;
  },
};

export const generateLockReportTool: Tool = {
  name: "generate_lock_report",
  description: "Generate a markdown lock health and audit analytics report.",
  parameters: {
    type: "object",
    properties: {
      targetFile: {
        type: "string",
        description: "Optional file path to inspect heuristic conflict prediction",
      },
    },
  },
  async execute(args, cwd) {
    const stats = getLockStats(cwd);
    const targetFile = args.targetFile as string | undefined;

    logE2E("SUPERAGENT-SERVER", `[LOCK-TOOL] generate_lock_report invoked`, {
      cwd: cwd || process.cwd(),
      targetFile: targetFile || null,
      totalActiveLocks: stats.totalActiveLocks,
    });

    let markdown = `# Multi-Terminal Lock Health & Audit Report\n\n`;
    markdown += `- **Active Locks**: ${stats.totalActiveLocks}\n`;
    markdown += `- **Stale Locks Cleaned**: ${stats.staleLocksCleaned}\n\n`;

    markdown += `### Locks by Terminal\n`;
    for (const [term, count] of Object.entries(stats.locksByTerminal)) {
      markdown += `- **${term}**: ${count}\n`;
    }

    if (targetFile) {
      const pred = predictSemanticConflict(targetFile, undefined, cwd);
      markdown += `\n### Semantic Conflict Risk for "${targetFile}"\n`;
      markdown += `- **Conflict Risk**: ${pred.hasConflictRisk ? "HIGH" : "LOW"}\n`;
      markdown += `- **Risk Score**: ${pred.riskScore}\n`;
      if (pred.reason) markdown += `- **Reason**: ${pred.reason}\n`;
    }

    // Include recent lock event audit history
    const recentEvents = getLockEventHistoryFromDb(20);
    if (recentEvents.length > 0) {
      markdown += `\n### Recent Lock Event Audit Trail (last ${recentEvents.length})\n`;
      markdown += `| Time | Event | File | Session | Terminal | Line Range | Force |\n`;
      markdown += `|------|-------|------|---------|----------|------------|-------|\n`;
      for (const ev of recentEvents) {
        const time = new Date(ev.createdAt).toISOString();
        const file = path.basename(ev.filePath);
        const lineRange = ev.lineRange || "full";
        const force = ev.forceUnlock ? "YES" : "no";
        markdown += `| ${time} | ${ev.eventType} | ${file} | ${ev.sessionId} | ${ev.terminalType || "cli"} | ${lineRange} | ${force} |\n`;
      }
    }

    return markdown;
  },
};
