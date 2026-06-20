import { Message } from "./conversation.js";
export interface Checkpoint {
    id: string;
    name: string;
    timestamp: number;
    sessionFilePath: string;
    messages: Message[];
    planState: "IDLE" | "PLANNING_PENDING" | "APPROVED";
    planFileContent?: string;
    taskFileContent?: string;
    taskHistoryFileContent?: string;
    walkthroughFileContent?: string;
    gitSha?: string;
}
/**
 * Gets the current short git SHA from the repository.
 */
export declare function getGitSha(cwd?: string): string | undefined;
/**
 * Saves a new checkpoint to disk.
 */
export declare function createCheckpoint(sessionFilePath: string, name: string, messages: Message[], planState: "IDLE" | "PLANNING_PENDING" | "APPROVED", workingDirectory?: string): Promise<Checkpoint>;
/**
 * Lists all checkpoints for the active session, sorted by newest first.
 */
export declare function listCheckpointsForSession(sessionFilePath: string): Promise<Checkpoint[]>;
/**
 * Restores a checkpoint to the main session and updates planning/task files.
 */
export declare function restoreCheckpoint(checkpointFilePath: string, sessionFilePath: string): Promise<Checkpoint>;
/**
 * Deletes all checkpoints associated with a session (for /new or /clear cleanup).
 */
export declare function deleteCheckpointsForSession(sessionFilePath: string): Promise<void>;
/**
 * Terminates all running background tasks and subagents.
 */
export declare function terminateActiveTasksAndSubagents(): void;
/**
 * Restores a checkpoint by its ID.
 */
export declare function restoreCheckpointById(id: string, sessionFilePath: string): Promise<Checkpoint | undefined>;
/**
 * Deletes a single checkpoint by its ID.
 * Returns true if the checkpoint was found and deleted, false otherwise.
 */
export declare function deleteCheckpointById(id: string, sessionFilePath: string): Promise<boolean>;
//# sourceMappingURL=checkpoints.d.ts.map