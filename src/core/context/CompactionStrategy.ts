import { Message } from "../conversation.js";
import { TokenTracker } from "./TokenTracker.js";

export interface CompactionContext {
  messages: Message[];
  tokenBudget: number;
  hasPinnedMessages: boolean;
  pinnedMessageIds?: Set<string>;
}

export interface CompactionCost {
  tokens: number;
  time: number;
  apiCalls: number;
}

export interface CompactionResult {
  messages: Message[];
  metadata: {
    strategy: string;
    tokensSaved?: number;
    messagesBefore?: number;
    messagesAfter?: number;
    summary?: string;
    [key: string]: any;
  };
}

export interface CompactionOptions {
  tokenBudget?: number;
  preserveRecent?: number;
  customPrompt?: string;
  pinnedMessageIds?: Set<string>;
  byteBudget?: number;
  /** Pass AbortSignal so long-running strategies (e.g. LLM summarization) can be cancelled. */
  abortSignal?: AbortSignal;
  modelName?: string;
  useVisionTokenSaving?: boolean;
  visionThreshold?: number;
}

export interface CompactionStrategy {
  name: string;
  canHandle(context: CompactionContext): boolean;
  execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
  estimateCost(messages: Message[]): CompactionCost;
}

/**
 * Lightweight token estimation for compaction budget enforcement.
 * Uses heuristic (text.length/4) — doesn't need tiktoken accuracy,
 * just needs to prevent unbounded growth within compaction strategies.
 */
export function tokensForMessages(messages: Message[]): number {
  let total = 0;
  for (const m of messages) {
    const text = typeof m.content === "string"
      ? m.content
      : (m.content as any[])?.map((p: any) => p.text || "").join("") || "";
    total += Math.ceil(text.length / 4);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += Math.ceil(JSON.stringify(tc.args).length / 4);
      }
    }
    if (m.toolResults) {
      for (const tr of m.toolResults) {
        total += Math.ceil(tr.result.length / 4);
      }
    }
  }
  return total;
}

// Keep static cache map to reuse TokenTracker instances across calls and avoid hot-path re-instantiation overhead.
const trackerCache = new Map<string, TokenTracker>();

/**
 * Cached token estimator backed by TokenTracker LRU cache.
 * Use in budget loops instead of the O(n) heuristic `tokensForMessages`.
 */
export function estimateTokensCached(
  messages: Message[],
  modelName: string
): number {
  let tracker = trackerCache.get(modelName);
  if (!tracker) {
    tracker = new TokenTracker(modelName);
    trackerCache.set(modelName, tracker);
  }
  let total = 0;
  for (const m of messages) {
    total += tracker.estimateTokens(m);
  }
  return total;
}
