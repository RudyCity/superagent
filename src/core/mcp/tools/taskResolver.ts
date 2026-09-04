import fs from "fs";
import path from "path";
import {
  ChecklistTask,
  CurrentTaskInfo,
  getCurrentTaskFromChecklist,
  readChecklistTasks,
} from "../../taskChecklist.js";
import { superagentInstances, subagentInstances, getProcessActivity } from "../../tools/state.js";
import { loadRegistry } from "../../tools/superagentRegistry.js";
import { loadActiveProcesses } from "../processJournal.js";
import { callServerApi } from "./processTools.js";

export interface ResolveInstanceTaskOptions {
  instanceId?: string;
  superagentId?: string;
  id?: string;
  workspace?: string;
}

export interface InstanceTaskResolution {
  found: boolean;
  type: "superagent" | "subagent" | "process" | "workspace" | "none";
  id?: string;
  role?: string;
  typeName?: string;
  branch?: string;
  status?: string;
  goal?: string;
  currentTask: string;
  currentTaskStatus: "in_progress" | "pending" | "completed" | "none";
  currentTaskIndex: number;
  progress: string;
  totalTasks: number;
  completedTasks: number;
  inProgressTasks: number;
  pendingTasks: number;
  percentage: number;
  tasks: ChecklistTask[];
  worktreePath?: string;
  taskFilePath?: string;
  planFilePath?: string;
  planContent?: string;
  activeTool?: string;
  errorMessage?: string;
}

/**
 * Scan candidate directories/paths for task checklist files (_task.md, task.md, tasks.md)
 */
async function findTaskFileAndRead(candidatePaths: string[]): Promise<{
  tasks: ChecklistTask[];
  taskFilePath?: string;
}> {
  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    let filePath = candidate;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      for (const name of ["_task.md", "task.md", "tasks.md"]) {
        const full = path.join(filePath, name);
        if (fs.existsSync(full)) {
          filePath = full;
          break;
        }
      }
    }
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      const res = await readChecklistTasks(filePath);
      if (res.tasks && res.tasks.length > 0) {
        return { tasks: res.tasks, taskFilePath: filePath };
      }
    }
  }
  return { tasks: [] };
}

/**
 * Scan candidate directories/paths for implementation plan files (_plan.md, plan.md, etc.)
 */
function findPlanFileAndRead(candidatePaths: string[]): {
  planContent?: string;
  planFilePath?: string;
} {
  for (const candidate of candidatePaths) {
    if (!candidate) continue;
    let filePath = candidate;
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      for (const name of ["_plan.md", "plan.md", "implementation_plan.md", "_implementation_plan.md"]) {
        const full = path.join(filePath, name);
        if (fs.existsSync(full)) {
          filePath = full;
          break;
        }
      }
    }
    if (fs.existsSync(filePath) && !fs.statSync(filePath).isDirectory()) {
      try {
        const content = fs.readFileSync(filePath, "utf-8");
        return { planContent: content, planFilePath: filePath };
      } catch {}
    }
  }
  return {};
}

/**
 * Resolve the current active task and checklist status for any instance:
 * Superagent, Subagent, CLI/Server Process, or specific workspace directory.
 */
