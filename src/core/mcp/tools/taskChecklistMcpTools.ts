/** MCP plan/checklist operations scoped to the active project workspace. */
import fs from "node:fs";
import path from "node:path";
import { McpToolResult } from "../types.js";
import { getMcpWorkspacePath } from "./workspaceContext.js";
import { handleGetCurrentTask } from "./workspaceStatusTools.js";
import { loadRegistry } from "../../tools/superagentRegistry.js";

export async function handleGetPlanAndTasks(args: any): Promise<McpToolResult> {
  const currentOnly = args.currentOnly ?? args.current_only ?? args.currentTaskOnly ?? false;
  if (currentOnly) {
    return await handleGetCurrentTask(args);
  }

  const { readChecklistTasks, getCurrentTaskFromChecklist } = await import("../../taskChecklist.js");
  const { resolveInstanceCurrentTask } = await import("./taskResolver.js");

  let ws = args.workspace ? path.resolve(String(args.workspace)) : "";
  let matchedInst: any = null;

  if (!ws && (args.superagentId || args.id || args.instanceId)) {
    const targetId = String(args.superagentId || args.id || args.instanceId);
    const registry = loadRegistry();
    const entry = registry.find((r) => r.id === targetId || r.name === targetId);
    if (entry && entry.worktreePath && fs.existsSync(entry.worktreePath)) {
      ws = entry.worktreePath;
      matchedInst = entry;
    } else {
      const { superagentInstances, subagentInstances } = await import("../../tools/state.js");
      const inst = superagentInstances.get(targetId);
      if (inst && inst.worktreePath && fs.existsSync(inst.worktreePath)) {
        ws = inst.worktreePath;
        matchedInst = inst;
      } else {
        const sub = subagentInstances.get(targetId);
        if (sub) {
          return await handleGetCurrentTask({ id: targetId });
        }
      }
    }
    if (!ws) {
      const { loadActiveProcesses } = await import("../processJournal.js");
      const processes = loadActiveProcesses();
      for (const p of processes) {
        if (p.activeSuperagents) {
          const matchedSa = p.activeSuperagents.find((sa) => sa.id === targetId);
          if (matchedSa && matchedSa.worktreePath && fs.existsSync(matchedSa.worktreePath)) {
            ws = matchedSa.worktreePath;
            matchedInst = matchedSa;
            break;
          }
        }
      }
    }
    if (!ws) {
      const { resolveInstanceCurrentTask } = await import("./taskResolver.js");
      const resolution = await resolveInstanceCurrentTask(args);
      if (resolution.found && resolution.worktreePath && fs.existsSync(resolution.worktreePath)) {
        ws = resolution.worktreePath;
        matchedInst = resolution;
      } else if (resolution.found && resolution.tasks.length > 0) {
        // Return resolved tasks even without a worktree directory
        const taskInfo = getCurrentTaskFromChecklist(resolution.tasks);
        const header = `=== Implementation Plan [Instance: ${targetId}] ===`;
        const lines = [header];
        if (taskInfo.task) {
          lines.push(`\n=== Current Active Task ===`);
          lines.push(`  Task: ${taskInfo.task}`);
          lines.push(`  Status: ${taskInfo.status === "in_progress" ? "[/] (In Progress)" : "[ ] (Pending)"}`);
          lines.push(`  Progress: ${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)`);
        }
        lines.push(`\n${resolution.planContent || "(No plan document found)"}`);
        lines.push("\n=== Task Checklist ===");
        for (const t of resolution.tasks) {
          lines.push(`  - [${t.status}] ${t.text}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } else {
        return {
          content: [{ type: "text", text: `Error: No active or registered worktree found for Superagent instance "${targetId}".` }],
          isError: true,
        };
      }
    }
  }

  if (!ws) {
    ws = getMcpWorkspacePath();
  }

  let foundTasks: any[] = [];
  let planContent = "(No plan document found)";

  const resolution = await resolveInstanceCurrentTask(args.workspace ? args : { ...args, workspace: ws });
  if (resolution.found) {
    if (resolution.tasks && resolution.tasks.length > 0) {
      foundTasks = resolution.tasks;
    }
    if (resolution.planContent) {
      planContent = resolution.planContent;
    }
    if (resolution.worktreePath && !args.workspace) {
      ws = resolution.worktreePath;
    }
  }

  if (foundTasks.length === 0) {
    const taskFiles = [
      path.join(ws, "_task.md"),
      path.join(ws, "task.md"),
      path.join(ws, "tasks.md"),
    ];
    if (matchedInst?.historyFilePath) {
      taskFiles.push(matchedInst.historyFilePath.replace(/\.json$/, "_task.md"));
    }

    for (const tf of taskFiles) {
      if (fs.existsSync(tf)) {
        const res = await readChecklistTasks(tf);
        if (res.tasks && res.tasks.length > 0) {
          foundTasks = res.tasks;
          break;
        }
      }
    }
  }

  if (planContent === "(No plan document found)") {
    const planFiles = [
      path.join(ws, "_plan.md"),
      path.join(ws, "plan.md"),
      path.join(ws, "implementation_plan.md"),
    ];
    if (matchedInst?.historyFilePath) {
      planFiles.push(matchedInst.historyFilePath.replace(/\.json$/, "_implementation_plan.md"));
    }

    for (const pf of planFiles) {
      if (fs.existsSync(pf)) {
        planContent = fs.readFileSync(pf, "utf-8");
        break;
      }
    }
  }

  const taskInfo = getCurrentTaskFromChecklist(foundTasks);
  const header = args.superagentId || args.id || args.instanceId
    ? `=== Implementation Plan [Instance: ${args.superagentId || args.id || args.instanceId}] ===`
    : "=== Implementation Plan ===";
  const lines = [header];

  if (taskInfo.task) {
    const statusLabel =
      taskInfo.status === "in_progress"
        ? "[/] (In Progress)"
        : taskInfo.status === "pending"
        ? "[ ] (Pending)"
        : taskInfo.status === "completed"
        ? "[x] (Completed)"
        : "";
    lines.push(`\n=== Current Active Task ===`);
    lines.push(`  Task: ${taskInfo.task}`);
    if (statusLabel) lines.push(`  Status: ${statusLabel}`);
    if (taskInfo.total > 0) {
      lines.push(`  Progress: ${taskInfo.completed}/${taskInfo.total} (${taskInfo.percentage}%)`);
    }
  }

  lines.push(`\n${planContent.slice(0, 1500)}`);
  lines.push("\n=== Task Checklist ===");
  if (foundTasks.length === 0) {
    lines.push("  No checklist tasks found.");
  } else {
    for (const t of foundTasks) {
      const check = t.status === "x" ? "[x]" : t.status === "/" ? "[/]" : "[ ]";
      lines.push(`  - ${check} ${t.text}`);
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
}
