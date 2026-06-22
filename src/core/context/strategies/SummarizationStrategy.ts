import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
} from "../CompactionStrategy.js";
import { Message } from "../../conversation.js";

export class SummarizationStrategy implements CompactionStrategy {
  name = "summarization";

  canHandle(context: CompactionContext): boolean {
    return context.messages.length > 10;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const preserveRecent = options.preserveRecent || 20;

    const toSummarize = messages.slice(0, -preserveRecent);
    const toKeep = messages.slice(-preserveRecent);

    // Placeholder summary - actual LLM summarization injected by ContextManager
    const summary = `[Summary of ${toSummarize.length} messages]: Context preserved`;

    const summaryMessage: Message = {
      role: "user",
      content: `[System Conversation Summary]:\n${summary}`,
      timestamp: Date.now(),
    };

    const result = [summaryMessage, ...toKeep];

    return {
      messages: result,
      metadata: {
        strategy: "summarization",
        messagesBefore: messages.length,
        messagesAfter: result.length,
        summary,
      },
    };
  }

  estimateCost(messages: Message[]): CompactionCost {
    const inputTokens = messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0
    );
    const outputTokens = 500;

    return {
      tokens: inputTokens + outputTokens,
      time: 2000,
      apiCalls: 1,
    };
  }
}
