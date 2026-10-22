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
import { BudgetedPruningStrategy } from "./strategies/BudgetedPruningStrategy.js";
import { SemanticAnalyzer } from "./SemanticAnalyzer.js";
import { CompactionHistory } from "./CompactionHistory.js";
import { getSettings } from "../config/jsonConfig.js";
import { isCompactionSummaryText } from "./CompactionStrategy.js";
import { ContextContinuityStore, validateCompaction, preserveContextFacts } from "./ContextContinuity.js";

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
  /** Canonical project identity used by all context-compaction memory reads/writes. */
  projectId?: string;
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
  private budgetedPruningStrategy: BudgetedPruningStrategy;
  private config: ContextManagerConfig;
  private pinnedMessages: Map<string, PinnedMessage> = new Map();
  private readonly continuity: ContextContinuityStore;
  private lastQualityScore = 100;

  constructor(config: ContextManagerConfig) {
    this.config = config;
    this.continuity = new ContextContinuityStore(config.historyFilePath);
    this.tokenTracker = new TokenTracker(config.model);
    this.semanticAnalyzer = new SemanticAnalyzer();
    this.history = new CompactionHistory();
    this.eventEmitter = new EventEmitter();

    const summarizationStrategy = new SummarizationStrategy({
      model: config.llmModel,
      abortSignal: config.abortSignal,
    });

    const pinningStrategy = new PinningStrategy({
      model: config.llmModel,
      abortSignal: config.abortSignal,
    });

    this.strategies = [
      pinningStrategy,
      new RMemoryStrategy({
        model: config.llmModel,
        abortSignal: config.abortSignal,
        projectId: config.projectId,
        historyFilePath: config.historyFilePath,
      }),
      summarizationStrategy,
      new PruningStrategy(),
    ];

    // Pre-emptive budgeted pruning (GraphSentry): prunes lowest-importance
    // messages within a token budget before the compaction threshold is hit.
    this.budgetedPruningStrategy = new BudgetedPruningStrategy({
      contextWindowLimit: config.contextWindowLimit,
    });
  }

  getContinuity(): ContextContinuityStore { return this.continuity; }
  getQualityScore(): number { return this.lastQualityScore; }
  getAdaptiveThreshold(): number { return this.calculateThreshold(); }

  setLLMModel(model: any, abortSignal?: AbortSignal): void {
    for (const s of this.strategies) {
      if (s.name === "summarization" && typeof (s as any).setConfig === "function") {
        (s as SummarizationStrategy).setConfig({ model, abortSignal });
      }
      if (s.name === "pinning" && typeof (s as any).setConfig === "function") {
        (s as any).setConfig({ model, abortSignal });
      }
      if (s.name === "rmemory" && typeof (s as any).setConfig === "function") {
        (s as any).setConfig({ model, abortSignal });
      }
    }
  }

  shouldCompact(messages: Message[]): CompactionDecision {
    const breakdown = this.tokenTracker.estimateTokensForAll(messages);
    const totalTokens = breakdown.total;
    const toolHeavy = messages.some((m) => m.toolResults?.some((t) => t.result.length > 16000));
    const threshold = Math.floor(this.calculateThreshold() * (toolHeavy ? 0.85 : 1));

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
    // A previous turn's active request is no longer the active request.
    // Keep explicit pins and enduring plans; rotate only automatic current pins.
    for (const [id, pinnedMsg] of this.pinnedMessages.entries()) {
      if (isCompactionSummaryText(pinnedMsg.content) || pinnedMsg.tag === "auto-current") {
        this.pinnedMessages.delete(id);
      }
    }
    let activeUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const body = contentToString(msg.content);
      if (msg.role === "user" && !isCompactionSummaryText(body) &&
          !body.startsWith("[RMemory Agent Memory Context]")) {
        activeUserIndex = i;
        break;
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = contentToString(msg.content);

      // Pin the initial user request, task checklists, and implementation plans
      // (Do NOT pin conversation summaries, tool results, or casual references)
      const isInitialUserMsg = msg.role === "user" && i === 0 && !isCompactionSummaryText(content);
      const isPlanOrTaskDoc =
        (msg.role === "user" || msg.role === "system") &&
        (content.startsWith("# Implementation Plan") ||
          content.startsWith("# Plan") ||
          content.startsWith("# Tasks") ||
          content.includes("\n# Implementation Plan") ||
          content.includes("\n# Tasks"));

      if (isInitialUserMsg || isPlanOrTaskDoc || i === activeUserIndex) {
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
            tag: i === activeUserIndex && !isInitialUserMsg && !isPlanOrTaskDoc ? "auto-current" : "auto-plan"
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
    if (abortSignal?.aborted) {
      const error = new Error("Compaction cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (this.state !== "IDLE") {
      const error = new Error("Compaction already in progress");
      error.name = "CompactionBusyError";
      throw error;
    }
    const startedAt = Date.now();
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

      const isBudgetedPruning =
        selectedStrategy === this.budgetedPruningStrategy ||
        selectedStrategy.name === "budgeted-pruning";
      const defaultBudget = isBudgetedPruning
        ? Math.floor(this.calculateThreshold() * 0.6)
        : this.calculateThreshold();

      const result = await selectedStrategy.execute(messages, {
        tokenBudget: options?.tokenBudget ?? defaultBudget,
        pinnedMessageIds: options?.pinnedMessageIds ?? new Set(this.pinnedMessages.keys()),
        byteBudget: options?.byteBudget,
        preserveRecent: options?.preserveRecent,
        abortSignal: options?.abortSignal ?? abortSignal,
        modelName: options?.modelName ?? this.config.model,
      });
      if (abortSignal?.aborted) {
        const error = new Error("Compaction cancelled");
        error.name = "AbortError";
        throw error;
      }

      this.setState("VALIDATING");
      this.validateResult(result);
      result.messages = preserveContextFacts(messages, result.messages);
      // Feed the same verified context forward to workspace/session summarization.
      const annotated = result.messages.find((m) => isCompactionSummaryText(contentToString(m.content)));
      if (annotated) result.metadata.summary = contentToString(annotated.content).slice(0, 8000);
      const quality = validateCompaction(messages, result.messages);
      this.lastQualityScore = quality.score;
      if (!quality.passed) throw new Error("Compaction quality gate failed: " + quality.missing.join(", "));
      result.metadata.quality = quality;
      result.metadata.checkpoint = this.continuity.preview(messages).checkpoint;

      const tokensBefore = this.tokenTracker.estimateTokensForAll(messages).total;
      const tokensAfter = this.tokenTracker.estimateTokensForAll(
        result.messages
      ).total;

      const snapshot = this.continuity.capture(messages, tokensBefore);
      result.metadata.snapshotId = snapshot.messages.length ? snapshot.id : undefined;
      result.metadata.pendingPersistence = {
        event: {
          id: this.generateId(),
          timestamp: Date.now(),
          strategy: selectedStrategy.name,
          messagesBefore: messages.length,
          messagesAfter: result.messages.length,
          tokensBefore,
          tokensAfter,
          summary: result.metadata.summary,
          reason: "threshold",
        },
        durationMs: Date.now() - startedAt,
        quality: quality.score,
        fallback: !!result.metadata.usedFallback,
      };
      // The caller must persist the new transcript before confirming this event.
      this.setState("IDLE");
      return result;
    } catch (error) {
      this.setState("FAILED");
      this.continuity.failure();
      this.emit("compaction:fail", error);
      // Cancellation is an explicit user action, not a compaction failure:
      // never overwrite the conversation via a recovery strategy after abort.
      if (abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
      if ((error instanceof Error && error.name === "CompactionBusyError")) throw error;
      const recovered = await this.recover(messages, error as Error);
      recovered.messages = preserveContextFacts(messages, recovered.messages);
      const quality = validateCompaction(messages, recovered.messages);
      if (!quality.passed) throw new Error("Recovery quality gate failed: " + quality.missing.join(", "));
      recovered.metadata.quality = quality;
      this.lastQualityScore = quality.score;
      const snapshot = this.continuity.capture(messages, this.estimateTokensForAll(messages).total);
      recovered.metadata.snapshotId = snapshot.messages.length ? snapshot.id : undefined;
      recovered.metadata.pendingPersistence = {
        event: {
          id: this.generateId(), timestamp: Date.now(), strategy: recovered.metadata.strategy,
          messagesBefore: messages.length, messagesAfter: recovered.messages.length,
          tokensBefore: this.estimateTokensForAll(messages).total,
          tokensAfter: this.estimateTokensForAll(recovered.messages).total,
          summary: recovered.metadata.summary, reason: "emergency",
        },
        durationMs: Date.now() - startedAt, quality: quality.score, fallback: true,
      };
      return recovered;
    } finally {
      this.setState("IDLE");
    }
  }

  /** A result is only successful after the caller has durably saved the session. */
  async confirmPersistedCompaction(result: CompactionResult): Promise<void> {
    const pending = result.metadata.pendingPersistence;
    if (!pending) return;
    delete result.metadata.pendingPersistence;
    await this.history.record(pending.event);
    const { event } = pending;
    this.continuity.record(event.strategy, pending.durationMs,
      event.tokensBefore, event.tokensAfter, pending.quality, pending.fallback);
    this.emit("compaction:complete", {
      strategy: event.strategy, tokensBefore: event.tokensBefore,
      tokensAfter: event.tokensAfter, messagesBefore: event.messagesBefore,
      messagesAfter: event.messagesAfter, metadata: result.metadata,
    });
    if (event.summary) {
      import("../workspaceSummary.js")
        .then(({ saveWorkspaceSummary }) => saveWorkspaceSummary({ summary: event.summary }))
        .catch(() => {});
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
      // Keep budgeted pruning's derived budget in sync with live limit
      if (this.budgetedPruningStrategy && typeof (this.budgetedPruningStrategy as any).setContextWindowLimit === "function") {
        (this.budgetedPruningStrategy as any).setContextWindowLimit(threshold);
      } else if (this.budgetedPruningStrategy) {
        (this.budgetedPruningStrategy as any).contextWindowLimit = threshold;
      }
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
    const modelLimit = this.config.contextWindowLimit || 128000;
    const isAnthropic = this.config.model.includes("claude");

    // Dynamic buffer: allocate at most 35% of modelLimit to buffers so threshold is always positive.
    const maxBufferTotal = Math.floor(modelLimit * 0.35);
    const desiredResponseBuffer = Math.min(8000, Math.max(1000, Math.floor(modelLimit * 0.05)));
    const desiredToolCallBuffer = Math.min(10000, Math.max(1500, Math.floor(modelLimit * 0.05)));

    let responseBuffer = desiredResponseBuffer;
    let toolCallBuffer = desiredToolCallBuffer;
    if (responseBuffer + toolCallBuffer > maxBufferTotal) {
      const scale = maxBufferTotal / (responseBuffer + toolCallBuffer);
      responseBuffer = Math.floor(responseBuffer * scale);
      toolCallBuffer = Math.floor(toolCallBuffer * scale);
    }

    const threshold = modelLimit - responseBuffer - toolCallBuffer;
    // For large models (e.g. Claude 200k), cap at 80% of limit, otherwise 70%
    const capRatio = isAnthropic || modelLimit >= 100000 ? 0.80 : 0.70;
    const safeMin = Math.max(1000, Math.floor(modelLimit * 0.50));
    const calculated = Math.max(safeMin, Math.min(threshold, Math.floor(modelLimit * capRatio)));

    // Memory ceiling safeguard:
    // Models with massive context windows (e.g. 1M+ tokens like Minimax M3 or Gemini 1.5)
    // would otherwise postpone compaction until ~840K tokens, causing Node.js to hold
    // hundreds of thousands of tokens and huge tool results in V8 heap memory until OOM crash.
    // We enforce an in-memory safety ceiling (128,000 tokens) unless explicitly overridden.
    let customLimit = 0;
    try {
      customLimit = getSettings().contextWindowLimit;
    } catch {}
    const maxInMemoryWorkingLimit = customLimit > 0 ? customLimit : 128000;
    // Tool-heavy sessions have disproportionately large JSON payloads; compact
    // earlier to retain a useful response/payload reserve without model retries.
    const reserve = this.continuity.getMetrics().latest?.fallback ? 0.9 : 1;
    return Math.max(1000, Math.floor(Math.min(calculated, maxInMemoryWorkingLimit) * reserve));
  }

  private selectStrategy(messages: Message[]): CompactionStrategy {
    const context = this.buildCompactionContext(messages);

    // Pre-emptive band: only trigger budgeted pruning very close to the threshold
    // (0.85–1.0) to avoid premature heuristic pruning when AI summarization
    // ("smart compact") would be preferred. Normal threshold-exceeded path
    // (>= threshold) goes to pinning/summarization with AI, not pruning.
    const totalTokens = this.tokenTracker.estimateTokensForAll(messages).total;
    const threshold = this.calculateThreshold();
    if (totalTokens > threshold * 0.85 && totalTokens < threshold) {
      return this.budgetedPruningStrategy;
    }

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
    const prevState = this.state;
    this.state = state;
    this.emit("state:change", { from: prevState, to: state });
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
