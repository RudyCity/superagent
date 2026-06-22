import { EventEmitter } from "events";
import { Message } from "../conversation.js";
import { TokenTracker, TokenBreakdown } from "./TokenTracker.js";
import {
  CompactionStrategy,
  CompactionResult,
  CompactionContext,
} from "./CompactionStrategy.js";
import { SummarizationStrategy } from "./strategies/SummarizationStrategy.js";
import { PruningStrategy } from "./strategies/PruningStrategy.js";
import { PinningStrategy } from "./strategies/PinningStrategy.js";
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
}

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: string;
  urgency?: "normal" | "critical";
  recommendedStrategy?: CompactionStrategy;
}

export class ContextManager {
  private state: ContextState = "IDLE";
  private tokenTracker: TokenTracker;
  private strategies: CompactionStrategy[];
  private semanticAnalyzer: SemanticAnalyzer;
  private history: CompactionHistory;
  private eventEmitter: EventEmitter;
  private config: ContextManagerConfig;
  private pinnedMessages: Set<string> = new Set();

  constructor(config: ContextManagerConfig) {
    this.config = config;
    this.tokenTracker = new TokenTracker(config.model);
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.history = new CompactionHistory(config.historyFilePath);
    this.eventEmitter = new EventEmitter();

    this.strategies = [
      new PinningStrategy(),
      new SummarizationStrategy(),
      new PruningStrategy(),
    ];
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

  async compact(
    messages: Message[],
    strategy?: CompactionStrategy
  ): Promise<CompactionResult> {
    this.setState("CHECKING");

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
        tokenBudget: this.calculateThreshold(),
        pinnedMessageIds: this.pinnedMessages,
      });

      this.setState("VALIDATING");
      this.validateResult(result);

      const tokensBefore = this.tokenTracker.estimateTokensForAll(messages).total;
      const tokensAfter = this.tokenTracker.estimateTokensForAll(
        result.messages
      ).total;

      this.history.record({
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

  addPinnedMessage(messageId: string): void {
    this.pinnedMessages.add(messageId);
  }

  removePinnedMessage(messageId: string): void {
    this.pinnedMessages.delete(messageId);
  }

  getPinnedMessages(): Set<string> {
    return new Set(this.pinnedMessages);
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

  private calculateThreshold(): number {
    const modelLimit = this.config.contextWindowLimit;
    const responseBuffer = 8000;
    const toolCallBuffer = 10000;
    const threshold = modelLimit - responseBuffer - toolCallBuffer;
    return Math.min(threshold, modelLimit * 0.7);
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
      pinnedMessageIds: this.pinnedMessages,
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
}
