import fs from "fs/promises";

export interface ChecklistTask {
  status: string;
  text: string;
}

export interface ReadChecklistResult {
  tasks: ChecklistTask[];
  missing: boolean;
}

/**
 * Derive the task history file path from the active task file path.
 * e.g. "session_task.md" → "session_task_history.md"
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
 * each round separated by a timestamped header.
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
  const historyLines = [
    `## Completed: ${timestamp}`,
    ...completed.map((t) => `- [x] ${t.text}`),
    "",
  ];

  try {
    const existing = await fs.readFile(historyPath, "utf-8");
    await fs.writeFile(historyPath, existing + "\n" + historyLines.join("\n"), "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      await fs.writeFile(historyPath, "# Task History\n\n" + historyLines.join("\n"), "utf-8");
    } else {
      throw err;
    }
  }

  // Clear the active task file — keep only a header so it's not "missing"
  await fs.writeFile(taskPath, "# Active Tasks\n\n_No active tasks yet._\n", "utf-8");

  return completed;
}

/**
 * Read the archived completed tasks from _task_history.md.
 * Returns the parsed tasks (all with status "x") and the raw sections
 * for display purposes.
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
