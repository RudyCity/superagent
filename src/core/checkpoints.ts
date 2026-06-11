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
  walkthroughFileContent?: string;
  gitSha?: string;
}

/**
 * Gets the current short git SHA from the repository.
 */
export function getGitSha(): string | undefined {
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
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
  planState: "IDLE" | "PLANNING_PENDING" | "APPROVED"
): Promise<Checkpoint> {
  const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
  const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
  const walkthroughPath = sessionFilePath.replace(/\.json$/, "_walkthrough.md");

  let planFileContent: string | undefined;
  let taskFileContent: string | undefined;
  let walkthroughFileContent: string | undefined;

  try {
    planFileContent = await fs.readFile(planPath, "utf-8");
  } catch {}
  try {
    taskFileContent = await fs.readFile(taskPath, "utf-8");
  } catch {}
  try {
    walkthroughFileContent = await fs.readFile(walkthroughPath, "utf-8");
  } catch {}

  const gitSha = getGitSha();
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
    walkthroughFileContent,
    gitSha,
  };

  const checkpointsDir = path.join(getGlobalConfigDir(), "checkpoints");
  ensureGlobalConfigDir();

  const sessionBase = path.basename(sessionFilePath, ".json");
  const checkpointPath = path.join(checkpointsDir, `${sessionBase}_checkpoint_${timestamp}.json`);

  await fs.writeFile(checkpointPath, JSON.stringify(checkpoint, null, 2), "utf-8");

  // Pruning logic - keep max 30 checkpoints for the current session
  try {
    const files = await fs.readdir(checkpointsDir);
    const prefix = `${sessionBase}_checkpoint_`;
    const matched = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json"));

    if (matched.length > 30) {
      const sorted = matched
        .map((f) => {
          const parts = f.replace(prefix, "").replace(".json", "");
          const timeVal = parseInt(parts, 10) || 0;
          return { filename: f, timeVal };
        })
        .sort((a, b) => a.timeVal - b.timeVal); // oldest first

      const toDeleteCount = sorted.length - 30;
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
  const checkpointsDir = path.join(getGlobalConfigDir(), "checkpoints");
  if (!fsSync.existsSync(checkpointsDir)) return [];

  const sessionBase = path.basename(sessionFilePath, ".json");
  const prefix = `${sessionBase}_checkpoint_`;

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

  // Re-sync plan, task, and walkthrough markdown files
  const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
  const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
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
  const checkpointsDir = path.join(getGlobalConfigDir(), "checkpoints");
  if (!fsSync.existsSync(checkpointsDir)) return;

  const sessionBase = path.basename(sessionFilePath, ".json");
  const prefix = `${sessionBase}_checkpoint_`;

  try {
    const files = await fs.readdir(checkpointsDir);
    const matched = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
    for (const file of matched) {
      try {
        await fs.unlink(path.join(checkpointsDir, file));
      } catch {}
    }
  } catch {}
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

  const checkpointsDir = path.join(getGlobalConfigDir(), "checkpoints");
  const checkpointPath = path.join(checkpointsDir, `${path.basename(sessionFilePath, ".json")}_checkpoint_${found.timestamp}.json`);

  return await restoreCheckpoint(checkpointPath, sessionFilePath);
}
