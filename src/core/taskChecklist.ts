import fs from "fs/promises";

export interface ChecklistTask {
  status: string;
  text: string;
}

export interface ReadChecklistResult {
  tasks: ChecklistTask[];
  missing: boolean;
}

export interface CurrentTaskInfo {
  task: string;
  status: "in_progress" | "pending" | "completed" | "none";
  index: number;
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
  percentage: number;
  tasks: ChecklistTask[];
}

/** A group of completed tasks from a single archive round. */
export interface HistoryRound {
  /** The timestamp label from the "## Completed: <label>" header. */
  round: string;
  tasks: ChecklistTask[];
}

/** Maximum number of archive rounds to keep in the history file. */
const MAX_HISTORY_ROUNDS = 10;

/**
 * Derive the task history file path from the active task file path.
 * e.g. "session_task.md" -> "session_task_history.md"
 *
 * This is the single source of truth for history path derivation.
 * agent.getTaskHistoryFilePath() delegates to this function.
 */
export function getTaskHistoryPath(taskPath: string): string {
  return taskPath.replace(/_task\.md$/, "_task_history.md");
}

export function parseChecklistTasks(content: string): ChecklistTask[] {
  const lines = content.split(/\r?\n/);
  const items: ChecklistTask[] = [];

  for (const line of lines) {
    const match =
      line.match(/^\s*-\s*`\[([xX/ ])\]`?\s*(.*)$/) ||
      line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
    if (match) {
      items.push({
        status: match[1].toLowerCase(),
        text: match[2].trim(),
      });
    }
  }

  return items;
}

/**
 * Analyze a checklist task list and determine the current active task,
 * its status (in_progress, pending, completed, or none), and progress metrics.
 */
export function getCurrentTaskFromChecklist(tasks: ChecklistTask[]): CurrentTaskInfo {
  const total = tasks.length;
  const completed = tasks.filter((t) => t.status === "x").length;
  const inProgress = tasks.filter((t) => t.status === "/").length;
  const pending = tasks.filter((t) => t.status === " ").length;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  if (total === 0) {
    return {
      task: "",
      status: "none",
      index: 0,
      total: 0,
      completed: 0,
      inProgress: 0,
      pending: 0,
      percentage: 0,
      tasks: [],
    };
  }

  // 1. Look for the first in-progress task ('/')
  const inProgIdx = tasks.findIndex((t) => t.status === "/");
  if (inProgIdx !== -1) {
    return {
      task: tasks[inProgIdx].text,
      status: "in_progress",
      index: inProgIdx + 1,
      total,
      completed,
      inProgress,
      pending,
      percentage,
      tasks,
    };
  }

  // 2. Look for the first pending task (' ')
  const pendingIdx = tasks.findIndex((t) => t.status === " ");
  if (pendingIdx !== -1) {
    return {
      task: tasks[pendingIdx].text,
      status: "pending",
      index: pendingIdx + 1,
      total,
      completed,
      inProgress,
      pending,
      percentage,
      tasks,
    };
  }

  // 3. All tasks completed
  if (completed === total && total > 0) {
    return {
      task: "All tasks completed",
      status: "completed",
      index: total,
      total,
      completed,
      inProgress: 0,
      pending: 0,
      percentage: 100,
      tasks,
    };
  }

  return {
    task: "",
    status: "none",
    index: 0,
    total,
    completed,
    inProgress,
    pending,
    percentage,
    tasks,
  };
}

export async function readChecklistTasks(taskPath: string): Promise<ReadChecklistResult> {
  try {
    const content = await fs.readFile(taskPath, "utf-8");
    return { tasks: parseChecklistTasks(content), missing: false };
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { tasks: [], missing: true };
    }
    throw err;
  }
}

/**
 * Check if the task file exists and ALL tasks are completed (status === "x").
 * Returns false if the file is missing, empty, or has any non-completed task.
 */
export async function allTasksCompleted(taskPath: string): Promise<boolean> {
  const result = await readChecklistTasks(taskPath);
  if (result.missing || result.tasks.length === 0) return false;
  return result.tasks.every((t) => t.status === "x");
}

