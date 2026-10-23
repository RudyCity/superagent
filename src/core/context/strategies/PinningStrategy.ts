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
import { generateText } from "ai";

export interface PinningConfig {
  model?: any;
  abortSignal?: AbortSignal;
}

export class PinningStrategy implements CompactionStrategy {
  name = "pinning";
  private config?: PinningConfig;

  constructor(config?: PinningConfig) {
    this.config = config;
  }

  setConfig(config: PinningConfig): void {
    this.config = config;
  }

  canHandle(context: CompactionContext): boolean {
    return context.hasPinnedMessages && context.pinnedMessageIds !== undefined;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const pinnedIds = options.pinnedMessageIds || new Set<string>();
    const preserveRecent = options.preserveRecent || 20;
    const tokenBudget = options.tokenBudget || 0;

    const pinned: Array<{ index: number; msg: Message }> = [];
    const unpinned: Message[] = [];

    // Use stable content-based IDs: role:timestamp:contentPrefix
    // These survive compaction (unlike index-based IDs which shift after pruning).
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const textContent = contentToString(msg.content);
      // Old compaction summaries are unpinned historical input. They must
      // participate in the next summary rather than disappearing entirely.
      if (isCompactionSummaryText(textContent)) {
        unpinned.push(msg);
        continue;
      }
      const contentPrefix = textContent.slice(0, 64);
      const stableId = `${msg.role}:${msg.timestamp}:${contentPrefix}`;
      // Also try legacy index-based ID for backward compatibility
      const legacyId = `${i}:${msg.role}:${msg.timestamp}`;
      if (pinnedIds.has(stableId) || pinnedIds.has(legacyId)) {
        pinned.push({ index: i, msg });
      } else {
        unpinned.push(msg);
      }
    }

