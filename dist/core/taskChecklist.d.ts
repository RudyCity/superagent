export interface ChecklistTask {
    status: string;
    text: string;
}
export interface ReadChecklistResult {
    tasks: ChecklistTask[];
    missing: boolean;
}
/** A group of completed tasks from a single archive round. */
export interface HistoryRound {
    /** The timestamp label from the "## Completed: <label>" header. */
    round: string;
    tasks: ChecklistTask[];
}
/**
 * Derive the task history file path from the active task file path.
 * e.g. "session_task.md" -> "session_task_history.md"
 *
 * This is the single source of truth for history path derivation.
 * agent.getTaskHistoryFilePath() delegates to this function.
 */
export declare function getTaskHistoryPath(taskPath: string): string;
export declare function parseChecklistTasks(content: string): ChecklistTask[];
export declare function readChecklistTasks(taskPath: string): Promise<ReadChecklistResult>;
/**
 * Check if the task file exists and ALL tasks are completed (status === "x").
 * Returns false if the file is missing, empty, or has any non-completed task.
 */
export declare function allTasksCompleted(taskPath: string): Promise<boolean>;
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
export declare function archiveCompletedTasks(taskPath: string): Promise<ChecklistTask[]>;
/**
 * Read the archived completed tasks from _task_history.md as a flat list.
 * Returns all tasks with status "x".
 */
export declare function readTaskHistory(taskPath: string): Promise<ChecklistTask[]>;
/**
 * Read the archived completed tasks grouped by archive round.
 * Each round preserves its timestamp label and the tasks within it.
 * Useful for displaying history with temporal context.
 */
export declare function readTaskHistoryGrouped(taskPath: string): Promise<HistoryRound[]>;
//# sourceMappingURL=taskChecklist.d.ts.map