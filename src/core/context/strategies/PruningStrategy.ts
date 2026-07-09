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

    // Enforce byte budget: reduce preserved messages/truncate contents if they exceed byte budget
    const byteBudget = options.byteBudget || 0;
    if (byteBudget > 0) {
      let useVisionTokenSaving = options.useVisionTokenSaving;
      let visionThreshold = options.visionThreshold ?? 3000;

      if (useVisionTokenSaving === undefined) {
        try {
          const { getSettings, getDynamicVisionThreshold } = await import("../../config.js");
          const modelName = options.modelName || "";
          if (modelName && (byteBudget === 0 || byteBudget >= 500 * 1024)) {
            const settings = getSettings();
            const name = modelName.toLowerCase();
            const supportsVision = name.includes("claude-3") || name.includes("gpt-4o") || name.includes("gpt-4-vision") || name.includes("gemini") || name.includes("gemma-3") || name.includes("vision");
            useVisionTokenSaving = supportsVision && (settings.autoVisionTokenSaving ?? true);
            visionThreshold = getDynamicVisionThreshold(modelName);
          } else {
            useVisionTokenSaving = false;
          }
        } catch {
          useVisionTokenSaving = false; // default to false on config failure/unit tests
          visionThreshold = 3000;
        }
      }


      let currentBytes = toKeep.reduce((sum, msg) => sum + estimateMessagePayloadBytes(msg, useVisionTokenSaving!, visionThreshold), 0);

      // First, truncate very large fields within toKeep message objects to avoid throwing away everything.
      if (currentBytes > byteBudget) {
        for (const msg of toKeep) {
          if (typeof msg.content === "string" && msg.content.length > 50000) {
            msg.content = msg.content.slice(0, 50000) + "\n\n[... TRUNCATED DUE TO PAYLOAD SIZE LIMITS ...]";
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text && part.text.length > 50000) {
                part.text = part.text.slice(0, 50000) + "\n\n[... TRUNCATED DUE TO PAYLOAD SIZE LIMITS ...]";
              }
            }
          }
          if (msg.toolResults) {
            for (const tr of msg.toolResults) {
              if (typeof tr.result === "string" && tr.result.length > 50000) {
                tr.result = tr.result.slice(0, 50000) + "\n\n[... TRUNCATED DUE TO PAYLOAD SIZE LIMITS ...]";
              }
            }
          }
        }
        currentBytes = toKeep.reduce((sum, msg) => sum + estimateMessagePayloadBytes(msg, useVisionTokenSaving!, visionThreshold), 0);
      }

      // If still exceeding, prune older messages
      while (currentBytes > byteBudget && toKeep.length > 0) {
        const moved = toKeep.shift()!;
        toPrune.push(moved);
        currentBytes = toKeep.reduce((sum, msg) => sum + estimateMessagePayloadBytes(msg, useVisionTokenSaving!, visionThreshold), 0);
      }
    }

    // Ensure that after all pruning, the kept messages slice does not start with a tool message
    while (toKeep.length > 0 && toKeep[0].role === "tool") {
      const moved = toKeep.shift()!;
      toPrune.push(moved);
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

function estimateMessagePayloadBytes(
  msg: Message,
  useVisionTokenSaving: boolean,
  visionThreshold: number
): number {
  let size = 0;
  const ESTIMATED_IMAGE_PAGE_BYTES = 150 * 1024; // 150 KB per page

  if (msg.role === "user") {
    const rawContent = typeof msg.content === "string" ? msg.content : contentToString(msg.content);
    const isMemoryContext = rawContent.startsWith("[TencentDB Agent Memory Context]:");
    if (useVisionTokenSaving && (rawContent.length > visionThreshold || isMemoryContext)) {
      const lines = rawContent.split(/\r?\n/).length;
      const pages = Math.min(3, Math.ceil(lines / 150));
      size += pages * ESTIMATED_IMAGE_PAGE_BYTES;
    } else {
      size += Buffer.byteLength(JSON.stringify(msg.content), "utf-8");
    }
  } else if (msg.role === "assistant") {
    size += Buffer.byteLength(JSON.stringify(msg.content), "utf-8");
    if (msg.toolCalls) {
      size += Buffer.byteLength(JSON.stringify(msg.toolCalls), "utf-8");
    }
  } else if (msg.role === "tool") {
    const results = msg.toolResults || [];
    for (const tr of results) {
      const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
      if (useVisionTokenSaving && resultStr.length > visionThreshold) {
        const lines = resultStr.split(/\r?\n/).length;
        const pages = Math.min(3, Math.ceil(lines / 150));
        size += pages * ESTIMATED_IMAGE_PAGE_BYTES;
      } else {
        size += Buffer.byteLength(JSON.stringify(tr), "utf-8");
      }
    }
  } else {
    size += Buffer.byteLength(JSON.stringify(msg), "utf-8");
  }
  return size;
}
