import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execSync } from "child_process";
import { getGlobalConfigDir, ensureGlobalConfigDir } from "./config.js";
import { Message } from "./conversation.js";
import { backgroundTasks, subagentInstances, notifyTasksChanged, notifySubagentsChanged } from "./tools/state.js";
import { killProcessTree } from "./tools/shellTools.js";

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
export function getGitSha(cwd?: string): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      cwd: cwd || process.cwd(),
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * Saves a new checkpoint to disk.
 */
export async function createCheckpoint(
  sessionFilePath: string,
  name: string,
  messages: Message[],
  planState: "IDLE" | "PLANNING_PENDING" | "APPROVED",
  workingDirectory?: string
): Promise<Checkpoint> {
  const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
  const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
  const taskHistoryPath = sessionFilePath.replace(/\.json$/, "_task_history.md");
  const walkthroughPath = sessionFilePath.replace(/\.json$/, "_walkthrough.md");

  let planFileContent: string | undefined;
  let taskFileContent: string | undefined;
  let taskHistoryFileContent: string | undefined;
  let walkthroughFileContent: string | undefined;

  try {
    planFileContent = await fs.readFile(planPath, "utf-8");
  } catch {}
  try {
    taskFileContent = await fs.readFile(taskPath, "utf-8");
  } catch {}
  try {
    taskHistoryFileContent = await fs.readFile(taskHistoryPath, "utf-8");
  } catch {}
  try {
    walkthroughFileContent = await fs.readFile(walkthroughPath, "utf-8");
  } catch {}

  const gitSha = getGitSha(workingDirectory);
  const timestamp = Date.now();
  const id = `chk_${timestamp}`;

  const checkpoint: Checkpoint = {
    id,
    name,
    timestamp,
    sessionFilePath,
    messages: [...messages],
    planState,
    planFileContent,
    taskFileContent,
    taskHistoryFileContent,
    walkthroughFileContent,
    gitSha,
  };

  const checkpointsDir = path.join(path.dirname(sessionFilePath), "checkpoints");
  await fs.mkdir(checkpointsDir, { recursive: true });

  const checkpointPath = path.join(checkpointsDir, `checkpoint_${timestamp}.json`);

  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");

  // Pruning logic - keep max 20 checkpoints for the current session
  try {
    const files = await fs.readdir(checkpointsDir);
    const prefix = "checkpoint_";
    const matched = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json"));

    if (matched.length > 20) {
      const sorted = matched
        .map((f) => {
          const parts = f.replace(prefix, "").replace(".json", "");
          const timeVal = parseInt(parts, 10) || 0;
          return { filename: f, timeVal };
        })
        .sort((a, b) => a.timeVal - b.timeVal); // oldest first

      const toDeleteCount = sorted.length - 20;
      for (let i = 0; i < toDeleteCount; i++) {
        await fs.unlink(path.join(checkpointsDir, sorted[i].filename));
      }
    }
  } catch {}

  return checkpoint;
}

/**
 * Lists all checkpoints for the active session, sorted by newest first.
 */
