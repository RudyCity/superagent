import path from "path";
import fs from "fs";
import { getGlobalConfigDir, ensureGlobalConfigDir } from "../config.js";
export const backgroundTasks = new Map();
export const taskChangeListeners = new Set();
export const activeOutputListeners = new Set();
export let activeToolOutput = "";
export function subscribeToTasks(listener) {
    taskChangeListeners.add(listener);
    return () => {
        taskChangeListeners.delete(listener);
    };
}
export function notifyTasksChanged() {
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
}
// Run cleanup every 5 minutes
setInterval(cleanupStaleInstances, 5 * 60 * 1000).unref();
//# sourceMappingURL=state.js.map