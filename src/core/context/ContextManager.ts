import { EventEmitter } from "events";
import { Message, contentToString } from "../conversation.js";
import { TokenTracker, TokenBreakdown } from "./TokenTracker.js";
import {
  CompactionStrategy,
  CompactionResult,
  CompactionContext,
  CompactionOptions,
} from "./CompactionStrategy.js";
import { SummarizationStrategy } from "./strategies/SummarizationStrategy.js";
import { PruningStrategy } from "./strategies/PruningStrategy.js";
import { PinningStrategy } from "./strategies/PinningStrategy.js";
import { RMemoryStrategy } from "./strategies/RMemoryStrategy.js";
import { SemanticAnalyzer } from "./SemanticAnalyzer.js";
import { CompactionHistory } from "./CompactionHistory.js";

export type ContextState =
  | "IDLE"
  | "CHECKING"
  | "COMPACTING"
  | "VALIDATING"
  | "FAILED"
  | "RECOVERING";

export interface ContextManagerConfig {
  model: string;
  contextWindowLimit: number;
  historyFilePath?: string;
  llmModel?: any;
  abortSignal?: AbortSignal;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: string;
  urgency?: "normal" | "critical";
  recommendedStrategy?: CompactionStrategy;
}

/** Metadata about the agent that created/pinned the message */
export interface AgentTag {
  tier: string;              // "master" | "superagent" | "subagent" | "single"
  subagentType?: string;     // e.g. "researcher", "coder"
  worktreePath?: string;     // git worktree path for superagents
  workingDirectory?: string; // effective CWD
  sessionLabel?: string;     // human-readable label like "Superagent #3"
}

/** Full pinned message data — stores real content without truncation */
export interface PinnedMessage {
  id: string;                // message ID: "${index}:${role}:${timestamp}"
  role: string;              // "user" | "assistant" | "system" | "tool"
  content: string;           // full, untruncated content
  timestamp: number;         // original message timestamp
  pinnedAt: number;          // when the message was pinned
  originalIndex: number;     // original index in conversation
  agentTag?: AgentTag;       // which agent produced this message
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  toolResults?: Array<{ toolCallId: string; name: string; result: string; isError?: boolean }>;
  tag?: string;              // optional user-defined tag/label
}

export class ContextManager {
  private state: ContextState = "IDLE";
  private tokenTracker: TokenTracker;
  private strategies: CompactionStrategy[];
  private semanticAnalyzer: SemanticAnalyzer;
  private history: CompactionHistory;
  private eventEmitter: EventEmitter;
  private config: ContextManagerConfig;
  private pinnedMessages: Map<string, PinnedMessage> = new Map();

