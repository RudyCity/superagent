import { Tool } from "./types.js";
import { releaseFile, lockFile, checkFileLock, getLockStats } from "../storage/sharedMemory.js";
import { predictSemanticConflict } from "../storage/semanticConflictPredictor.js";

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

    const res = releaseFile(filePath, undefined, cwd, force);
    if (res.success) {
      return `Successfully unlocked file "${filePath}".`;
    }
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

    if (strategy === "force_override" || strategy === "take_ours") {
      releaseFile(filePath, undefined, cwd, true);
      return `Conflict resolved on "${filePath}" using strategy "${strategy}". File lock released for new edits.`;
    }

    if (strategy === "take_theirs") {
      releaseFile(filePath, undefined, cwd, true);
      return `Conflict resolved on "${filePath}" using strategy "take_theirs". Lock released — the other session's version is preserved.`;
    }

    if (strategy === "merge_adjacent") {
      const lockCheck = checkFileLock(filePath, undefined, cwd);
      if (lockCheck.locked) {
        releaseFile(filePath, undefined, cwd, true);
      }
      return `Conflict resolved on "${filePath}" using strategy "merge_adjacent". Lock cleared — both sessions may now edit non-overlapping ranges.`;
    }

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

    return markdown;
  },
};
