/**
 * cliBridgeArtifacts.ts — Resolves and formats active task, plan, and walkthrough
 * artifact paths for CLI Bridge external delegation.
 */

import fs from "fs";
import path from "path";

export interface ArtifactPaths {
  taskPath?: string;
  taskExists?: boolean;
  planPath?: string;
  planExists?: boolean;
  walkthroughPath?: string;
  walkthroughExists?: boolean;
}

export interface ArtifactResolutionOptions {
  taskPath?: string;
  planPath?: string;
  walkthroughPath?: string;
  provideDefaultTargets?: boolean;
}

/**
 * Resolves active artifact files (task checklist, implementation plan, walkthrough)
 * from explicit overrides, the workspace directory, or the active session directory.
 * When provideDefaultTargets is true (default), provides standard target paths even
 * if the files do not exist yet on disk so the external AI can create them.
 */
export function resolveArtifactPaths(
  cwd: string,
  overrides?: ArtifactResolutionOptions
): ArtifactPaths {
  let taskPath = overrides?.taskPath ? path.resolve(cwd, overrides.taskPath) : undefined;
  let planPath = overrides?.planPath ? path.resolve(cwd, overrides.planPath) : undefined;
  let walkthroughPath = overrides?.walkthroughPath ? path.resolve(cwd, overrides.walkthroughPath) : undefined;
  const provideDefaults = overrides?.provideDefaultTargets !== false;

  // 1. Check workspace cwd for standard task files if not explicitly overridden
  if (!taskPath) {
    const candidates = ["_task.md", "task.md", "tasks.md"];
    for (const c of candidates) {
      const p = path.join(cwd, c);
      if (fs.existsSync(p)) {
        taskPath = p;
        break;
      }
    }
  }

  // 2. Check workspace cwd for standard plan files if not explicitly overridden
  if (!planPath) {
    const candidates = ["_plan.md", "plan.md", "implementation_plan.md", "_implementation_plan.md"];
    for (const c of candidates) {
      const p = path.join(cwd, c);
      if (fs.existsSync(p)) {
        planPath = p;
        break;
      }
    }
  }

  // 3. Check workspace cwd for standard walkthrough files if not explicitly overridden
  if (!walkthroughPath) {
    const candidates = ["_walkthrough.md", "walkthrough.md"];
    for (const c of candidates) {
      const p = path.join(cwd, c);
      if (fs.existsSync(p)) {
        walkthroughPath = p;
        break;
      }
    }
  }

  // 4. Fallback to active session files via process.env.SUPERAGENT_SESSION_PATH
  const sessionPath = process.env.SUPERAGENT_SESSION_PATH;
  if (sessionPath) {
    if (!taskPath) {
      const p = sessionPath.replace(/\.json$/, "_task.md");
      if (fs.existsSync(p)) taskPath = p;
    }
    if (!planPath) {
      const p = sessionPath.replace(/\.json$/, "_implementation_plan.md");
      if (fs.existsSync(p)) planPath = p;
    }
    if (!walkthroughPath) {
      const p = sessionPath.replace(/\.json$/, "_walkthrough.md");
      if (fs.existsSync(p)) walkthroughPath = p;
    }
  }

  // 5. If provideDefaults is true, default to standard target files in cwd
  if (provideDefaults) {
    if (!taskPath) taskPath = path.join(cwd, "task.md");
    if (!planPath) planPath = path.join(cwd, "plan.md");
    if (!walkthroughPath) walkthroughPath = path.join(cwd, "walkthrough.md");
  }

  const taskExists = taskPath ? fs.existsSync(taskPath) : false;
  const planExists = planPath ? fs.existsSync(planPath) : false;
  const walkthroughExists = walkthroughPath ? fs.existsSync(walkthroughPath) : false;

  return {
    taskPath,
    taskExists,
    planPath,
    planExists,
    walkthroughPath,
    walkthroughExists,
  };
}

/**
 * Builds the structured context block for external AI CLIs to read and update.
 */
export function buildArtifactContextBlock(artifacts: ArtifactPaths): string | null {
  const lines: string[] = [];
  if (artifacts.taskPath) {
    const tag = artifacts.taskExists ? "[Existing file - please update]" : "[Target file - create if needed]";
    lines.push(`- Task Checklist: ${artifacts.taskPath} ${tag}`);
  }
  if (artifacts.planPath) {
    const tag = artifacts.planExists ? "[Existing file - please review]" : "[Target file - create if needed]";
    lines.push(`- Implementation Plan: ${artifacts.planPath} ${tag}`);
  }
  if (artifacts.walkthroughPath) {
    const tag = artifacts.walkthroughExists ? "[Existing file - please append]" : "[Target file - create if needed]";
    lines.push(`- Walkthrough Document: ${artifacts.walkthroughPath} ${tag}`);
  }

  if (lines.length === 0) {
    return null;
  }

  return [
    "=== ACTIVE PROJECT ARTIFACTS ===",
    "The following project artifact files are active for this task. You have full permission to read and update them directly on disk:",
    ...lines,
    "",
    "Artifact Update Guidelines:",
    "1. Review the Implementation Plan and Task Checklist before executing code modifications.",
    "2. In the Task Checklist file, update checklist items to track progress:",
    "   • Mark in-progress tasks with ' [/] ' (e.g. '- [/] Task description')",
    "   • Mark completed tasks with ' [x] ' (e.g. '- [x] Task description')",
    "   • Add any new subtasks discovered with ' [ ] '",
    "3. Record your summary, modifications, and test verification results in the Walkthrough Document when complete.",
    "================================",
  ].join("\n");
}

export interface TaskSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  formatted: string;
}

/**
 * Reads a task checklist file and returns a concise summary of task statuses.
 */
export function summarizeTaskChecklist(taskPath?: string): TaskSummary | null {
  if (!taskPath || !fs.existsSync(taskPath)) return null;

  try {
    const content = fs.readFileSync(taskPath, "utf-8");
    const lines = content.split(/\r?\n/);
    let completed = 0;
    let inProgress = 0;
    let pending = 0;

    for (const line of lines) {
      const match = line.match(/^\s*-\s*\[([ xX/])\]/);
      if (match) {
        const mark = match[1].toLowerCase();
        if (mark === "x") completed++;
        else if (mark === "/") inProgress++;
        else pending++;
      }
    }

    const total = completed + inProgress + pending;
    if (total === 0) return null;

    const formatted = `Task Checklist: ${completed}/${total} completed, ${inProgress} in progress, ${pending} pending`;
    return { total, completed, inProgress, pending, formatted };
  } catch {
    return null;
  }
}
