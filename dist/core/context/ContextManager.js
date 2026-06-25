import { EventEmitter } from "events";
import { TokenTracker } from "./TokenTracker.js";
import { SummarizationStrategy } from "./strategies/SummarizationStrategy.js";
import { PruningStrategy } from "./strategies/PruningStrategy.js";
import { PinningStrategy } from "./strategies/PinningStrategy.js";
import { TencentDBMemoryStrategy } from "./strategies/TencentDBMemoryStrategy.js";
import { SemanticAnalyzer } from "./SemanticAnalyzer.js";
import { CompactionHistory } from "./CompactionHistory.js";
export class ContextManager {
    state = "IDLE";
    tokenTracker;
    strategies;
    semanticAnalyzer;
    history;
    eventEmitter;
    config;
    pinnedMessages = new Map();
    constructor(config) {
        this.config = config;
        this.tokenTracker = new TokenTracker(config.model);
        this.semanticAnalyzer = new SemanticAnalyzer();
        this.history = new CompactionHistory(config.historyFilePath);
        this.eventEmitter = new EventEmitter();
        const summarizationStrategy = new SummarizationStrategy({
            model: config.llmModel,
            abortSignal: config.abortSignal,
        });
        this.strategies = [
            new PinningStrategy(),
            new TencentDBMemoryStrategy({ historyFilePath: config.historyFilePath }),
            summarizationStrategy,
            new PruningStrategy(),
        ];
    }
    setLLMModel(model, abortSignal) {
        const summarizationStrategy = this.strategies.find((s) => s.name === "summarization");
        if (summarizationStrategy) {
            summarizationStrategy.setConfig({ model, abortSignal });
        }
    }
    shouldCompact(messages) {
        const breakdown = this.tokenTracker.estimateTokensForAll(messages);
        const totalTokens = breakdown.total;
        const threshold = this.calculateThreshold();
        if (totalTokens < threshold * 0.8) {
            return { shouldCompact: false, reason: "below-threshold" };
        }
        if (totalTokens >= threshold) {
            const urgency = totalTokens > threshold * 1.2 ? "critical" : "normal";
            return {
                shouldCompact: true,
                reason: `threshold-exceeded (${totalTokens} >= ${threshold})`,
                urgency,
                recommendedStrategy: this.selectStrategy(messages),
            };
        }
        return { shouldCompact: false, reason: "approaching-threshold" };
    }
    async compact(messages, strategy, abortSignal) {
        this.setState("CHECKING");
        try {
            const selectedStrategy = strategy || this.selectStrategy(messages);
            const context = this.buildCompactionContext(messages);
            if (!selectedStrategy.canHandle(context)) {
                throw new Error(`Strategy ${selectedStrategy.name} cannot handle current context`);
            }
            this.setState("COMPACTING");
            this.emit("compaction:start", { strategy: selectedStrategy.name });
            const result = await selectedStrategy.execute(messages, {
                tokenBudget: this.calculateThreshold(),
                pinnedMessageIds: new Set(this.pinnedMessages.keys()),
                abortSignal,
            });
            this.setState("VALIDATING");
            this.validateResult(result);
            const tokensBefore = this.tokenTracker.estimateTokensForAll(messages).total;
            const tokensAfter = this.tokenTracker.estimateTokensForAll(result.messages).total;
            await this.history.record({
                id: this.generateId(),
                timestamp: Date.now(),
                strategy: selectedStrategy.name,
                messagesBefore: messages.length,
                messagesAfter: result.messages.length,
                tokensBefore,
                tokensAfter,
                summary: result.metadata.summary,
                reason: "threshold",
            });
            this.setState("IDLE");
            this.emit("compaction:complete", result);
            return result;
        }
        catch (error) {
            this.setState("FAILED");
            this.emit("compaction:fail", error);
            return this.recover(messages, error);
        }
        finally {
            this.setState("IDLE");
        }
    }
    getState() {
        return this.state;
    }
    on(event, handler) {
        this.eventEmitter.on(event, handler);
    }
    off(event, handler) {
        this.eventEmitter.off(event, handler);
    }
    setThreshold(threshold) {
        if (threshold !== "auto") {
            this.config.contextWindowLimit = threshold;
        }
    }
    setModel(model) {
        this.config.model = model;
        this.tokenTracker.setModel(model);
    }
    addPinnedMessage(messageId, data) {
        if (data) {
            // Store full pinned message data
            const pinned = {
                id: messageId,
                role: data.role || "unknown",
                content: data.content || "",
                timestamp: data.timestamp || Date.now(),
                pinnedAt: data.pinnedAt || Date.now(),
                originalIndex: data.originalIndex ?? -1,
                agentTag: data.agentTag,
                toolCalls: data.toolCalls,
                toolResults: data.toolResults,
                tag: data.tag,
            };
            this.pinnedMessages.set(messageId, pinned);
        }
        else {
            // Backward-compatible: just store ID with minimal data
            if (!this.pinnedMessages.has(messageId)) {
                this.pinnedMessages.set(messageId, {
                    id: messageId,
                    role: "unknown",
                    content: "",
                    timestamp: Date.now(),
                    pinnedAt: Date.now(),
                    originalIndex: -1,
                });
            }
        }
    }
    removePinnedMessage(messageId) {
        this.pinnedMessages.delete(messageId);
    }
    /** Backward-compatible: returns just the set of pinned message IDs */
    getPinnedMessages() {
        return new Set(this.pinnedMessages.keys());
    }
    /** Returns full pinned message data as a Map */
    getPinnedMessagesFull() {
        return new Map(this.pinnedMessages);
    }
    /** Get a single pinned message by ID */
    getPinnedMessage(messageId) {
        return this.pinnedMessages.get(messageId);
    }
    /** Update tag/label on a pinned message */
    setPinnedMessageTag(messageId, tag) {
        const pinned = this.pinnedMessages.get(messageId);
        if (!pinned)
            return false;
        pinned.tag = tag;
        return true;
    }
    /** Restore pinned messages from serialized data (for session restore) */
    restorePinnedMessages(data) {
        this.pinnedMessages.clear();
        for (const item of data) {
            this.pinnedMessages.set(item.id, item);
        }
    }
    /** Serialize pinned messages for persistence */
    serializePinnedMessages() {
        return Array.from(this.pinnedMessages.values());
    }
    getHistory() {
        return this.history.getHistory();
    }
    getTokenTracker() {
        return this.tokenTracker;
    }
    getSemanticAnalyzer() {
        return this.semanticAnalyzer;
    }
    estimateTokensForAll(messages) {
        return this.tokenTracker.estimateTokensForAll(messages);
    }
    estimateTokens(message) {
        return this.tokenTracker.estimateTokens(message);
    }
    calculateThreshold() {
        const modelLimit = this.config.contextWindowLimit;
        const responseBuffer = 8000;
        const toolCallBuffer = 10000;
        const threshold = modelLimit - responseBuffer - toolCallBuffer;
        return Math.min(threshold, modelLimit * 0.75);
    }
    selectStrategy(messages) {
        const context = this.buildCompactionContext(messages);
        for (const strategy of this.strategies) {
            if (strategy.canHandle(context)) {
                return strategy;
            }
        }
        return this.strategies[this.strategies.length - 1];
    }
    buildCompactionContext(messages) {
        return {
            messages,
            tokenBudget: this.calculateThreshold(),
            hasPinnedMessages: this.pinnedMessages.size > 0,
            pinnedMessageIds: new Set(this.pinnedMessages.keys()),
        };
    }
    validateResult(result) {
        if (!result.messages || result.messages.length === 0) {
            throw new Error("Compaction result has no messages");
        }
        if (!result.metadata || !result.metadata.strategy) {
            throw new Error("Compaction result missing metadata");
        }
    }
    async recover(messages, error) {
        this.setState("RECOVERING");
        console.error("Compaction failed, attempting recovery:", error.message);
        try {
            const pruningStrategy = new PruningStrategy();
            return await pruningStrategy.execute(messages, {
                preserveRecent: 20,
            });
        }
        catch (recoveryError) {
            console.error("Recovery failed:", recoveryError);
            return {
                messages: messages.slice(-20),
                metadata: {
                    strategy: "emergency-truncation",
                    reason: "all-strategies-failed",
                    messagesBefore: messages.length,
                    messagesAfter: Math.min(20, messages.length),
                },
            };
        }
    }
    setState(state) {
        this.state = state;
        this.emit("state:change", state);
    }
    emit(event, ...args) {
        this.eventEmitter.emit(event, ...args);
    }
    generateId() {
        return `compact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }
}
//# sourceMappingURL=ContextManager.js.map