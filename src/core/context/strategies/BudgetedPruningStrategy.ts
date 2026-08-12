import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
  estimateTokensCached,
} from "../CompactionStrategy.js";
import { Message, contentToString } from "../../conversation.js";
import { SemanticAnalyzer } from "../SemanticAnalyzer.js";
import { TokenTracker } from "../TokenTracker.js";

/**
 * BudgetedPruningStrategy (GraphSentry, 2026)
 *
 * Proactively prunes the thought-DAG within a token budget BEFORE the
 * compaction threshold is hit, rather than only reacting after overflow.
 *
 * Behavior:
 * - Accepts a token budget (options.tokenBudget or a class field, default 0.6 * contextWindowLimit).
 * - Prunes oldest / lowest-importance messages first (SemanticAnalyzer.scoreImportance
 *   when available, else simple FIFO on non-pinned messages) until estimated tokens <= budget.
 * - Never prunes pinned messages (matched via stable content-based IDs, same scheme as PinningStrategy).
 * - Returns a CompactionResult with the pruned messages list and a summary.
 */
export class BudgetedPruningStrategy implements CompactionStrategy {
  name = "budgeted-pruning";

  /** Fraction of the context window limit used as the default budget when none is supplied. */
  private readonly defaultBudgetRatio = 0.6;

  /** Optional explicit budget override (tokens). Falls back to 0.6 * limit when 0. */
  private budgetOverride: number;

  /** Context window limit used to derive the default budget. */
  private contextWindowLimit: number;

  constructor(opts?: { budget?: number; contextWindowLimit?: number }) {
    this.budgetOverride = opts?.budget ?? 0;
    this.contextWindowLimit = opts?.contextWindowLimit ?? 0;
  }

  canHandle(_context: CompactionContext): boolean {
    // Pre-emptive strategy: always available; selection is gated by ContextManager.
    return true;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const pinnedIds = options.pinnedMessageIds || new Set<string>();
    const modelName = options.modelName || "";
    const tracker = new TokenTracker(modelName);

    // Resolve budget: explicit option > class override > 0.6 * context window limit.
    const budget =
      options.tokenBudget ||
      this.budgetOverride ||
      Math.floor(this.contextWindowLimit * this.defaultBudgetRatio) ||
      Math.floor((options.tokenBudget || 0));

    if (budget <= 0) {
      // No budget available — nothing to prune. Return messages unchanged.
      return {
        messages,
        metadata: {
          strategy: this.name,
          messagesBefore: messages.length,
          messagesAfter: messages.length,
          messagesPruned: 0,
          summary: "No token budget configured; no pruning performed.",
        },
      };
    }

    // Partition pinned vs unpinned using the same stable-ID scheme as PinningStrategy.
    const pinned: Message[] = [];
    const unpinned: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const contentPrefix = contentToString(msg.content).slice(0, 64);
      const stableId = `${msg.role}:${msg.timestamp}:${contentPrefix}`;
      const legacyId = `${i}:${msg.role}:${msg.timestamp}`;
      if (pinnedIds.has(stableId) || pinnedIds.has(legacyId)) {
        pinned.push(msg);
      } else {
        unpinned.push(msg);
      }
    }

    // Account for pinned tokens within the budget.
    const pinnedTokens = pinned.reduce(
      (sum, m) => sum + tracker.estimateTokens(m),
      0
    );
    const keepBudget = Math.max(0, budget - pinnedTokens);

    // Score unpinned messages by importance (lower score = prune first).
    const analyzer = new SemanticAnalyzer();
    const scored = unpinned.map((m, i) => ({
      msg: m,
      originalIndex: i,
      score: analyzer.scoreImportance(m),
    }));

    // Sort ascending by importance, then by original order (oldest first) as tiebreak.
    // This yields oldest/lowest-importance messages at the front of the prune queue.
    scored.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      return a.originalIndex - b.originalIndex;
    });

    // Greedily prune from the front until estimated tokens fit the budget.
    const toKeep: Message[] = [];
    const toPrune: Message[] = [];
    let runningTokens = 0;
    for (const item of scored) {
      const msgTokens = tracker.estimateTokens(item.msg);
      if (runningTokens + msgTokens <= keepBudget) {
        toKeep.push(item.msg);
        runningTokens += msgTokens;
      } else {
        toPrune.push(item.msg);
      }
    }

    // Preserve original conversation order: pinned messages keep their positions,
    // pruned messages are dropped, kept messages remain in their original sequence.
    const prunedSet = new Set(toPrune);
    const rawResult: Message[] = [];
    for (const msg of messages) {
      if (prunedSet.has(msg)) continue;
      rawResult.push(msg);
    }

    // Ensure pruning does not leave orphaned tool messages
    const result: Message[] = [];
    for (let i = 0; i < rawResult.length; i++) {
      const msg = rawResult[i];
      if (msg.role === "tool") {
        const prev = result[result.length - 1];
        if (!prev || prev.role !== "assistant" || !prev.toolCalls || prev.toolCalls.length === 0) {
          continue; // Drop orphaned tool message whose assistant call was pruned
        }
      }
      result.push(msg);
    }

    while (result.length > 0 && result[0].role === "tool") {
      result.shift();
    }

    const tokensBefore = estimateTokensCached(messages, modelName);
    const tokensAfter = estimateTokensCached(result, modelName);

    const summary = this.buildPruneSummary(toPrune, tokensBefore, tokensAfter);

    return {
      messages: result,
      metadata: {
        strategy: this.name,
        messagesBefore: messages.length,
        messagesAfter: result.length,
        messagesPruned: toPrune.length,
        pinnedCount: pinned.length,
        tokensBefore,
        tokensAfter,
        tokensSaved: Math.max(0, tokensBefore - tokensAfter),
        budget,
        summary,
      },
    };
  }

  estimateCost(messages: Message[]): CompactionCost {
    return {
      tokens: Math.ceil(
        messages.reduce((s, m) => s + contentToString(m.content).length / 4, 0)
      ),
      time: 50,
      apiCalls: 0,
    };
  }

  private buildPruneSummary(
    pruned: Message[],
    tokensBefore: number,
    tokensAfter: number
  ): string {
    if (pruned.length === 0) {
      return "Budgeted pruning ran: no messages required pruning (within budget).";
    }

    const filePaths = new Set<string>();
    const toolNames = new Set<string>();
    for (const m of pruned) {
      const text = contentToString(m.content);
      const fps =
        text.match(/(?:[\/\\]|\b)[\w.-]+(?:[\/\\])[\w.-]+(?:\.\w+)?/g) || [];
      fps.forEach((f) => filePaths.add(f));
      (m.toolCalls || []).forEach((tc) => toolNames.add(tc.name));
    }

    const parts: string[] = [
      `[Budgeted pruning removed ${pruned.length} lowest-importance messages to stay within token budget.]`,
      `Tokens: ${tokensBefore} -> ${tokensAfter} (saved ${Math.max(0, tokensBefore - tokensAfter)}).`,
    ];
    if (filePaths.size > 0)
      parts.push(`Files referenced: ${[...filePaths].slice(0, 8).join(", ")}.`);
    if (toolNames.size > 0)
      parts.push(`Tools used: ${[...toolNames].join(", ")}.`);

    return parts.join(" ");
  }
}