export async function listCheckpointsForSession(
  sessionFilePath: string
): Promise<Checkpoint[]> {
  const checkpointsDir = path.join(path.dirname(sessionFilePath), "checkpoints");
  if (!fsSync.existsSync(checkpointsDir)) return [];

  const prefix = "checkpoint_";

  try {
    const files = await fs.readdir(checkpointsDir);
    const matched = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json"));

    const checkpoints: Checkpoint[] = [];
    for (const file of matched) {
      try {
        const content = await fs.readFile(path.join(checkpointsDir, file), "utf-8");
        const parsed = JSON.parse(content) as Checkpoint;
        checkpoints.push(parsed);
      } catch {}
    }

    return checkpoints.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/**
 * Restores a checkpoint to the main session and updates planning/task files.
 */
export async function restoreCheckpoint(
  checkpointFilePath: string,
  sessionFilePath: string
): Promise<Checkpoint> {
  const content = await fs.readFile(checkpointFilePath, "utf-8");
  const checkpoint = JSON.parse(content) as Checkpoint;

  // Restore the session history JSON file
  const sessionData = {
    messages: checkpoint.messages,
    planState: checkpoint.planState,
  };
  await fs.writeFile(sessionFilePath, JSON.stringify(sessionData, null, 2), "utf-8");

  // Re-sync plan, task, task history, and walkthrough markdown files
  const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
  const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
  const taskHistoryPath = sessionFilePath.replace(/\.json$/, "_task_history.md");
  const walkthroughPath = sessionFilePath.replace(/\.json$/, "_walkthrough.md");

  if (checkpoint.planFileContent !== undefined) {
    await fs.writeFile(planPath, checkpoint.planFileContent, "utf-8");
  } else {
    try {
      await fs.unlink(planPath);
    } catch {}
  }

  if (checkpoint.taskFileContent !== undefined) {
    await fs.writeFile(taskPath, checkpoint.taskFileContent, "utf-8");
  } else {
    try {
      await fs.unlink(taskPath);
    } catch {}
  }

  if (checkpoint.taskHistoryFileContent !== undefined) {
    await fs.writeFile(taskHistoryPath, checkpoint.taskHistoryFileContent, "utf-8");
  } else {
    try {
      await fs.unlink(taskHistoryPath);
    } catch {}
  }

  if (checkpoint.walkthroughFileContent !== undefined) {
    await fs.writeFile(walkthroughPath, checkpoint.walkthroughFileContent, "utf-8");
  } else {
    try {
      await fs.unlink(walkthroughPath);
    } catch {}
  }

  return checkpoint;
}

/**
 * Deletes all checkpoints associated with a session (for /new or /clear cleanup).
 */
export async function deleteCheckpointsForSession(
  sessionFilePath: string
): Promise<void> {
  const sessionDir = path.dirname(sessionFilePath);

  const checkpointsDir = path.join(sessionDir, "checkpoints");
  if (fsSync.existsSync(checkpointsDir)) {
    try {
      await fs.rm(checkpointsDir, { recursive: true, force: true });
    } catch {}
  }

  const tasksLogDir = path.join(sessionDir, "tasks");
  if (fsSync.existsSync(tasksLogDir)) {
    try {
      await fs.rm(tasksLogDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Terminates all running background tasks and subagents.
 */
export function terminateActiveTasksAndSubagents(): void {
  // 1. Kill background tasks
  for (const [id, task] of backgroundTasks.entries()) {
    try {
      killProcessTree(task.process.pid);
    } catch {}
    backgroundTasks.delete(id);
  }
  notifyTasksChanged();

  // 2. Terminate running subagents
  for (const [id, inst] of subagentInstances.entries()) {
    if (inst.status === "running") {
      try {
        inst.agent.abort();
      } catch {}
      inst.status = "completed";
      inst.result = "[Cancelled due to checkpoint restore]";
    }
  }
  notifySubagentsChanged();
}

/**
 * Restores a checkpoint by its ID.
 */
export async function restoreCheckpointById(
  id: string,
  sessionFilePath: string
): Promise<Checkpoint | undefined> {
  const checkpoints = await listCheckpointsForSession(sessionFilePath);
  const found = checkpoints.find((c) => c.id === id);
  if (!found) return undefined;

  const checkpointsDir = path.join(path.dirname(sessionFilePath), "checkpoints");
  const checkpointPath = path.join(checkpointsDir, `checkpoint_${found.timestamp}.json`);

  return await restoreCheckpoint(checkpointPath, sessionFilePath);
}

/**
 * Deletes a single checkpoint by its ID.
 * Returns true if the checkpoint was found and deleted, false otherwise.
 */
export async function deleteCheckpointById(
  id: string,
  sessionFilePath: string
): Promise<boolean> {
  const checkpoints = await listCheckpointsForSession(sessionFilePath);
  const found = checkpoints.find((c) => c.id === id);
  if (!found) return false;

  const checkpointsDir = path.join(path.dirname(sessionFilePath), "checkpoints");
  const checkpointPath = path.join(checkpointsDir, `checkpoint_${found.timestamp}.json`);

  try {
    await fs.unlink(checkpointPath);
    return true;
  } catch {
    return false;
  }
}