  constructor(config: ContextManagerConfig) {
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
      new RMemoryStrategy({ historyFilePath: config.historyFilePath }),
      summarizationStrategy,
      new PruningStrategy(),
    ];
  }

  setLLMModel(model: any, abortSignal?: AbortSignal): void {
    const summarizationStrategy = this.strategies.find(
      (s) => s.name === "summarization"
    ) as SummarizationStrategy;
    if (summarizationStrategy) {
      summarizationStrategy.setConfig({ model, abortSignal });
    }
  }

  shouldCompact(messages: Message[]): CompactionDecision {
    const breakdown = this.tokenTracker.estimateTokensForAll(messages);
    const totalTokens = breakdown.total;
    const threshold = this.calculateThreshold();

    if (totalTokens < threshold * 0.8) {
      return { shouldCompact: false, reason: "below-threshold" };
    }

    if (totalTokens >= threshold) {
      const urgency: "normal" | "critical" =
        totalTokens > threshold * 1.2 ? "critical" : "normal";

      return {
        shouldCompact: true,
        reason: `threshold-exceeded (${totalTokens} >= ${threshold})`,
        urgency,
        recommendedStrategy: this.selectStrategy(messages),
      };
    }

    return { shouldCompact: false, reason: "approaching-threshold" };
  }

  /**
   * Scan messages and automatically pin those containing critical planning metadata
   */
  public autoPinKeyMessages(messages: Message[]): void {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = contentToString(msg.content);

      // Pin the initial user request, task checklists, and implementation plans
      if (
        (msg.role === "user" && i === 0) || // First user request
        content.includes("# Implementation Plan") ||
        content.includes("task.md") ||
        content.includes("implementation_plan.md") ||
        content.includes("[System Conversation Summary]")
      ) {
        const contentPrefix = content.slice(0, 64);
        const stableId = `${msg.role}:${msg.timestamp}:${contentPrefix}`;
        
        // Add to pinned messages if not already pinned
        if (!this.pinnedMessages.has(stableId)) {
          this.addPinnedMessage(stableId, {
            role: msg.role,
            content: content,
            timestamp: msg.timestamp,
            pinnedAt: Date.now(),
            originalIndex: i,
            tag: "auto-plan"
          });
        }
      }
    }
  }

  async compact(
    messages: Message[],
    strategy?: CompactionStrategy,
    abortSignal?: AbortSignal,
    options?: Partial<CompactionOptions>
  ): Promise<CompactionResult> {
    this.setState("CHECKING");
    this.autoPinKeyMessages(messages);

    try {
      const selectedStrategy = strategy || this.selectStrategy(messages);

      const context = this.buildCompactionContext(messages);
      if (!selectedStrategy.canHandle(context)) {
        throw new Error(
          `Strategy ${selectedStrategy.name} cannot handle current context`
        );
      }

      this.setState("COMPACTING");
      this.emit("compaction:start", { strategy: selectedStrategy.name });

      const result = await selectedStrategy.execute(messages, {
        tokenBudget: options?.tokenBudget ?? this.calculateThreshold(),
        pinnedMessageIds: options?.pinnedMessageIds ?? new Set(this.pinnedMessages.keys()),
        byteBudget: options?.byteBudget,
        preserveRecent: options?.preserveRecent,
        abortSignal: options?.abortSignal ?? abortSignal,
        modelName: options?.modelName ?? this.config.model,
      });

      this.setState("VALIDATING");
      this.validateResult(result);

      const tokensBefore = this.tokenTracker.estimateTokensForAll(messages).total;
      const tokensAfter = this.tokenTracker.estimateTokensForAll(
        result.messages
      ).total;

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
    } catch (error) {
      this.setState("FAILED");
      this.emit("compaction:fail", error);

      return this.recover(messages, error as Error);
    } finally {
      this.setState("IDLE");
    }
  }

  getState(): ContextState {
    return this.state;
  }

  on(
    event: "compaction:start" | "compaction:complete" | "compaction:fail",
    handler: (...args: any[]) => void
  ): void {
    this.eventEmitter.on(event, handler);
  }

  off(
    event: "compaction:start" | "compaction:complete" | "compaction:fail",
    handler: (...args: any[]) => void
  ): void {
    this.eventEmitter.off(event, handler);
  }

  setThreshold(threshold: number | "auto"): void {
    if (threshold !== "auto") {
      this.config.contextWindowLimit = threshold;
    }
  }

  setModel(model: string): void {
    this.config.model = model;
    this.tokenTracker.setModel(model);
  }

  addPinnedMessage(messageId: string, data?: Partial<PinnedMessage>): void {
    if (data) {
      // Store full pinned message data
      const pinned: PinnedMessage = {
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
    } else {
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

  removePinnedMessage(messageId: string): void {
    this.pinnedMessages.delete(messageId);
  }

  /** Backward-compatible: returns just the set of pinned message IDs */
  getPinnedMessages(): Set<string> {
    return new Set(this.pinnedMessages.keys());
  }

  /** Returns full pinned message data as a Map */
  getPinnedMessagesFull(): Map<string, PinnedMessage> {
    return new Map(this.pinnedMessages);
  }

  /** Get a single pinned message by ID */
  getPinnedMessage(messageId: string): PinnedMessage | undefined {
    return this.pinnedMessages.get(messageId);
  }

  /** Update tag/label on a pinned message */
  setPinnedMessageTag(messageId: string, tag: string): boolean {
    const pinned = this.pinnedMessages.get(messageId);
    if (!pinned) return false;
    pinned.tag = tag;
    return true;
  }

  /** Restore pinned messages from serialized data (for session restore) */
  restorePinnedMessages(data: PinnedMessage[]): void {
    this.pinnedMessages.clear();
    for (const item of data) {
      this.pinnedMessages.set(item.id, item);
    }
  }

  /** Serialize pinned messages for persistence */
  serializePinnedMessages(): PinnedMessage[] {
    return Array.from(this.pinnedMessages.values());
  }

  getHistory() {
    return this.history.getHistory();
  }

  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  getSemanticAnalyzer(): SemanticAnalyzer {
    return this.semanticAnalyzer;
  }

  estimateTokensForAll(messages: Message[]): TokenBreakdown {
    return this.tokenTracker.estimateTokensForAll(messages);
  }

  estimateTokens(message: Message): number {
    return this.tokenTracker.estimateTokens(message);
  }

  private calculateThreshold(): number {
    const modelLimit = this.config.contextWindowLimit;
    const isAnthropic = this.config.model.includes("claude");
    // Dynamic buffer: 5% of model limit, capped within safe ranges
    const responseBuffer = Math.max(4000, Math.min(8000, Math.floor(modelLimit * 0.05)));
    const toolCallBuffer = Math.max(5000, Math.min(10000, Math.floor(modelLimit * 0.05)));
    const threshold = modelLimit - responseBuffer - toolCallBuffer;
    // For large models (e.g. Claude 200k), cap at 85% of limit, otherwise 75%
    const capRatio = isAnthropic || modelLimit >= 100000 ? 0.85 : 0.75;
    return Math.min(threshold, Math.floor(modelLimit * capRatio));
  }

  private selectStrategy(messages: Message[]): CompactionStrategy {
    const context = this.buildCompactionContext(messages);

    for (const strategy of this.strategies) {
      if (strategy.canHandle(context)) {
        return strategy;
      }
    }

    return this.strategies[this.strategies.length - 1];
  }

  private buildCompactionContext(messages: Message[]): CompactionContext {
    return {
      messages,
      tokenBudget: this.calculateThreshold(),
      hasPinnedMessages: this.pinnedMessages.size > 0,
      pinnedMessageIds: new Set(this.pinnedMessages.keys()),
    };
  }

  private validateResult(result: CompactionResult): void {
    if (!result.messages || result.messages.length === 0) {
      throw new Error("Compaction result has no messages");
    }

    if (!result.metadata || !result.metadata.strategy) {
      throw new Error("Compaction result missing metadata");
    }
  }

  private async recover(
    messages: Message[],
    error: Error
  ): Promise<CompactionResult> {
    this.setState("RECOVERING");
    console.error("Compaction failed, attempting recovery:", error.message);

    try {
      const pruningStrategy = new PruningStrategy();
      return await pruningStrategy.execute(messages, {
        preserveRecent: 20,
      });
    } catch (recoveryError) {
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

  private setState(state: ContextState): void {
    this.state = state;
    this.emit("state:change", state);
  }

  private emit(event: string, ...args: any[]): void {
    this.eventEmitter.emit(event, ...args);
  }

  private generateId(): string {
    return `compact-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  public dispose(): void {
    this.eventEmitter.removeAllListeners();
    this.pinnedMessages.clear();
  }
}
