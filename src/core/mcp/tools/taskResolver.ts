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
import { getRootConfigDir } from "../../config/paths.js";

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
 * Scan history directories (multi and single) for the most recently modified session task file.
 */
export function findLatestSessionTaskFile(): string | null {
  try {
    const historyDir = path.join(getRootConfigDir(), "history");
    if (!fs.existsSync(historyDir)) return null;

    const candidates: { filePath: string; mtime: number }[] = [];
    for (const mode of ["multi", "single"]) {
      const modeDir = path.join(historyDir, mode);
      if (!fs.existsSync(modeDir)) continue;
      const sessions = fs.readdirSync(modeDir);
      for (const sess of sessions) {
        const sessDir = path.join(modeDir, sess);
        try {
          const stat = fs.statSync(sessDir);
          if (stat.isDirectory()) {
            const taskFile = path.join(sessDir, `${sess}_task.md`);
            if (fs.existsSync(taskFile)) {
              candidates.push({ filePath: taskFile, mtime: fs.statSync(taskFile).mtimeMs });
            }
          }
        } catch {}
      }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.mtime - a.mtime);
    return candidates[0].filePath;
  } catch {
    return null;
  }
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
    if (filePath.endsWith(".json")) {
      const taskFromHistory = filePath.replace(/\.json$/, "_task.md");
      if (fs.existsSync(taskFromHistory)) {
        const res = await readChecklistTasks(taskFromHistory);
        if (res.tasks && res.tasks.length > 0) {
          return { tasks: res.tasks, taskFilePath: taskFromHistory };
        }
      }
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      for (const name of ["_task.md", "task.md", "tasks.md"]) {
        const full = path.join(filePath, name);
        if (fs.existsSync(full)) {
          filePath = full;
          break;
        }
      }
      if (fs.statSync(filePath).isDirectory()) {
        try {
          const files = fs.readdirSync(filePath);
          const matchedTask = files.find((f) => f.endsWith("_task.md") || f === "task.md" || f === "tasks.md");
          if (matchedTask) {
            filePath = path.join(filePath, matchedTask);
          }
        } catch {}
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
    if (filePath.endsWith(".json")) {
      const planFromHistory = filePath.replace(/\.json$/, "_implementation_plan.md");
      if (fs.existsSync(planFromHistory)) {
        try {
          const content = fs.readFileSync(planFromHistory, "utf-8");
          return { planContent: content, planFilePath: planFromHistory };
        } catch {}
      }
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      for (const name of ["_plan.md", "plan.md", "implementation_plan.md", "_implementation_plan.md"]) {
        const full = path.join(filePath, name);
        if (fs.existsSync(full)) {
          filePath = full;
          break;
        }
      }
      if (fs.statSync(filePath).isDirectory()) {
        try {
          const files = fs.readdirSync(filePath);
          const matchedPlan = files.find(
            (f) =>
              f.endsWith("_implementation_plan.md") ||
              f.endsWith("_plan.md") ||
              f === "implementation_plan.md" ||
              f === "plan.md"
          );
          if (matchedPlan) {
            filePath = path.join(filePath, matchedPlan);
          }
        } catch {}
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

  // 1. If explicit ID provided, check Superagents, Subagents, or Process
  if (rawId) {
    // 1a. In-memory Superagent
    let superagent = superagentInstances.get(rawId);
    let worktreePath = superagent?.worktreePath;
    let historyFilePath = superagent?.historyFilePath;
    let taskFilePathCandidate = superagent?.historyFilePath ? superagent.historyFilePath.replace(/\.json$/, "_task.md") : undefined;
    let goal = superagent?.task;
    let role = superagent?.role;
    let branch = superagent?.branch;
    let status = superagent?.status;

    // 1b. Registered worktree (worktree-registry.json)
    if (!superagent) {
      const registry = loadRegistry();
      const entry = registry.find((r) => r.id === rawId || r.name === rawId);
      if (entry) {
        worktreePath = entry.worktreePath;
        role = entry.role;
        branch = entry.branch;
        status = entry.status;
        historyFilePath = entry.historyFilePath;
        taskFilePathCandidate = entry.taskFilePath;
        goal = entry.task;
      }
    }

    // 1c. Process Journal active superagents lookup across processes
    const processes = loadActiveProcesses();
    let procOwner: any = null;
    if (!superagent && !worktreePath) {
      for (const p of processes) {
        if (p.activeSuperagents) {
          const matchedSa = p.activeSuperagents.find((sa) => sa.id === rawId);
          if (matchedSa) {
            role = matchedSa.role;
            branch = matchedSa.branch;
            status = matchedSa.status as any;
            goal = matchedSa.task;
            worktreePath = matchedSa.worktreePath;
            historyFilePath = matchedSa.historyFilePath;
            taskFilePathCandidate = matchedSa.taskFilePath;
            procOwner = p;
            break;
          }
        }
      }
    }

    // 1d. Server API query fallback
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
      if (taskFilePathCandidate) candidateTaskPaths.push(taskFilePathCandidate);
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
      // Check session superagents folder
      try {
        const historyDir = path.join(getRootConfigDir(), "history", "multi");
        if (fs.existsSync(historyDir)) {
          for (const sDir of fs.readdirSync(historyDir)) {
            const saTask = path.join(historyDir, sDir, "superagents", rawId, `${rawId}_task.md`);
            if (fs.existsSync(saTask)) candidateTaskPaths.push(saTask);
          }
        }
      } catch {}

      const { tasks, taskFilePath } = await findTaskFileAndRead(candidateTaskPaths);
      const { planContent, planFilePath } = findPlanFileAndRead(
        worktreePath ? [worktreePath, ...candidateTaskPaths] : candidateTaskPaths
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

    // 1e. Subagent Instance (in-memory, process journal, or server API)
    let subagent = subagentInstances.get(rawId);
    if (!subagent) {
      for (const p of processes) {
        if (p.activeSubagents) {
          const matchedSub = p.activeSubagents.find((s) => s.id === rawId);
          if (matchedSub) {
            subagent = matchedSub as any;
            break;
          }
        }
      }
    }
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

    // 1f. Process Journal / PID / Session ID
    const matchedProc = processes.find((p) => String(p.pid) === rawId || p.sessionId === rawId);
    if (matchedProc) {
      const procCandidates: string[] = [];
      if (matchedProc.taskFilePath) procCandidates.push(matchedProc.taskFilePath);
      if (matchedProc.sessionId) {
        const root = getRootConfigDir();
        procCandidates.push(path.join(root, "history", matchedProc.mode === "multi" ? "multi" : "single", matchedProc.sessionId, `${matchedProc.sessionId}_task.md`));
        procCandidates.push(path.join(root, "history", "single", matchedProc.sessionId, `${matchedProc.sessionId}_task.md`));
        procCandidates.push(path.join(root, "history", "multi", matchedProc.sessionId, `${matchedProc.sessionId}_task.md`));
      }
      if (matchedProc.workingDirectory) {
        procCandidates.push(matchedProc.workingDirectory);
      }

      const { tasks, taskFilePath } = await findTaskFileAndRead(procCandidates);
      const { planContent, planFilePath } = findPlanFileAndRead(
        matchedProc.planFilePath ? [matchedProc.planFilePath, ...procCandidates] : procCandidates
      );

      const taskInfo = getCurrentTaskFromChecklist(tasks);
      const procTask = taskInfo.task || matchedProc.currentTask || "(idle)";
      const taskStatus = taskInfo.status !== "none" ? taskInfo.status : (matchedProc.isAgentRunning ? "in_progress" : "pending");

      return {
        found: true,
        type: "process",
        id: String(matchedProc.pid),
        status: matchedProc.isAgentRunning ? "running" : "idle",
        goal: matchedProc.currentTask || procTask,
        currentTask: procTask,
        currentTaskStatus: taskStatus,
        currentTaskIndex: taskInfo.index || 1,
        progress: taskInfo.total > 0 ? `${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)` : (matchedProc.isAgentRunning ? "0/1 (0%)" : "0/0 (0%)"),
        totalTasks: taskInfo.total || 1,
        completedTasks: taskInfo.completed || 0,
        inProgressTasks: taskInfo.inProgress || (matchedProc.isAgentRunning ? 1 : 0),
        pendingTasks: taskInfo.pending || (matchedProc.isAgentRunning ? 0 : 1),
        percentage: taskInfo.percentage,
        tasks: taskInfo.tasks.length > 0 ? taskInfo.tasks : [{ status: matchedProc.isAgentRunning ? "/" : " ", text: procTask }],
        worktreePath: matchedProc.workingDirectory,
        taskFilePath,
        planFilePath,
        planContent,
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
    const candidatePaths = [ws];

    // Check if an active process has this workspace and inspect its session task file
    const processes = loadActiveProcesses();
    const wsProc = processes.find((p) => path.resolve(p.workingDirectory) === ws);
    if (wsProc?.taskFilePath) {
      candidatePaths.unshift(wsProc.taskFilePath);
    }
    if (wsProc?.sessionId) {
      const root = getRootConfigDir();
      candidatePaths.push(path.join(root, "history", wsProc.mode === "multi" ? "multi" : "single", wsProc.sessionId, `${wsProc.sessionId}_task.md`));
      candidatePaths.push(path.join(root, "history", "single", wsProc.sessionId, `${wsProc.sessionId}_task.md`));
      candidatePaths.push(path.join(root, "history", "multi", wsProc.sessionId, `${wsProc.sessionId}_task.md`));
    }

    const { tasks, taskFilePath } = await findTaskFileAndRead(candidatePaths);
    const { planContent, planFilePath } = findPlanFileAndRead(
      wsProc?.planFilePath ? [wsProc.planFilePath, ...candidatePaths] : candidatePaths
    );
    const taskInfo = getCurrentTaskFromChecklist(tasks);

    return {
      found: true,
      type: "workspace",
      worktreePath: ws,
      currentTask: taskInfo.task || wsProc?.currentTask || "(no active task in workspace)",
      currentTaskStatus: taskInfo.status !== "none" ? taskInfo.status : (wsProc?.isAgentRunning ? "in_progress" : "none"),
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
  // 3a. Running Superagents (in-memory)
  for (const [id, inst] of superagentInstances.entries()) {
    if (inst.status === "running" || inst.status === "waiting") {
      return await resolveInstanceCurrentTask({ superagentId: id });
    }
  }

  // 3b. Running Subagents (in-memory)
  for (const [id, inst] of subagentInstances.entries()) {
    if (inst.status === "running" || inst.status === "waiting") {
      return await resolveInstanceCurrentTask({ id });
    }
  }

  // 3c. Active processes in process journal
  const processes = loadActiveProcesses();

  // 3c-1. Check running Superagents across active processes
  for (const p of processes) {
    if (p.activeSuperagents) {
      const runningSa = p.activeSuperagents.find((sa) => sa.status === "running" || sa.status === "waiting");
      if (runningSa) {
        return await resolveInstanceCurrentTask({ superagentId: runningSa.id });
      }
    }
  }

  // 3c-2. Check running Subagents across active processes
  for (const p of processes) {
    if (p.activeSubagents) {
      const runningSub = p.activeSubagents.find((sub) => sub.status === "running" || sub.status === "waiting");
      if (runningSub) {
        return await resolveInstanceCurrentTask({ id: runningSub.id });
      }
    }
  }

  // 3c-3. Active running process in process journal (isAgentRunning)
  const activeRunningProc = processes.find((p) => p.isAgentRunning && p.currentTask);
  if (activeRunningProc) {
    return await resolveInstanceCurrentTask({ id: String(activeRunningProc.pid) });
  }

  // 3c-4. Any process from process journal (even idle between turns)
  if (processes.length > 0) {
    const sortedProcs = [...processes].sort((a, b) => (b.lastHeartbeat || 0) - (a.lastHeartbeat || 0));
    return await resolveInstanceCurrentTask({ id: String(sortedProcs[0].pid) });
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
    const candidatePaths = [activity.taskFilePath, activity.workingDirectory].filter(Boolean) as string[];
    const { tasks, taskFilePath } = await findTaskFileAndRead(candidatePaths);
    const taskInfo = getCurrentTaskFromChecklist(tasks);
    const currentTask = taskInfo.task || activity.currentTask;
    return {
      found: true,
      type: "process",
      status: activity.isAgentRunning ? "running" : "idle",
      goal: activity.currentTask,
      currentTask,
      currentTaskStatus: taskInfo.status !== "none" ? taskInfo.status : (activity.isAgentRunning ? "in_progress" : "pending"),
      currentTaskIndex: taskInfo.index || 1,
      progress: taskInfo.total > 0 ? `${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)` : "0/1 (0%)",
      totalTasks: taskInfo.total || 1,
      completedTasks: taskInfo.completed || 0,
      inProgressTasks: taskInfo.inProgress || (activity.isAgentRunning ? 1 : 0),
      pendingTasks: taskInfo.pending || (activity.isAgentRunning ? 0 : 1),
      percentage: taskInfo.percentage,
      tasks: taskInfo.tasks.length > 0 ? taskInfo.tasks : [{ status: activity.isAgentRunning ? "/" : " ", text: activity.currentTask }],
      activeTool: activity.currentTool,
      taskFilePath,
    };
  }

  // 3f. Scan history directory for the latest session task file
  const latestSessionTask = findLatestSessionTaskFile();
  if (latestSessionTask) {
    const { tasks, taskFilePath } = await findTaskFileAndRead([latestSessionTask]);
    if (tasks.length > 0) {
      const taskInfo = getCurrentTaskFromChecklist(tasks);
      return {
        found: true,
        type: "workspace",
        worktreePath: path.dirname(latestSessionTask),
        currentTask: taskInfo.task || "(no active tasks)",
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
      };
    }
  }

  // 3g. Default fallback to current working directory task files
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
