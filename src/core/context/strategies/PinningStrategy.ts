import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
} from "../CompactionStrategy.js";
import { Message } from "../../conversation.js";

export class PinningStrategy implements CompactionStrategy {
  name = "pinning";

  canHandle(context: CompactionContext): boolean {
    return context.hasPinnedMessages && context.pinnedMessageIds !== undefined;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const pinnedIds = options.pinnedMessageIds || new Set<string>();
    const preserveRecent = options.preserveRecent || 20;

    const pinned: Array<{ index: number; msg: Message }> = [];
    const unpinned: Message[] = [];

    // Use index-based ID format: "${index}:${role}:${timestamp}"
    // This matches the format used by pinCommand when pinning messages
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const id = `${i}:${msg.role}:${msg.timestamp}`;
      if (pinnedIds.has(id)) {
        pinned.push({ index: i, msg });
      } else {
        unpinned.push(msg);
      }
    }

    let keepIndex = Math.max(0, unpinned.length - preserveRecent);
    while (keepIndex < unpinned.length && unpinned[keepIndex]?.role === "tool") {
      keepIndex++;
    }
    const toSummarize = unpinned.slice(0, keepIndex);
    const toKeep = unpinned.slice(keepIndex);

    const summary = `[Summary of ${toSummarize.length} unpinned messages]: Context preserved`;

    const summaryMessage: Message = {
      role: "user",
      content: `[System Conversation Summary]:\n${summary}`,
      timestamp: Date.now(),
    };

    // Reconstruct: summary first, then pinned messages in original order, then recent unpinned
    const result: Message[] = [summaryMessage];

    // Insert pinned messages in their original order
    for (const p of pinned) {
      result.push(p.msg);
    }

    // Add recent unpinned messages
    result.push(...toKeep);

    return {
      messages: result,
      metadata: {
        strategy: "pinning",
        messagesBefore: messages.length,
        messagesAfter: result.length,
        pinnedCount: pinned.length,
        summary,
      },
    };
  }

  estimateCost(messages: Message[]): CompactionCost {
    const inputTokens = messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0
    );
    return {
      tokens: inputTokens + 500,
      time: 2000,
      apiCalls: 1,
    };
  }
}
