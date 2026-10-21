import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
  estimateTokensCached,
  isCompactionSummaryText,
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

    // Keep chronological order. Sorting by "importance" used to reorder tool
    // calls/results and could make context look like actions happened out of order.
    // Copy kept messages before truncation so a failed compaction never changes
    // the source transcript (including its nested tool results).
    toKeep = toKeep.map((msg) => structuredClone(msg));

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
      let currentBytes = toKeep.reduce((sum, msg) => sum + estimateMessagePayloadBytes(msg), 0);

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
        currentBytes = toKeep.reduce((sum, msg) => sum + estimateMessagePayloadBytes(msg), 0);
      }

      // If still exceeding, prune older messages
      while (currentBytes > byteBudget && toKeep.length > 0) {
        const moved = toKeep.shift()!;
        toPrune.push(moved);
        currentBytes = toKeep.reduce((sum, msg) => sum + estimateMessagePayloadBytes(msg), 0);
      }
    }

    // Ensure that after all pruning, the kept messages slice does not start with a tool message
    while (toKeep.length > 0 && toKeep[0].role === "tool") {
      const moved = toKeep.shift()!;
      toPrune.push(moved);
    }

    // Keep the current user objective even if tight budgets evict its original
    // turn. Preserve a bounded copy rather than losing the task completely.
    const latestUser = [...messages].reverse().find((msg) =>
      msg.role === "user" && !isCompactionSummaryText(contentToString(msg.content))
    );
    if (latestUser && !toKeep.some((msg) => msg.role === "user" && msg.timestamp === latestUser.timestamp)) {
      const activeText = contentToString(latestUser.content).slice(0, 1200);
      toKeep.push({ role: "user", content: activeText, timestamp: latestUser.timestamp });
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
        usedFallback: false,
        usedLLM: false,
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
    const userMessages = messages.filter((m) => m.role === "user" &&
      !isCompactionSummaryText(contentToString(m.content)));
    const filePaths = new Set<string>();
    const tools = new Set<string>();
    const failures: string[] = [];
    const previousSummaries: string[] = [];
    for (const message of messages) {
      const body = contentToString(message.content);
      if (/\[(?:System Conversation Summary|Emergency Summary - Context Pruned)/.test(body)) {
        previousSummaries.push(body.slice(0, 700));
      }
      for (const file of body.match(/[\w.-]+(?:\/|\\)[\w.-]+(?:\.\w+)?/g) || []) {
        if (!file.includes("node_modules") && !file.includes(".git")) filePaths.add(file);
        if (filePaths.size >= 12) break;
      }
      for (const call of message.toolCalls || []) tools.add(call.name);
      for (const result of message.toolResults || []) {
        if (result.isError) failures.push(result.name + ": " + result.result.slice(0, 160));
      }
    }
    const latestIntent = userMessages.length
      ? contentToString(userMessages[userMessages.length - 1].content).slice(0, 500)
      : "No previous user request retained";
    const parts = [
      "Older context pruned: " + messages.length + " messages.",
      "Last user request from pruned portion: " + latestIntent,
      "Referenced files: " + (Array.from(filePaths).join(", ") || "none recorded"),
      "Executed tools: " + (Array.from(tools).slice(0, 15).join(", ") || "none recorded"),
      "Tool errors: " + (failures.slice(-3).join(" | ") || "none recorded"),
    ];
    if (previousSummaries.length) parts.push("Previous compaction notes: " + previousSummaries.slice(-2).join(" | "));
    parts.push("Treat unverified statuses as unknown; consult task files and tool logs for completion evidence.");
    return parts.join("\n");
  }
}

function estimateMessagePayloadBytes(
  msg: Message
): number {
  let size = 0;

  if (msg.role === "user") {
    size += Buffer.byteLength(JSON.stringify(msg.content), "utf-8");
  } else if (msg.role === "assistant") {
    size += Buffer.byteLength(JSON.stringify(msg.content), "utf-8");
    if (msg.toolCalls) {
      size += Buffer.byteLength(JSON.stringify(msg.toolCalls), "utf-8");
    }
  } else if (msg.role === "tool") {
    const results = msg.toolResults || [];
    for (const tr of results) {
      size += Buffer.byteLength(JSON.stringify(tr), "utf-8");
    }
  } else {
    size += Buffer.byteLength(JSON.stringify(msg), "utf-8");
  }
  return size;
}
