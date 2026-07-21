import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execSync } from "child_process";
import { execa } from "execa";
import { clearHistoryCache } from "./config.js";
import { Message } from "./conversation.js";
import { backgroundTasks, subagentInstances, notifyTasksChanged, notifySubagentsChanged, isTaskInWorkspace } from "./tools/state.js";
import { killProcessTree } from "./tools/shellTools.js";
import {
  saveCheckpointToDb,
  loadCheckpointFromDb,
  listCheckpointsFromDb,
  deleteCheckpointFromDb,
  deleteAllCheckpointsFromDb,
  saveSessionToDb,
  loadSessionFromDb,
} from "./storage/historyDb.js";

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
export async function getGitSha(cwd?: string): Promise<string | undefined> {
  try {
    const res = await execa("git", ["rev-parse", "--short", "HEAD"], {
      cwd: cwd || process.cwd(),
      reject: false,
    });
    return res.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves a new checkpoint to SQLite database.
 */
export async function createCheckpoint(
  sessionFilePath: string,
  name: string,
  messages: Message[],
  planState: "IDLE" | "PLANNING_PENDING" | "APPROVED",
  workingDirectory?: string
): Promise<Checkpoint> {
  const sessionId = path.basename(sessionFilePath, ".json");
  const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
  const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
  const taskHistoryPath = sessionFilePath.replace(/\.json$/, "_task_history.md");
  const walkthroughPath = sessionFilePath.replace(/\.json$/, "_walkthrough.md");

  let planFileContent: string | undefined;
  let taskFileContent: string | undefined;
  let taskHistoryFileContent: string | undefined;
  let walkthroughFileContent: string | undefined;

  try { planFileContent = await fs.readFile(planPath, "utf-8"); } catch {}
  try { taskFileContent = await fs.readFile(taskPath, "utf-8"); } catch {}
  try { taskHistoryFileContent = await fs.readFile(taskHistoryPath, "utf-8"); } catch {}
  try { walkthroughFileContent = await fs.readFile(walkthroughPath, "utf-8"); } catch {}

  const gitSha = await getGitSha(workingDirectory);
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

  saveCheckpointToDb({
    id,
    name,
    sessionId,
    sessionFilePath,
    timestamp,
    messagesJson: JSON.stringify(messages),
    planState,
    planFileContent,
    taskFileContent,
    taskHistoryFileContent,
    walkthroughFileContent,
    gitSha,
  });

  return checkpoint;
}

/**
 * Lists all checkpoints for the active session from SQLite, sorted by newest first.
 */
export async function listCheckpointsForSession(
  sessionFilePath: string
): Promise<Checkpoint[]> {
  const sessionId = path.basename(sessionFilePath, ".json");
  const records = listCheckpointsFromDb(sessionId);

  return records.map((r) => {
    let msgs: Message[] = [];
    try { msgs = JSON.parse(r.messagesJson); } catch {}
    return {
      id: r.id,
      name: r.name,
      timestamp: r.timestamp,
      sessionFilePath: r.sessionFilePath,
      messages: msgs,
      planState: (r.planState as any) || "IDLE",
      planFileContent: r.planFileContent,
      taskFileContent: r.taskFileContent,
      taskHistoryFileContent: r.taskHistoryFileContent,
      walkthroughFileContent: r.walkthroughFileContent,
      gitSha: r.gitSha,
    };
  });
}

/**
 * Restores a checkpoint to the main session and updates planning/task files.
 */
export async function restoreCheckpoint(
  checkpointId: string,
  sessionFilePath: string
): Promise<Checkpoint> {
  const sessionId = path.basename(sessionFilePath, ".json");
  const cpRecord = loadCheckpointFromDb(checkpointId);

  if (!cpRecord) {
    throw new Error(`Checkpoint "${checkpointId}" not found in database.`);
  }

  let checkpointMessages: Message[] = [];
  try { checkpointMessages = JSON.parse(cpRecord.messagesJson); } catch {}

  const current = loadSessionFromDb(sessionId);

  const msgs = checkpointMessages.map((m: any, idx: number) => ({
    sessionId,
    role: m.role || "user",
    content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
    toolResults: m.toolResults ? JSON.stringify(m.toolResults) : undefined,
    reasoning: m.reasoning,
    timestamp: m.timestamp || Date.now(),
    sequenceOrder: idx,
  }));

  const userMsgs = msgs.filter((m) => m.role === "user");
  const lastUser = userMsgs[userMsgs.length - 1];
  const preview = lastUser
    ? lastUser.content.slice(0, 60).replace(/\n/g, " ") + (lastUser.content.length > 60 ? "…" : "")
    : current.session?.preview || "";

  saveSessionToDb(
    {
      id: sessionId,
      filePath: sessionFilePath,
      displayName: current.session?.displayName || sessionId,
      messageCount: msgs.length,
      lastModified: Date.now(),
      preview,
      workingDirectory: current.session?.workingDirectory,
      planState: cpRecord.planState,
      activePreset: current.session?.activePreset,
      extraData: current.session?.extraData,
    },
    msgs
  );

  // Touch session directory anchor file
  try {
    await fs.mkdir(path.dirname(sessionFilePath), { recursive: true });
    await fs.writeFile(sessionFilePath, "", "utf-8");
  } catch {}

  clearHistoryCache();

  // Re-sync plan, task, task history, and walkthrough markdown files
  const planPath = sessionFilePath.replace(/\.json$/, "_implementation_plan.md");
  const taskPath = sessionFilePath.replace(/\.json$/, "_task.md");
  const taskHistoryPath = sessionFilePath.replace(/\.json$/, "_task_history.md");
  const walkthroughPath = sessionFilePath.replace(/\.json$/, "_walkthrough.md");

  if (cpRecord.planFileContent !== undefined && cpRecord.planFileContent !== null) {
    await fs.writeFile(planPath, cpRecord.planFileContent, "utf-8");
  } else {
    try { await fs.unlink(planPath); } catch {}
  }

  if (cpRecord.taskFileContent !== undefined && cpRecord.taskFileContent !== null) {
    await fs.writeFile(taskPath, cpRecord.taskFileContent, "utf-8");
  } else {
    try { await fs.unlink(taskPath); } catch {}
  }

  if (cpRecord.taskHistoryFileContent !== undefined && cpRecord.taskHistoryFileContent !== null) {
    await fs.writeFile(taskHistoryPath, cpRecord.taskHistoryFileContent, "utf-8");
  } else {
    try { await fs.unlink(taskHistoryPath); } catch {}
  }

  if (cpRecord.walkthroughFileContent !== undefined && cpRecord.walkthroughFileContent !== null) {
    await fs.writeFile(walkthroughPath, cpRecord.walkthroughFileContent, "utf-8");
  } else {
    try { await fs.unlink(walkthroughPath); } catch {}
  }

  return {
    id: cpRecord.id,
    name: cpRecord.name,
    timestamp: cpRecord.timestamp,
    sessionFilePath: cpRecord.sessionFilePath,
    messages: checkpointMessages,
    planState: (cpRecord.planState as any) || "IDLE",
    planFileContent: cpRecord.planFileContent,
    taskFileContent: cpRecord.taskFileContent,
    taskHistoryFileContent: cpRecord.taskHistoryFileContent,
    walkthroughFileContent: cpRecord.walkthroughFileContent,
    gitSha: cpRecord.gitSha,
  };
}

/**
 * Deletes all checkpoints associated with a session (for /new or /clear cleanup).
 */
export async function deleteCheckpointsForSession(
  sessionFilePath: string
): Promise<void> {
  const sessionId = path.basename(sessionFilePath, ".json");
  deleteAllCheckpointsFromDb(sessionId);

  const sessionDir = path.dirname(sessionFilePath);

  const checkpointsDir = path.join(sessionDir, "checkpoints");
  if (fsSync.existsSync(checkpointsDir)) {
    try { await fs.rm(checkpointsDir, { recursive: true, force: true }); } catch {}
  }

  const tasksLogDir = path.join(sessionDir, "tasks");
  if (fsSync.existsSync(tasksLogDir)) {
    try { await fs.rm(tasksLogDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Terminates all running background tasks and subagents.
 */
export function terminateActiveTasksAndSubagents(workspacePath: string = process.cwd()): void {
  // 1. Kill background tasks
  for (const [id, task] of backgroundTasks.entries()) {
    if (isTaskInWorkspace(task.cwd, workspacePath)) {
      try { killProcessTree(task.process.pid); } catch {}
      backgroundTasks.delete(id);
    }
  }
  notifyTasksChanged();

  // 2. Terminate running subagents
  for (const [id, inst] of subagentInstances.entries()) {
    if (inst.status === "running") {
      try { inst.agent.abort(); } catch {}
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
  return await restoreCheckpoint(id, sessionFilePath);
}

/**
 * Deletes a single checkpoint by its ID.
 * Returns true if the checkpoint was found and deleted, false otherwise.
 */
export async function deleteCheckpointById(
  id: string,
  sessionFilePath: string
): Promise<boolean> {
  return deleteCheckpointFromDb(id);
}
