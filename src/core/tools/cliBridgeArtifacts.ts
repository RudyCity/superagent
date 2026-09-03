/**
 * cliBridgeArtifacts.ts — Resolves and formats active task, plan, and walkthrough
 * artifact paths for CLI Bridge external delegation.
 */

import fs from "fs";
import path from "path";

export interface ArtifactPaths {
  taskPath?: string;
  planPath?: string;
  walkthroughPath?: string;
}

export interface ArtifactResolutionOptions {
  taskPath?: string;
  planPath?: string;
  walkthroughPath?: string;
}

/**
 * Resolves active artifact files (task checklist, implementation plan, walkthrough)
 * from explicit overrides, the workspace directory, or the active session directory.
 */
export function resolveArtifactPaths(
  cwd: string,
  overrides?: ArtifactResolutionOptions
): ArtifactPaths {
  let taskPath = overrides?.taskPath ? path.resolve(cwd, overrides.taskPath) : undefined;
  let planPath = overrides?.planPath ? path.resolve(cwd, overrides.planPath) : undefined;
  let walkthroughPath = overrides?.walkthroughPath ? path.resolve(cwd, overrides.walkthroughPath) : undefined;

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

  return { taskPath, planPath, walkthroughPath };
}

/**
 * Builds the structured context block for external AI CLIs to read and update.
 */
export function buildArtifactContextBlock(artifacts: ArtifactPaths): string | null {
  const lines: string[] = [];
  if (artifacts.taskPath) {
    lines.push(`- Task Checklist: ${artifacts.taskPath}`);
  }
  if (artifacts.planPath) {
    lines.push(`- Implementation Plan: ${artifacts.planPath}`);
  }
  if (artifacts.walkthroughPath) {
    lines.push(`- Walkthrough Document: ${artifacts.walkthroughPath}`);
  }

  if (lines.length === 0) {
    return null;
  }

  return [
    "=== ACTIVE PROJECT ARTIFACTS ===",
    "The following project artifact files are active for this task. You have full permission to read and update them directly:",
    ...lines,
    "",
    "Artifact Update Guidelines:",
    "1. Review the Implementation Plan and Task Checklist before executing code changes.",
    "2. In the Task Checklist file, update checklist items to track progress:",
    "   • Mark in-progress tasks with ' [/] ' (e.g. '- [/] Task description')",
    "   • Mark completed tasks with ' [x] ' (e.g. '- [x] Task description')",
    "   • Add any new subtasks discovered with ' [ ] '",
    "3. Record your summary, modifications, and test verification results in the Walkthrough Document when complete.",
    "================================",
  ].join("\n");
}