/**
 * Archive all completed tasks from _task.md into _task_history.md,
 * then clear the active task file so new tasks can be created fresh.
 *
 * The history file accumulates completed tasks across multiple rounds,
 * each round separated by a timestamped header. Old rounds beyond
 * MAX_HISTORY_ROUNDS are trimmed to prevent unbounded growth.
 *
 * Returns the list of archived tasks (empty if nothing was archived).
 */
export async function archiveCompletedTasks(taskPath: string): Promise<ChecklistTask[]> {
  const result = await readChecklistTasks(taskPath);
  if (result.missing || result.tasks.length === 0) return [];

  const completed = result.tasks.filter((t) => t.status === "x");
  if (completed.length === 0) return [];

  const historyPath = getTaskHistoryPath(taskPath);

  // Append to history with a timestamped section header
  const timestamp = new Date().toLocaleString();
  const newSection = [
    `## Completed: ${timestamp}`,
    ...completed.map((t) => `- [x] ${t.text}`),
    "",
  ].join("\n");

  try {
    const existing = await fs.readFile(historyPath, "utf-8");
    const trimmed = trimHistoryRounds(existing, MAX_HISTORY_ROUNDS - 1);
    await fs.writeFile(historyPath, trimmed + "\n" + newSection + "\n", "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await fs.writeFile(historyPath, "# Task History\n\n" + newSection + "\n", "utf-8");
    } else {
      throw err;
    }
  }

  // Clear the active task file — write empty content so manage_tasks "add"
  // starts fresh without orphaned placeholder text
  await fs.writeFile(taskPath, "", "utf-8");

  return completed;
}

/**
 * Trim history content to keep only the last N rounds (sections).
 * Rounds are delimited by "## Completed:" headers.
 */
function trimHistoryRounds(content: string, maxRounds: number): string {
  const lines = content.split(/\r?\n/);
  const headerIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("## Completed:")) {
      headerIndices.push(i);
    }
  }

  if (headerIndices.length <= maxRounds) return content;

  // Keep everything before the first header we want to preserve
  const keepFrom = headerIndices[headerIndices.length - maxRounds];

  // Preserve the "# Task History" header line if present
  const headerLine = lines[0]?.startsWith("# Task History") ? lines[0] + "\n\n" : "";
  const keptLines = lines.slice(keepFrom).join("\n");

  return headerLine + keptLines;
}

/**
 * Read the archived completed tasks from _task_history.md as a flat list.
 * Returns all tasks with status "x".
 */
export async function readTaskHistory(taskPath: string): Promise<ChecklistTask[]> {
  const historyPath = getTaskHistoryPath(taskPath);
  try {
    const content = await fs.readFile(historyPath, "utf-8");
    return parseChecklistTasks(content);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Read the archived completed tasks grouped by archive round.
 * Each round preserves its timestamp label and the tasks within it.
 * Useful for displaying history with temporal context.
 */
export async function readTaskHistoryGrouped(taskPath: string): Promise<HistoryRound[]> {
  const historyPath = getTaskHistoryPath(taskPath);
  try {
    const content = await fs.readFile(historyPath, "utf-8");
    return parseHistoryRounds(content);
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Parse history content into grouped rounds.
 */
function parseHistoryRounds(content: string): HistoryRound[] {
  const lines = content.split(/\r?\n/);
  const rounds: HistoryRound[] = [];
  let currentRound: HistoryRound | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^## Completed:\s*(.*)$/);
    if (headerMatch) {
      currentRound = { round: headerMatch[1].trim(), tasks: [] };
      rounds.push(currentRound);
      continue;
    }

    if (currentRound) {
      const taskMatch =
        line.match(/^\s*-\s*`\[([xX/ ])\]`?\s*(.*)$/) ||
        line.match(/^\s*-\s*\[([xX/ ])\]\s*(.*)$/);
      if (taskMatch) {
        currentRound.tasks.push({
          status: taskMatch[1].toLowerCase(),
          text: taskMatch[2].trim(),
        });
      }
    }
  }

  return rounds;
}
