/**
 * WorkspaceStateTracker — builds a concise, live WORKSPACE STATE block
 * that is injected into the dynamic context on every agent iteration.
 *
 * This prevents "context drift" (the agent forgetting what tasks are open,
 * which subagents are running, etc.) without re-reading full files every turn.
 */

import fs from "fs";
import path from "path";
import os from "os";

export interface WorkspaceStateOptions {
  /** Absolute path to active task file */
  taskFilePath: string;
  /** Absolute path to implementation plan file */
  planFilePath?: string;
  /** Current working directory of the project */
  cwd: string;
  /** Agent tier — only inject for master/single */
  tier: "master" | "single" | "superagent" | "subagent";
  /** Map of active subagent instances (id → { role, typeName, status }) */
  subagentSummary?: Array<{ id: string; role: string; typeName: string; status: string }>;
}

export interface WorkspaceStateBlock {
  text: string;
  /** Rough character count — caller uses this to decide if injection is safe */
  charCount: number;
}

/**
 * Read first N incomplete tasks from a markdown task file.
 */
function readIncompleteTasks(taskFilePath: string, maxTasks = 5): string[] {
  try {
    if (!fs.existsSync(taskFilePath)) return [];
    const raw = fs.readFileSync(taskFilePath, "utf-8");
    const lines = raw.split("\n");
    const incomplete: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Matches `- [ ] ...` or `- [/] ...` (uncompleted / in-progress)
      if (/^-\s+\[[\s/]\]/.test(trimmed)) {
        incomplete.push(trimmed.replace(/^-\s+\[[\s/]\]\s*/, "").trim());
        if (incomplete.length >= maxTasks) break;
      }
    }
    return incomplete;
  } catch {
    return [];
  }
}

/**
 * Count completed vs total tasks in a task file.
 */
function countTasks(taskFilePath: string): { done: number; total: number } {
  try {
    if (!fs.existsSync(taskFilePath)) return { done: 0, total: 0 };
    const raw = fs.readFileSync(taskFilePath, "utf-8");
    const lines = raw.split("\n");
    let done = 0;
    let total = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^-\s+\[.?\]/.test(trimmed)) {
        total++;
        if (/^-\s+\[x\]/i.test(trimmed)) done++;
      }
    }
    return { done, total };
  } catch {
    return { done: 0, total: 0 };
  }
}

/**
 * Read first N lines of the implementation plan (objective section only).
 */
function readPlanObjective(planFilePath: string, maxLines = 6): string {
  try {
    if (!fs.existsSync(planFilePath)) return "";
    const raw = fs.readFileSync(planFilePath, "utf-8");
    const lines = raw.split("\n").slice(0, 30);
    const objective: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      // Stop at first major section after the header
      if (trimmed.startsWith("## ") && objective.length > 1) break;
      if (trimmed) {
        objective.push(trimmed);
        if (objective.length >= maxLines) break;
      }
    }
    return objective.join(" ").replace(/#+/g, "").trim();
  } catch {
    return "";
  }
}

/**
 * Read the most recent subagent report file from ~/.superagent-r/subagents/
 * to inject into the parent agent's context when a subagent completes.
 */
export function readLatestSubagentReport(subagentId: string): Record<string, unknown> | null {
  try {
    const reportsDir = path.join(os.homedir(), ".superagent-r", "subagents");
    const reportPath = path.join(reportsDir, `${subagentId}_report.json`);
    if (!fs.existsSync(reportPath)) return null;
    const raw = fs.readFileSync(reportPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Write a structured JSON report for a subagent so the parent can parse it reliably.
 */
export function writeSubagentReport(
  subagentId: string,
  report: {
    goal: string;
    status: "completed" | "blocked" | "error";
    actionsTaken: string[];
    keyFindings: string[];
    nextSteps?: string;
    verificationPassed?: boolean;
  }
): void {
  try {
    const reportsDir = path.join(os.homedir(), ".superagent-r", "subagents");
    fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, `${subagentId}_report.json`);
    fs.writeFileSync(reportPath, JSON.stringify({ ...report, writtenAt: new Date().toISOString() }, null, 2), "utf-8");
  } catch {
    // Non-critical — silently ignore
  }
}

/**
 * Build the live WORKSPACE STATE context block for injection into dynamicContext.
 */
export function buildWorkspaceStateBlock(opts: WorkspaceStateOptions): WorkspaceStateBlock {
  // Only inject for master / single / superagent tiers (not subagents)
  if (opts.tier === "subagent") return { text: "", charCount: 0 };

  const parts: string[] = [];

  // ── Task progress ──────────────────────────────────────────────────────────
  const { done, total } = countTasks(opts.taskFilePath);
  if (total > 0) {
    const pct = Math.round((done / total) * 100);
    parts.push(`📋 TASK PROGRESS: ${done}/${total} complete (${pct}%)`);

    const pending = readIncompleteTasks(opts.taskFilePath, 4);
    if (pending.length > 0) {
      parts.push(`   Next pending tasks:`);
      for (const t of pending) {
        parts.push(`   • ${t}`);
      }
    }
  }

  // ── Plan objective ─────────────────────────────────────────────────────────
  if (opts.planFilePath) {
    const objective = readPlanObjective(opts.planFilePath);
    if (objective) {
      parts.push(`🎯 CURRENT PLAN: ${objective.slice(0, 200)}`);
    }
  }

  // ── Active subagents ───────────────────────────────────────────────────────
  if (opts.subagentSummary && opts.subagentSummary.length > 0) {
    const running = opts.subagentSummary.filter(s => s.status === "running" || s.status === "idle");
    const completed = opts.subagentSummary.filter(s => s.status === "completed");
    if (running.length > 0) {
      const names = running.map(s => `${s.role} (${s.id})`).join(", ");
      parts.push(`🤖 ACTIVE SUBAGENTS [${running.length}]: ${names}`);
    }
    if (completed.length > 0) {
      const names = completed.map(s => `${s.role} (${s.id})`).join(", ");
      parts.push(`✅ COMPLETED SUBAGENTS [${completed.length}]: ${names} — use manage_subagents(action:"report") to read their output`);
    }
  }

  if (parts.length === 0) return { text: "", charCount: 0 };

  const text = `\n\n⚡ LIVE WORKSPACE STATE:\n${parts.join("\n")}`;
  return { text, charCount: text.length };
}
