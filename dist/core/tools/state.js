import path from "path";
import fs from "fs";
import { getGlobalConfigDir, ensureGlobalConfigDir, getRootConfigDir } from "../config.js";
export const backgroundTasks = new Map();
export const taskChangeListeners = new Set();
export const activeOutputListeners = new Set();
export let activeToolOutput = "";
function acquireTasksLockSync(lockPath) {
    const start = Date.now();
    const timeoutMs = 2000;
    while (Date.now() - start < timeoutMs) {
        try {
            const fd = fs.openSync(lockPath, "wx");
            fs.writeFileSync(fd, String(process.pid));
            fs.closeSync(fd);
            return true;
        }
        catch (err) {
            if (err.code === "ENOENT") {
                try {
                    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
                }
                catch { }
            }
            // Simple sleep/retry
            const sab = new SharedArrayBuffer(4);
            const int32 = new Int32Array(sab);
            try {
                Atomics.wait(int32, 0, 0, 50);
            }
            catch {
                const end = Date.now() + 50;
                while (Date.now() < end) { }
            }
        }
    }
    return false;
}
function releaseTasksLockSync(lockPath) {
    try {
        if (fs.existsSync(lockPath)) {
            fs.unlinkSync(lockPath);
        }
    }
    catch { }
}
export function savePersistedTasks() {
    const rootDir = getRootConfigDir();
    if (!rootDir)
        return;
    const tasksFilePath = path.join(rootDir, "background-tasks.json");
    const lockPath = tasksFilePath + ".lock";
    if (!acquireTasksLockSync(lockPath)) {
        return;
    }
    try {
        const list = [];
        for (const [id, task] of backgroundTasks.entries()) {
            if (task.hasExited && !task.completedAt) {
                task.completedAt = Date.now();
            }
            list.push({
                id: task.id,
                command: task.command,
                pid: task.process?.pid || 0,
                logPath: task.logPath,
                isDetachedWindow: task.isDetachedWindow,
                windowLabel: task.windowLabel,
                autoRetry: task.autoRetry,
                onExit: task.onExit,
                hasExited: !!task.hasExited,
                exitCode: task.exitCode,
                completedAt: task.completedAt,
            });
        }
        fs.writeFileSync(tasksFilePath, JSON.stringify(list, null, 2), "utf-8");
    }
    catch (err) {
        // Ignore errors
    }
    finally {
        releaseTasksLockSync(lockPath);
    }
}
// Global flag to prevent re-entrant calls to loadAndSyncPersistedTasks
let isSyncing = false;
export function loadAndSyncPersistedTasks() {
    if (isSyncing)
        return;
    isSyncing = true;
    try {
        const rootDir = getRootConfigDir();
        if (!rootDir)
            return;
        const tasksFilePath = path.join(rootDir, "background-tasks.json");
        if (!fs.existsSync(tasksFilePath)) {
            return;
        }
        const lockPath = tasksFilePath + ".lock";
        if (!acquireTasksLockSync(lockPath)) {
            return;
        }
        try {
            const content = fs.readFileSync(tasksFilePath, "utf-8");
            const list = JSON.parse(content);
            let changed = false;
            for (const item of list) {
                let isAlive = false;
                if (item.pid > 0) {
                    try {
                        process.kill(item.pid, 0);
                        isAlive = true;
                    }
                    catch (e) {
                        isAlive = (e.code === "EPERM");
                    }
                }
                const hasExited = !isAlive;
                const exitCode = hasExited ? (item.exitCode ?? -1) : null;
                const completedAt = hasExited ? (item.completedAt ?? Date.now()) : undefined;
                const existing = backgroundTasks.get(item.id);
                if (existing) {
                    if (existing.hasExited !== hasExited) {
                        existing.hasExited = hasExited;
                        existing.exitCode = exitCode;
                        existing.completedAt = completedAt;
                        changed = true;
                    }
                }
                else {
                    const restoredTask = {
                        id: item.id,
                        command: item.command,
                        process: {
                            pid: item.pid,
                            killed: hasExited,
                            stdin: null,
                        },
                        output: [],
                        logPath: item.logPath,
                        hasExited,
                        exitCode,
                        isDetachedWindow: item.isDetachedWindow,
                        windowLabel: item.windowLabel,
                        autoRetry: item.autoRetry,
                        onExit: item.onExit,
                        completedAt,
                    };
                    if (item.logPath && fs.existsSync(item.logPath)) {
                        try {
                            const logs = fs.readFileSync(item.logPath, "utf-8");
                            restoredTask.output = logs.split("\n").map(l => l + "\n").slice(-1000);
                        }
                        catch { }
                    }
                    backgroundTasks.set(item.id, restoredTask);
                    changed = true;
                }
            }
            if (changed) {
                const updatedList = [];
                for (const [id, task] of backgroundTasks.entries()) {
                    updatedList.push({
                        id: task.id,
                        command: task.command,
                        pid: task.process?.pid || 0,
                        logPath: task.logPath,
                        isDetachedWindow: task.isDetachedWindow,
                        windowLabel: task.windowLabel,
                        autoRetry: task.autoRetry,
                        onExit: task.onExit,
                        hasExited: !!task.hasExited,
                        exitCode: task.exitCode,
                        completedAt: task.completedAt,
                    });
                }
                fs.writeFileSync(tasksFilePath, JSON.stringify(updatedList, null, 2), "utf-8");
            }
            if (changed) {
                setTimeout(() => {
                    for (const listener of taskChangeListeners) {
                        listener();
                    }
                }, 0);
            }
        }
        catch (err) {
            // Ignore errors
        }
        finally {
            releaseTasksLockSync(lockPath);
        }
    }
    finally {
        isSyncing = false;
    }
}
export function subscribeToTasks(listener) {
    taskChangeListeners.add(listener);
    return () => {
        taskChangeListeners.delete(listener);
    };
}
export function notifyTasksChanged() {
    if (!isSyncing) {
        savePersistedTasks();
    }
    for (const listener of taskChangeListeners) {
        listener();
    }
}
export function subscribeToActiveOutput(listener) {
    activeOutputListeners.add(listener);
    return () => {
        activeOutputListeners.delete(listener);
    };
}
export function getActiveToolOutput() {
    return activeToolOutput;
}
export function clearActiveToolOutput() {
    activeToolOutput = "";
    for (const listener of activeOutputListeners) {
        listener("");
    }
}
export function appendActiveToolOutput(text) {
    activeToolOutput += text;
    const lines = activeToolOutput.split("\n");
    if (lines.length > 50) {
        activeToolOutput = lines.slice(lines.length - 50).join("\n");
    }
    for (const listener of activeOutputListeners) {
        listener(activeToolOutput);
    }
}
export const scheduledJobs = new Map();
export const scheduleChangeListeners = new Set();
export function subscribeToSchedules(listener) {
    scheduleChangeListeners.add(listener);
    return () => {
        scheduleChangeListeners.delete(listener);
    };
}
export function notifyScheduleTriggered(jobId, prompt) {
    for (const listener of scheduleChangeListeners) {
        listener(jobId, prompt);
    }
}
export const subagentTypes = new Map();
export const subagentInstances = new Map();
export const superagentTypes = new Map();
export const subagentChangeListeners = new Set();
export function subscribeToSubagents(listener) {
    subagentChangeListeners.add(listener);
    return () => {
        subagentChangeListeners.delete(listener);
    };
}
export function notifySubagentsChanged() {
    for (const listener of subagentChangeListeners) {
        listener();
    }
}
export function registerSubagentType(name, description, systemPrompt) {
    subagentTypes.set(name, { name, description, systemPrompt });
}
export function registerSuperagentType(name, description, systemPrompt) {
    superagentTypes.set(name, { name, description, systemPrompt });
}
export let activeQuestionHandler = null;
export function registerQuestionHandler(handler) {
    activeQuestionHandler = handler;
}
export function getActiveQuestionHandler() {
    return activeQuestionHandler;
}
// ─── Master Agent Reference ──────────────────────────────────────────────────
// Global reference to the Master Agent instance. Used by Subagents and
// Superagents to route ask_question requests to the Master for answering
// (instead of forwarding directly to the user UI).
export let masterAgentRef = null;
export function registerMasterAgent(agent) {
    masterAgentRef = agent;
}
export function getMasterAgent() {
    return masterAgentRef;
}
// ─── Superagent Instances ────────────────────────────────────────────────────
export const superagentInstances = new Map();
export let historicalSuperagentTokens = 0;
export function addHistoricalSuperagentTokens(tokens) {
    historicalSuperagentTokens += tokens || 0;
}
export function setHistoricalSuperagentTokens(tokens) {
    historicalSuperagentTokens = tokens || 0;
}
export let masterPromptTokens = 0;
export let masterCompletionTokens = 0;
export let lastMasterPromptTokens = 0;
export function addMasterTokens(prompt, completion) {
    masterPromptTokens += prompt || 0;
    masterCompletionTokens += completion || 0;
    lastMasterPromptTokens = prompt || 0;
    notifySuperagentsChanged();
}
export function setMasterTokens(prompt, completion) {
    masterPromptTokens = prompt || 0;
    masterCompletionTokens = completion || 0;
}
export function setLastMasterPromptTokens(prompt) {
    lastMasterPromptTokens = prompt || 0;
    notifySuperagentsChanged();
}
export const superagentChangeListeners = new Set();
export function subscribeToSuperagents(listener) {
    superagentChangeListeners.add(listener);
    return () => superagentChangeListeners.delete(listener);
}
export function notifySuperagentsChanged() {
    for (const listener of superagentChangeListeners) {
        listener();
    }
}
export const masterLogListeners = new Set();
export function subscribeToMasterLogs(listener) {
    masterLogListeners.add(listener);
    return () => {
        masterLogListeners.delete(listener);
    };
}
export function appendMasterLog(msg) {
    for (const listener of masterLogListeners) {
        listener(msg);
    }
}
// ─── Tools Error Log ─────────────────────────────────────────────────────────
// Dedicated log file for tool execution errors across all tiers.
export function appendToolsErrorLog(tier, depth, toolName, message, meta) {
    try {
        ensureGlobalConfigDir();
        const logPath = path.join(getGlobalConfigDir(), "superagent-tools.log");
        const timestamp = new Date().toISOString();
        const metaStr = meta && Object.keys(meta).length > 0 ? ` | meta:${JSON.stringify(meta)}` : "";
        const line = `[${timestamp}] [tier:${tier}] [depth:${depth}] [tool:${toolName}] ${message}${metaStr}\n`;
        fs.appendFileSync(logPath, line, "utf-8");
    }
    catch {
        // Ignore log write errors to prevent crashing the agent
    }
}
// ─── TTL Cleanup ─────────────────────────────────────────────────────────────
const INSTANCE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export function cleanupStaleInstances() {
    const now = Date.now();
    for (const [id, inst] of superagentInstances.entries()) {
        if (inst.status !== "running" && inst.completedAt) {
            if (now - inst.completedAt > INSTANCE_TTL_MS) {
                superagentInstances.delete(id);
            }
        }
    }
    for (const [id, inst] of subagentInstances.entries()) {
        if (inst.status === "completed" && inst.completedAt) {
            if (now - inst.completedAt > INSTANCE_TTL_MS) {
                subagentInstances.delete(id);
            }
        }
    }
    let tasksChanged = false;
    for (const [id, task] of backgroundTasks.entries()) {
        if (task.hasExited && task.completedAt) {
            if (now - task.completedAt > INSTANCE_TTL_MS) {
                backgroundTasks.delete(id);
                tasksChanged = true;
            }
        }
    }
    if (tasksChanged) {
        notifyTasksChanged();
    }
}
// Run cleanup every 5 minutes
setInterval(cleanupStaleInstances, 5 * 60 * 1000).unref();
// Initial load and periodic synchronization of background tasks
try {
    loadAndSyncPersistedTasks();
    setInterval(loadAndSyncPersistedTasks, 3000).unref();
}
catch { }
//# sourceMappingURL=state.js.map