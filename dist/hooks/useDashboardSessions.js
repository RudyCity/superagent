import { useState, useEffect } from "react";
import { subagentInstances, subscribeToSubagents, superagentInstances, subscribeToSuperagents, backgroundTasks, subscribeToTasks, masterPromptTokens, masterCompletionTokens } from "../core/tools/state.js";
export function useDashboardSessions(currentTask, masterLogs, gitBranch) {
    const [sessions, setSessions] = useState([]);
    useEffect(() => {
        const update = () => {
            const list = [];
            // Group subagents by parentId
            const subagentSessionsMap = new Map();
            for (const [id, instance] of subagentInstances.entries()) {
                const parentId = instance.parentId || "master";
                if (!subagentSessionsMap.has(parentId)) {
                    subagentSessionsMap.set(parentId, []);
                }
                subagentSessionsMap.get(parentId).push({
                    id: `${instance.typeName}-${id}`,
                    type: "SUBAGENT",
                    task: `Role: ${instance.role}`,
                    status: instance.status === "running" ? "WORKING" : instance.status === "paused" ? "PAUSED" : instance.status === "completed" ? "COMPLETED" : "IDLE",
                    tokens: (instance.tokenUsage?.prompt || 0) + (instance.tokenUsage?.completion || 0),
                    logs: instance.logs && instance.logs.length > 0 ? instance.logs : ["Awaiting output..."],
                    branch: "worktree",
                    speed: instance.speed,
                    parentId,
                });
            }
            // Check for active agents or background tasks
            const hasActiveAgentsOrTasks = [...superagentInstances.values()].some((i) => i.status === "running") ||
                [...subagentInstances.values()].some((s) => s.status === "running") ||
                [...backgroundTasks.values()].some((t) => t.isDetachedWindow || !t.hasExited);
            list.push({
                id: "master-orchestrator",
                type: "MASTER",
                task: currentTask,
                status: hasActiveAgentsOrTasks
                    ? "WORKING"
                    : (currentTask.startsWith("Idle") ? "IDLE" : (currentTask.startsWith("Error") ? "ERROR" : "WORKING")),
                tokens: masterPromptTokens + masterCompletionTokens,
                logs: masterLogs,
                branch: gitBranch,
            });
            // Push all subagent sessions belonging to "master"
            const masterSubs = subagentSessionsMap.get("master") || [];
            list.push(...masterSubs);
            // Superagent instances
            for (const [id, instance] of superagentInstances.entries()) {
                list.push({
                    id: `sa-${instance.role}-${id}`,
                    type: "SUPERAGENT",
                    task: `[${instance.role}] ${instance.task}`,
                    status: instance.status === "running" ? "WORKING"
                        : instance.status === "paused" ? "PAUSED"
                            : instance.status === "completed" ? "COMPLETED"
                                : "ERROR",
                    tokens: (instance.tokenUsage?.prompt || 0) + (instance.tokenUsage?.completion || 0),
                    logs: instance.logs.length > 0 ? instance.logs : ["Superagent initialising..."],
                    branch: instance.branch,
                    worktreePath: instance.worktreePath,
                    speed: instance.speed,
                });
                // Push all subagent sessions belonging to this superagent
                const saSubs = subagentSessionsMap.get(id) || [];
                list.push(...saSubs);
            }
            // Fallback: Remaining Subagents
            for (const [parentId, subs] of subagentSessionsMap.entries()) {
                if (parentId !== "master" && !superagentInstances.has(parentId)) {
                    list.push(...subs);
                }
            }
            // Active background tasks
            for (const [id, task] of backgroundTasks.entries()) {
                list.push({
                    id: `task-${id}`,
                    type: "TASK",
                    task: `Command: ${task.command}`,
                    status: task.hasExited ? (task.exitCode === 0 ? "COMPLETED" : "ERROR") : "WORKING",
                    tokens: 0,
                    logs: task.output && task.output.length > 0 ? task.output : ["Running task..."],
                    branch: "main",
                });
            }
            setSessions(list);
        };
        update();
        const unsubSubagents = subscribeToSubagents(update);
        const unsubSuperagents = subscribeToSuperagents(update);
        const unsubTasks = subscribeToTasks(update);
        return () => {
            unsubSubagents();
            unsubSuperagents();
            unsubTasks();
        };
    }, [masterLogs, currentTask, gitBranch]);
    return sessions;
}
//# sourceMappingURL=useDashboardSessions.js.map