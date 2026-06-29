import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
  tokensForMessages,
} from "../CompactionStrategy.js";
import { Message, contentToString } from "../../conversation.js";
import { SemanticAnalyzer } from "../SemanticAnalyzer.js";

export class PruningStrategy implements CompactionStrategy {
  name = "pruning";

  canHandle(_context: CompactionContext): boolean {
    return true;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const preserveRecent = options.preserveRecent || 20;
    const tokenBudget = options.tokenBudget || 0;

    let keepIndex = Math.max(0, messages.length - preserveRecent);
    while (keepIndex < messages.length && messages[keepIndex]?.role === "tool") {
      keepIndex++;
    }
    let toPrune = messages.slice(0, keepIndex);
    let toKeep = messages.slice(keepIndex);

    // Enforce token budget: reduce preserved messages if they exceed budget
    if (tokenBudget > 0) {
      const summaryOverhead = 500;
      const keepBudget = Math.floor(tokenBudget * 0.6) - summaryOverhead;
      let keepTokens = tokensForMessages(toKeep);
      while (keepTokens > keepBudget && toKeep.length > 0) {
        const moved = toKeep.shift()!;
        toPrune.push(moved);
        keepTokens = tokensForMessages(toKeep);
      }
    }

    const emergencySummary = this.createEmergencySummary(toPrune);

    const summaryMessage: Message = {
      role: "user",
      content: `[Emergency Summary - Context Pruned]:\n${emergencySummary}`,
      timestamp: Date.now(),
    };

    const result = [summaryMessage, ...toKeep];

    return {
      messages: result,
      metadata: {
        strategy: "pruning-with-emergency-summary",
        messagesBefore: messages.length,
        messagesAfter: result.length,
        messagesPruned: toPrune.length,
        summary: emergencySummary,
      },
    };
  }

  estimateCost(_messages: Message[]): CompactionCost {
    return {
      tokens: 0,
      time: 100,
      apiCalls: 0,
    };
  }

  private createEmergencySummary(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");

    const fileMatches = messages
      .flatMap((m) => contentToString(m.content).match(/[\w.-]+(?:\/|\\)[\w.-]+(?:\.\w+)?/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i)
      .slice(0, 10);

    const parts: string[] = [
      `Conversation had ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant).`,
    ];

    if (fileMatches.length > 0) {
      parts.push(`Files referenced: ${fileMatches.join(", ")}.`);
    }

    try {
      const analyzer = new SemanticAnalyzer();
      const keyPoints = analyzer.extractKeyPoints(messages);
      if (keyPoints.length > 0) {
        const kps = keyPoints.map(kp => `[${kp.type.toUpperCase()}] ${kp.content}`).slice(0, 5).join(" | ");
        parts.push(`Key semantic points: ${kps}.`);
      }
    } catch {
      // Ignored fallback
    }

    parts.push("Key topics discussed and actions taken were preserved in task files.");

    return parts.join(" ");
  }
}
