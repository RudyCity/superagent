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
    const byteBudget = options.byteBudget || 0;
    const tokenBudget = options.tokenBudget || 0;

    let actualPreserveRecent = preserveRecent;
    let maxContentLen = 50000;
    if (byteBudget > 0 && byteBudget <= 100 * 1024) {
      maxContentLen = Math.max(2000, Math.floor(byteBudget * 0.3));
      actualPreserveRecent = Math.max(2, Math.min(preserveRecent, Math.floor(byteBudget / (10 * 1024))));
    }

    let keepIndex = Math.max(0, messages.length - actualPreserveRecent);
    while (keepIndex < messages.length && messages[keepIndex]?.role === "tool") {
      keepIndex++;
    }
    let toPrune = messages.slice(0, keepIndex);
    let toKeep = messages.slice(keepIndex);

    // Importance-based pre-sort: when budget forces pruning, drop lowest-importance
    // older messages first instead of pure FIFO. Preserve recent + tool-result pairs.
    if (tokenBudget > 0 || byteBudget > 0) {
      const analyzer = new SemanticAnalyzer();
      const scored = toKeep.map((m, i) => ({ m, i, score: analyzer.scoreImportance(m) }));
      // Keep highest-score messages; only re-order the prunable tail (older half).
      const tailStart = Math.floor(scored.length / 2);
      const head = scored.slice(0, tailStart);
      const tail = scored.slice(tailStart).sort((a, b) => b.score - a.score);
      toKeep = [...head, ...tail].map((s) => s.m);
    }

    // Enforce token budget: reduce preserved messages if they exceed budget
    if (tokenBudget > 0) {
      const summaryOverhead = 500;
      const keepBudget = Math.floor(tokenBudget * 0.6) - summaryOverhead;
      const modelName = options.modelName || "";
      const tracker = new TokenTracker(modelName);
      let keepTokens = 0;
      for (const m of toKeep) keepTokens += tracker.estimateTokens(m);
      while (keepTokens > keepBudget && toKeep.length > 0) {
        const moved = toKeep.shift()!;
        toPrune.push(moved);
        keepTokens -= tracker.estimateTokens(moved);
      }
      // Ensure token-budget pruning does not leave an orphaned "tool" message at the start
      while (toKeep.length > 0 && toKeep[0].role === "tool") {
        const moved = toKeep.shift()!;
        toPrune.push(moved);
      }
    }

    // Enforce byte budget: reduce preserved messages/truncate contents if they exceed byte budget
    if (byteBudget > 0) {
      let useVisionTokenSaving = options.useVisionTokenSaving;
      let visionThreshold = options.visionThreshold ?? 3000;

      if (useVisionTokenSaving === undefined) {
        try {
          const modelName = options.modelName || "";
          if (modelName && (byteBudget === 0 || byteBudget >= 500 * 1024)) {
            const resolved = TokenTracker.resolveVisionSaving(modelName);
            useVisionTokenSaving = resolved.useVision;
            visionThreshold = resolved.threshold;
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
          if (typeof msg.content === "string" && msg.content.length > maxContentLen) {
            msg.content = msg.content.slice(0, maxContentLen) + "\n\n[... TRUNCATED DUE TO PAYLOAD SIZE LIMITS ...]";
          } else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === "text" && part.text && part.text.length > maxContentLen) {
                part.text = part.text.slice(0, maxContentLen) + "\n\n[... TRUNCATED DUE TO PAYLOAD SIZE LIMITS ...]";
              }
            }
          }
          if (msg.toolResults) {
            for (const tr of msg.toolResults) {
              if (typeof tr.result === "string" && tr.result.length > maxContentLen) {
                tr.result = tr.result.slice(0, maxContentLen) + "\n\n[... TRUNCATED DUE TO PAYLOAD SIZE LIMITS ...]";
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

    const fileMatches = messages
      .flatMap((m) => contentToString(m.content).match(/[\w.-]+(?:\/|\\)[\w.-]+(?:\.\w+)?/g) || [])
      .filter((v, i, a) => a.indexOf(v) === i && !v.includes("node_modules") && !v.includes(".git"))
      .slice(0, 15);

    const changedFiles = fileMatches.filter(f => /edit|write|replace|modify|patch/i.test(JSON.stringify(messages).toLowerCase()));
    const readFiles = fileMatches.filter(f => !changedFiles.includes(f));

    let decisionsText = "Continued codebase auditing and alignment.";
    let testsText = "not-run (pruned history)";
    let blockersText = "none";

    try {
      const analyzer = new SemanticAnalyzer();
      const keyPoints = analyzer.extractKeyPoints(messages);
      if (keyPoints.length > 0) {
        decisionsText = keyPoints.filter(kp => kp.type === "decision").map(kp => kp.content).slice(0, 3).join(", ") || decisionsText;
        blockersText = keyPoints.filter(kp => kp.type === "error").map(kp => kp.content).slice(0, 2).join(", ") || blockersText;
      }
    } catch {}

    const lastUserMsg = userMessages.length > 0 ? contentToString(userMessages[userMessages.length - 1].content).substring(0, 120) : "Continue";

    return `Objective: Audit and refine coding assistant prompts and orchestration behaviors (pruned history had ${messages.length} messages)
Current mode: implement
User intent: ${lastUserMsg}
Files read: ${readFiles.join(", ") || "none"}
Files changed: ${changedFiles.join(", ") || "none"}
Decisions: ${decisionsText}
Tests/build: ${testsText}
Blockers: ${blockersText}
Next safe action: Proceed with testing and validation of recent prompt modifications
Confidence: static-only`;
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
    const isMemoryContext = rawContent.startsWith("[RMemory Agent Memory Context]:");
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
