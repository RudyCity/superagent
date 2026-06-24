import { Message } from "../conversation";

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
  /** Pass AbortSignal so long-running strategies (e.g. LLM summarization) can be cancelled. */
  abortSignal?: AbortSignal;
}

export interface CompactionStrategy {
  name: string;
  canHandle(context: CompactionContext): boolean;
  execute(messages: Message[], options: CompactionOptions): Promise<CompactionResult>;
  estimateCost(messages: Message[]): CompactionCost;
}
