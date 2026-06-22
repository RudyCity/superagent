import fs from "fs/promises";
import path from "path";
import { superagentInstances, subagentInstances, notifySuperagentsChanged, notifySubagentsChanged, historicalSuperagentTokens, setHistoricalSuperagentTokens, masterPromptTokens, masterCompletionTokens, lastMasterPromptTokens, setMasterTokens, setLastMasterPromptTokens } from "./tools/state.js";
export class Conversation {
    messages = [];
    maxHistory = 200;
    loadedPlanState;
    contextManager = null;
    async initContextManager(config) {
        const { ContextManager: CM } = await import("./context/index.js");
        this.contextManager = new CM(config);
    }
    async updateContextManagerLLM(model, abortSignal) {
        if (!this.contextManager)
            return;
        this.contextManager.setLLMModel(model, abortSignal);
    }
    getContextManager() {
        return this.contextManager;
    }
    hasContextManager() {
        return this.contextManager !== null;
    }
    replaceMessages(newMessages) {
        this.messages = [...newMessages];
        if (this.messages.length > this.maxHistory) {
            this.messages = this.messages.slice(-this.maxHistory);
        }
    }
    async saveToFile(filePath, planState) {
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            const serializedSuperagents = Array.from(superagentInstances.values()).map(inst => {
                const { agent, ...rest } = inst;
                return {
                    ...rest,
                    historyFilePath: inst.historyFilePath || (agent && typeof agent.getCurrentHistoryFilePath === "function" ? agent.getCurrentHistoryFilePath() : undefined)
                };
            });
            const serializedSubagents = Array.from(subagentInstances.values()).map(inst => {
                const { agent, ...rest } = inst;
                return {
                    ...rest,
                    historyFilePath: inst.historyFilePath || (agent && typeof agent.getCurrentHistoryFilePath === "function" ? agent.getCurrentHistoryFilePath() : undefined)
                };
            });
            const data = {
                messages: this.messages,
                planState,
                superagents: serializedSuperagents,
                subagents: serializedSubagents,
                historicalSuperagentTokens,
                masterPromptTokens,
                masterCompletionTokens,
                lastMasterPromptTokens,
            };
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
        }
        catch (err) {
            console.error("Failed to save history:", err);
        }
    }
    async loadFromFile(filePath) {
        try {
            const data = await fs.readFile(filePath, "utf-8");
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
                this.messages = parsed.messages;
                this.loadedPlanState = parsed.planState;
                // Restore historical superagent tokens
                setHistoricalSuperagentTokens(parsed.historicalSuperagentTokens || 0);
                setMasterTokens(parsed.masterPromptTokens || 0, parsed.masterCompletionTokens || 0);
                setLastMasterPromptTokens(parsed.lastMasterPromptTokens || 0);
                // Restore superagents
                if (Array.isArray(parsed.superagents)) {
                    for (const inst of superagentInstances.values()) {
                        if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
                            try {
                                inst.agent.abort();
                            }
                            catch { }
                        }
                    }
                    superagentInstances.clear();
                    for (const s of parsed.superagents) {
                        let status = s.status;
                        let result = s.result;
                        const logs = [...(s.logs || [])];
                        let completedAt = s.completedAt;
                        if (status === "running") {
                            status = "paused";
                            result = "[Paused by session exit]";
                            logs.push("\n[SYSTEM: Resumed session, marked as paused]\n");
                        }
                        superagentInstances.set(s.id, {
                            ...s,
                            status,
                            result,
                            logs,
                            completedAt,
                            agent: {
                                abort: () => { },
                                getCurrentHistoryFilePath: () => s.historyFilePath || "",
                            }
                        });
                    }
                    notifySuperagentsChanged();
                }
                // Restore subagents
                if (Array.isArray(parsed.subagents)) {
                    for (const inst of subagentInstances.values()) {
                        if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
                            try {
                                inst.agent.abort();
                            }
                            catch { }
                        }
                    }
                    subagentInstances.clear();
                    for (const s of parsed.subagents) {
                        let status = s.status;
                        let result = s.result;
                        const logs = [...(s.logs || [])];
                        let completedAt = s.completedAt;
                        if (status === "running" || status === "idle") {
                            status = "paused";
                            result = "[Paused by session exit]";
                            logs.push("\n[SYSTEM: Resumed session, marked as paused]\n");
                        }
                        subagentInstances.set(s.id, {
                            ...s,
                            status,
                            result,
                            logs,
                            completedAt,
                            agent: {
                                abort: () => { },
                                getCurrentHistoryFilePath: () => s.historyFilePath || "",
                            }
                        });
                    }
                    notifySubagentsChanged();
                }
            }
            else if (Array.isArray(parsed)) {
                this.messages = parsed;
                this.loadedPlanState = undefined;
                setHistoricalSuperagentTokens(0);
                setMasterTokens(0, 0);
                setLastMasterPromptTokens(0);
            }
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                console.error("Failed to load history:", err);
            }
        }
    }
    addMessage(msg) {
        this.messages.push(msg);
        if (this.messages.length > this.maxHistory) {
            this.messages = this.messages.slice(-this.maxHistory);
        }
    }
    addUserMessage(content) {
        this.addMessage({
            role: "user",
            content,
            timestamp: Date.now(),
        });
    }
    addAssistantMessage(content, toolCalls, toolResults) {
        this.addMessage({
            role: "assistant",
            content,
            toolCalls,
            toolResults,
            timestamp: Date.now(),
        });
    }
    getMessages() {
        return [...this.messages];
    }
    getApiMessages() {
        return this.messages
            .filter((m) => m.role !== "system")
            .map((m) => ({
            role: m.role,
            content: m.content,
        }));
    }
    clear() {
        this.messages = [];
        setHistoricalSuperagentTokens(0);
        setMasterTokens(0, 0);
        setLastMasterPromptTokens(0);
    }
    pruneToTokenLimit(maxTokens) {
        while (this.messages.length > 2 && this.getTokenEstimate() > maxTokens) {
            const first = this.messages[0];
            if (first.role === "assistant" && first.toolCalls && first.toolCalls.length > 0) {
                this.messages.shift();
                if (this.messages.length > 0 && this.messages[0].role === "tool") {
                    this.messages.shift();
                }
            }
            else {
                this.messages.shift();
            }
        }
    }
    replaceOldMessagesWithSummary(count, summaryText) {
        const kept = this.messages.slice(count);
        const summaryMsg = {
            role: "user",
            content: `[System Conversation Summary of older turns]:\n${summaryText}`,
            timestamp: Date.now(),
        };
        this.messages = [summaryMsg, ...kept];
    }
    getCompactSummary(limit) {
        if (this.messages.length === 0)
            return "No messages yet.";
        const userMsgs = this.messages.filter((m) => m.role === "user").length;
        const assistantMsgs = this.messages.filter((m) => m.role === "assistant").length;
        const tokens = this.getTokenEstimate();
        let summary = `${this.messages.length} messages (${userMsgs} user, ${assistantMsgs} assistant)\n`;
        summary += `Estimated Token Usage: ${tokens.toLocaleString()} tokens`;
        if (limit) {
            const pct = Math.min(100, (tokens / limit) * 100);
            const barLength = 20;
            const filled = Math.round((pct / 100) * barLength);
            const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
            summary += `\nContext Window Limit : ${limit.toLocaleString()} tokens\n`;
            summary += `Usage: [${bar}] ${pct.toFixed(1)}%`;
        }
        return summary;
    }
    getTokenEstimate() {
        if (this.contextManager) {
            const breakdown = this.contextManager.estimateTokensForAll(this.messages);
            return breakdown.total;
        }
        return this.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    }
}
//# sourceMappingURL=conversation.js.map