    // Always anchor the latest active user request so compaction never loses the user's task
    let latestUserMsgIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "user") {
        const text = contentToString(msg.content);
        if (!isCompactionSummaryText(text)) {
          latestUserMsgIndex = i;
          break;
        }
      }
    }
    if (latestUserMsgIndex >= 0 && !pinned.some(p => p.index === latestUserMsgIndex)) {
      const unpinnedIdx = unpinned.findIndex(m => m === messages[latestUserMsgIndex]);
      if (unpinnedIdx >= 0) {
        unpinned.splice(unpinnedIdx, 1);
      }
      pinned.push({ index: latestUserMsgIndex, msg: messages[latestUserMsgIndex] });
      pinned.sort((a, b) => a.index - b.index);
    }

    let keepIndex = Math.max(0, unpinned.length - preserveRecent);
    while (keepIndex < unpinned.length && unpinned[keepIndex]?.role === "tool") {
      keepIndex++;
    }
    let toSummarize = unpinned.slice(0, keepIndex);
    let toKeep = unpinned.slice(keepIndex);
    // Even if a previous summary falls within the recent window, roll it
    // forward instead of leaving a second summary in the resulting transcript.
    const oldSummaries = toKeep.filter((m) =>
      isCompactionSummaryText(contentToString(m.content))
    );
    if (oldSummaries.length) {
      toSummarize = [...oldSummaries, ...toSummarize];
      toKeep = toKeep.filter((m) =>
        !isCompactionSummaryText(contentToString(m.content))
      );
    }

    // Enforce token budget: reduce preserved unpinned and redundant pinned messages if they exceed budget
    if (tokenBudget > 0) {
      const summaryOverhead = 500;
      const modelName = options.modelName || "";
      const tracker = new TokenTracker(modelName);
      await tracker.ensureEncoder();

      // Cap pinned messages if they consume too much of the context window:
      // Keep initial user prompt and latest plan/state, evicting older intermediate pinned messages.
      const maxPinnedBudget = Math.floor(tokenBudget * 0.4);
      let pinnedTokens = pinned.reduce((s, p) => s + tracker.estimateTokens(p.msg), 0);
      if (pinnedTokens > maxPinnedBudget && pinned.length > 2) {
        const keptPinned = [pinned[0], pinned[pinned.length - 1]];
        const evictedPinned = pinned.slice(1, -1);
        for (const ep of evictedPinned) {
          toSummarize.push(ep.msg);
        }
        pinned.length = 0;
        pinned.push(...keptPinned);
        pinnedTokens = pinned.reduce((s, p) => s + tracker.estimateTokens(p.msg), 0);
      }

      const keepBudget = Math.max(1000, Math.floor(tokenBudget * 0.6) - summaryOverhead - pinnedTokens);
      let keepTokens = 0;
      for (const m of toKeep) keepTokens += tracker.estimateTokens(m);
      while (keepTokens > keepBudget && toKeep.length > 0) {
        const moved = toKeep.shift()!;
        toSummarize.push(moved);
        keepTokens -= tracker.estimateTokens(moved);
      }

      // Guarantee forward progress: if over 75% budget, force prune at least some unpinned messages
      if (toSummarize.length === 0 && toKeep.length > 2 && (keepTokens + pinnedTokens) > Math.floor(tokenBudget * 0.75)) {
        const forceCount = Math.max(1, Math.min(toKeep.length - 2, Math.floor(toKeep.length * 0.3)));
        const evicted = toKeep.splice(0, forceCount);
        toSummarize.push(...evicted);
      }
    }

    // Ensure that after pruning, the kept messages slice does not start with a tool message
    while (toKeep.length > 0 && toKeep[0].role === "tool") {
      const moved = toKeep.shift()!;
      toSummarize.push(moved);
    }

    // Smart AI compact: use LLM summary when model is available, otherwise heuristic fallback.
    const abortSignal = options.abortSignal ?? this.config?.abortSignal;
    let summary: string;
    let usedLLM = false;
    let usedFallback = false;
    if (toSummarize.length === 0) {
      summary = "No messages pruned.";
    } else if (this.config?.model) {
      try {
        summary = await this.generateLLMSummary(toSummarize, abortSignal);
        usedLLM = true;
      } catch (error) {
        if (abortSignal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        summary = this.buildPruneSummary(toSummarize);
        usedFallback = true;
      }
    } else {
      summary = this.buildPruneSummary(toSummarize);
      usedFallback = true;
    }

    let activeTaskAnnotation = "";
    if (latestUserMsgIndex >= 0) {
      const activeText = contentToString(messages[latestUserMsgIndex].content).trim();
      if (activeText && !summary.includes(activeText.slice(0, 40))) {
        activeTaskAnnotation = `\n\n### ⚡ Current Active User Request:\n${activeText}`;
      }
    }

    const summaryMessage: Message = {
      role: "user",
      content: `[System Conversation Summary]:\n${summary}${activeTaskAnnotation}`,
      timestamp: Date.now(),
    };

    // Reconstruct in original chronology. Pinning the latest user message can
    // otherwise move it before older tool results and mislead the next model turn.
    const sourceIndex = new Map(messages.map((message, index) => [message, index]));
    const chronological = [...pinned.map((p) => p.msg), ...toKeep]
      .sort((a, b) => (sourceIndex.get(a) ?? 0) - (sourceIndex.get(b) ?? 0));
    const result: Message[] = [summaryMessage, ...chronological];

    return {
      messages: result,
      metadata: {
        strategy: "pinning",
        messagesBefore: messages.length,
        messagesAfter: result.length,
        pinnedCount: pinned.length,
        summary,
        usedLLM,
        usedFallback,
      },
    };
  }

  estimateCost(messages: Message[]): CompactionCost {
    const inputTokens = messages.reduce(
      (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
      0
    );
    return {
      tokens: inputTokens + 500,
      time: 2000,
      apiCalls: this.config?.model ? 1 : 0,
    };
  }

  private async generateLLMSummary(messages: Message[], abortSignal?: AbortSignal): Promise<string> {
    if (messages.length === 0) return "No messages pruned.";
    const MAX_FORMATTED_CHARS = 80_000;
    const formatted = messages
      .map((m) => {
        const role = m.role.toUpperCase();
        let details = contentToString(m.content) || "";
        if (m.toolCalls && m.toolCalls.length > 0) {
          details += `\n[Tool Calls]: ${m.toolCalls.map((tc) => tc.name).join(", ")}`;
        }
        return `[${role}]: ${details}`;
      })
      .join("\n\n");
    const truncated = formatted.length > MAX_FORMATTED_CHARS
      ? formatted.slice(0, MAX_FORMATTED_CHARS) + "\n[... truncated for brevity ...]"
      : formatted;
    const prompt = `You are a helper system node. Summarize the assistant conversation history into a clear, human-readable summary.

Structure:
### 🎯 User Goal
- What the user requested.

### 🛠️ Key Actions Taken
- Key actions, research, writing, artifacts, commands, and decisions where relevant.

### 🔍 Current State
- Current state, open questions, and test/build status when relevant.

Keep the summary natural, clear, direct, and formatted with clean Markdown bullet points. Preserve key file paths, function names, and technical decisions.

---
PAST CHAT HISTORY:
${truncated}`;

    let attempt = 0;
    const maxRetries = 3;
    const baseDelay = 2000;
    while (true) {
      try {
        try {
          const { logPrompt } = await import("../../agent/PromptLogger.js");
          logPrompt(
            "PinningStrategy:summarizeMessages",
            this.config?.model?.modelId || (typeof this.config?.model === "string" ? this.config?.model : undefined),
            "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
            prompt
          );
        } catch {}
        const result = await generateText({
          model: this.config!.model,
          system: "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
          prompt,
          abortSignal: abortSignal ?? this.config!.abortSignal,
        });
        return result.text;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        attempt++;
        if (attempt > maxRetries) throw err;
        if (abortSignal?.aborted) throw err as Error;
        await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));
      }
    }
  }

  /**
   * Build an informative summary of pruned messages by extracting
   * file paths, tool names, and error keywords — so the agent still
   * has context about what was removed.
   */
  private buildPruneSummary(messages: Message[]): string {
    if (messages.length === 0) return "No messages pruned.";

    const filePaths = new Set<string>();
    const toolNames = new Set<string>();
    const errorKeywords: string[] = [];

    for (const m of messages) {
      const text = contentToString(m.content);
      // Extract file paths
      const fps = text.match(/(?:[\/\\]|\b)[\w.-]+(?:[\/\\])[\w.-]+(?:\.\w+)?/g) || [];
      fps.forEach((f) => filePaths.add(f));
      // Extract tool names
      (m.toolCalls || []).forEach((tc) => toolNames.add(tc.name));
      // Extract error mentions (first 120 chars of match)
      const errorMatch = text.match(/(?:error|failed|exception)[^\n]{0,120}/i);
      if (errorMatch) errorKeywords.push(errorMatch[0].trim());
    }

    const parts: string[] = [
      `[Pruned ${messages.length} unpinned messages from context.]`,
    ];
    const previousSummaries = messages.filter((m) =>
      isCompactionSummaryText(contentToString(m.content))
    );
    if (previousSummaries.length) {
      parts.push("Earlier compacted decisions and work: " +
        previousSummaries.slice(-2).map((m) => contentToString(m.content).slice(0, 1200)).join(" | "));
    }
    const userRequests = messages.filter((m) =>
      m.role === "user" && !isCompactionSummaryText(contentToString(m.content))
    );
    if (userRequests.length) {
      parts.push("Previous user request: " +
        contentToString(userRequests[userRequests.length - 1].content).slice(0, 600));
    }
    if (filePaths.size > 0)
      parts.push(`Files referenced: ${[...filePaths].slice(0, 8).join(", ")}.`);
    if (toolNames.size > 0)
      parts.push(`Tools used: ${[...toolNames].join(", ")}.`);
    if (errorKeywords.length > 0)
      parts.push(`Errors noted: ${errorKeywords.slice(0, 3).join(" | ")}.`);

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

    return parts.join(" ");
  }
}