export async function resolveInstanceCurrentTask(
  opts: ResolveInstanceTaskOptions = {}
): Promise<InstanceTaskResolution> {
  const rawId = (opts.instanceId || opts.superagentId || opts.id || "").trim();

  // 1. If explicit ID provided, check Superagent instances first
  if (rawId) {
    // 1a. In-memory Superagent
    let superagent = superagentInstances.get(rawId);
    let worktreePath = superagent?.worktreePath;
    let historyFilePath = superagent?.historyFilePath;
    let goal = superagent?.task;
    let role = superagent?.role;
    let branch = superagent?.branch;
    let status = superagent?.status;

    // 1b. Registered worktree
    if (!superagent) {
      const registry = loadRegistry();
      const entry = registry.find((r) => r.id === rawId || r.name === rawId);
      if (entry) {
        worktreePath = entry.worktreePath;
        role = entry.role;
        branch = entry.branch;
        status = entry.status;
      }
    }

    // 1c. Server API query fallback
    if (!superagent && !worktreePath) {
      try {
        const serverRes = await callServerApi("/api/instances", "GET");
        if (serverRes.success && serverRes.data?.superagents) {
          const matched = serverRes.data.superagents.find((s: any) => s.id === rawId);
          if (matched) {
            role = matched.role;
            status = matched.status;
            goal = matched.prompt;
            worktreePath = matched.worktreePath;
          }
        }
      } catch {}
    }

    if (superagent || worktreePath || (goal && role && role.toLowerCase().includes("superagent"))) {
      const candidateTaskPaths: string[] = [];
      if (worktreePath && fs.existsSync(worktreePath)) {
        candidateTaskPaths.push(worktreePath);
      }
      if (historyFilePath) {
        candidateTaskPaths.push(historyFilePath.replace(/\.json$/, "_task.md"));
      }
      if (superagent?.agent?.getTaskFilePath) {
        try {
          candidateTaskPaths.push(superagent.agent.getTaskFilePath());
        } catch {}
      }

      const { tasks, taskFilePath } = await findTaskFileAndRead(candidateTaskPaths);
      const { planContent, planFilePath } = findPlanFileAndRead(
        worktreePath ? [worktreePath] : candidateTaskPaths
      );

      const taskInfo = getCurrentTaskFromChecklist(tasks);
      const currentTask = taskInfo.task || goal || "Execute assigned feature tasks";
      const currentTaskStatus = taskInfo.status !== "none" ? taskInfo.status : (status === "completed" ? "completed" : "in_progress");

      return {
        found: true,
        type: "superagent",
        id: rawId,
        role: role || "Superagent",
        branch,
        status: status || "unknown",
        goal: goal || currentTask,
        currentTask,
        currentTaskStatus,
        currentTaskIndex: taskInfo.index,
        progress: `${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)`,
        totalTasks: taskInfo.total,
        completedTasks: taskInfo.completed,
        inProgressTasks: taskInfo.inProgress,
        pendingTasks: taskInfo.pending,
        percentage: taskInfo.percentage,
        tasks: taskInfo.tasks,
        worktreePath,
        taskFilePath,
        planFilePath,
        planContent,
      };
    }

    // 1d. Subagent Instance
    let subagent = subagentInstances.get(rawId);
    if (!subagent) {
      try {
        const serverRes = await callServerApi("/api/instances", "GET");
        if (serverRes.success && serverRes.data?.subagents) {
          subagent = serverRes.data.subagents.find((s: any) => s.id === rawId);
        }
      } catch {}
    }

    if (subagent) {
      const prompt = subagent.prompt || "(no prompt assigned)";
      const isDone = subagent.status === "completed";
      return {
        found: true,
        type: "subagent",
        id: rawId,
        role: subagent.role,
        typeName: subagent.typeName,
        status: subagent.status,
        goal: prompt,
        currentTask: prompt,
        currentTaskStatus: isDone ? "completed" : "in_progress",
        currentTaskIndex: 1,
        progress: isDone ? "1/1 (100%)" : "0/1 (0%)",
        totalTasks: 1,
        completedTasks: isDone ? 1 : 0,
        inProgressTasks: isDone ? 0 : 1,
        pendingTasks: 0,
        percentage: isDone ? 100 : 0,
        tasks: [{ status: isDone ? "x" : "/", text: prompt }],
      };
    }

    // 1e. Process Journal / PID / Session ID
    const processes = loadActiveProcesses();
    const matchedProc = processes.find((p) => String(p.pid) === rawId || p.sessionId === rawId);
    if (matchedProc) {
      const procTask = matchedProc.currentTask || "(idle)";
      return {
        found: true,
        type: "process",
        id: String(matchedProc.pid),
        status: matchedProc.isAgentRunning ? "running" : "idle",
        goal: procTask,
        currentTask: procTask,
        currentTaskStatus: matchedProc.isAgentRunning ? "in_progress" : "pending",
        currentTaskIndex: 1,
        progress: matchedProc.isAgentRunning ? "0/1 (0%)" : "0/0 (0%)",
        totalTasks: 1,
        completedTasks: 0,
        inProgressTasks: matchedProc.isAgentRunning ? 1 : 0,
        pendingTasks: matchedProc.isAgentRunning ? 0 : 1,
        percentage: 0,
        tasks: [{ status: matchedProc.isAgentRunning ? "/" : " ", text: procTask }],
        worktreePath: matchedProc.workingDirectory,
        activeTool: matchedProc.currentTool,
      };
    }

    // Explicit ID not found
    return {
      found: false,
      type: "none",
      id: rawId,
      currentTask: "",
      currentTaskStatus: "none",
      currentTaskIndex: 0,
      progress: "0/0 (0%)",
      totalTasks: 0,
      completedTasks: 0,
      inProgressTasks: 0,
      pendingTasks: 0,
      percentage: 0,
      tasks: [],
      errorMessage: `No active Superagent, Subagent, or process found with ID "${rawId}".`,
    };
  }

  // 2. If explicit workspace provided, inspect that directory
  if (opts.workspace) {
    const ws = path.resolve(opts.workspace);
    const { tasks, taskFilePath } = await findTaskFileAndRead([ws]);
    const { planContent, planFilePath } = findPlanFileAndRead([ws]);
    const taskInfo = getCurrentTaskFromChecklist(tasks);

    return {
      found: true,
      type: "workspace",
      worktreePath: ws,
      currentTask: taskInfo.task || "(no active task in workspace)",
      currentTaskStatus: taskInfo.status,
      currentTaskIndex: taskInfo.index,
      progress: `${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)`,
      totalTasks: taskInfo.total,
      completedTasks: taskInfo.completed,
      inProgressTasks: taskInfo.inProgress,
      pendingTasks: taskInfo.pending,
      percentage: taskInfo.percentage,
      tasks: taskInfo.tasks,
      taskFilePath,
      planFilePath,
      planContent,
    };
  }

  // 3. No ID or workspace provided: Auto-discover the most relevant active instance
  // 3a. Running Superagents
  for (const [id, inst] of superagentInstances.entries()) {
    if (inst.status === "running" || inst.status === "waiting") {
      return await resolveInstanceCurrentTask({ superagentId: id });
    }
  }

  // 3b. Running Subagents
  for (const [id, inst] of subagentInstances.entries()) {
    if (inst.status === "running" || inst.status === "waiting") {
      return await resolveInstanceCurrentTask({ id });
    }
  }

  // 3c. Active process in process journal
  const processes = loadActiveProcesses();
  const activeProc = processes.find((p) => p.isAgentRunning && p.currentTask);
  if (activeProc) {
    return await resolveInstanceCurrentTask({ id: String(activeProc.pid) });
  }

  // 3d. Any registered Superagent
  if (superagentInstances.size > 0) {
    const firstId = superagentInstances.keys().next().value;
    if (firstId) {
      return await resolveInstanceCurrentTask({ superagentId: firstId });
    }
  }

  // 3e. Live in-memory ProcessActivity
  const activity = getProcessActivity();
  if (activity && activity.currentTask) {
    return {
      found: true,
      type: "process",
      status: activity.isAgentRunning ? "running" : "idle",
      goal: activity.currentTask,
      currentTask: activity.currentTask,
      currentTaskStatus: activity.isAgentRunning ? "in_progress" : "pending",
      currentTaskIndex: 1,
      progress: "0/1 (0%)",
      totalTasks: 1,
      completedTasks: 0,
      inProgressTasks: activity.isAgentRunning ? 1 : 0,
      pendingTasks: activity.isAgentRunning ? 0 : 1,
      percentage: 0,
      tasks: [{ status: activity.isAgentRunning ? "/" : " ", text: activity.currentTask }],
      activeTool: activity.currentTool,
    };
  }

  // 3f. Default fallback to current working directory task files
  const cwd = process.cwd();
  const { tasks, taskFilePath } = await findTaskFileAndRead([cwd]);
  const { planContent, planFilePath } = findPlanFileAndRead([cwd]);
  const taskInfo = getCurrentTaskFromChecklist(tasks);

  return {
    found: tasks.length > 0,
    type: "workspace",
    worktreePath: cwd,
    currentTask: taskInfo.task || "(no active tasks currently)",
    currentTaskStatus: taskInfo.status,
    currentTaskIndex: taskInfo.index,
    progress: `${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)`,
    totalTasks: taskInfo.total,
    completedTasks: taskInfo.completed,
    inProgressTasks: taskInfo.inProgress,
    pendingTasks: taskInfo.pending,
    percentage: taskInfo.percentage,
    tasks: taskInfo.tasks,
    taskFilePath,
    planFilePath,
    planContent,
  };
}
