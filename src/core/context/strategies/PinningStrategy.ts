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
      // Skip old conversation summaries so they are not retained as duplicate pinned/unpinned items
      if (textContent.includes("[System Conversation Summary]")) {
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

    let keepIndex = Math.max(0, unpinned.length - preserveRecent);
    while (keepIndex < unpinned.length && unpinned[keepIndex]?.role === "tool") {
      keepIndex++;
    }
    let toSummarize = unpinned.slice(0, keepIndex);
    let toKeep = unpinned.slice(keepIndex);

    // Enforce token budget: reduce preserved unpinned messages if they exceed budget
    if (tokenBudget > 0) {
      const summaryOverhead = 500;
      const modelName = options.modelName || "";
      const tracker = new TokenTracker(modelName);
      const pinnedTokens = pinned.reduce((s, p) => s + tracker.estimateTokens(p.msg), 0);
      const keepBudget = Math.floor(tokenBudget * 0.6) - summaryOverhead - pinnedTokens;
      let keepTokens = 0;
      for (const m of toKeep) keepTokens += tracker.estimateTokens(m);
      while (keepTokens > keepBudget && toKeep.length > 0) {
        const moved = toKeep.shift()!;
        toSummarize.push(moved);
        keepTokens -= tracker.estimateTokens(moved);
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
    if (this.config?.model) {
      summary = await this.generateLLMSummary(toSummarize, abortSignal);
    } else {
      summary = this.buildPruneSummary(toSummarize);
    }

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
    const prompt = `You are a helper system node. Summarize the following past coding assistant chat history turns into a clean, human-readable format.

Structure:
### 🎯 User Goal
- What the user requested.

### 🛠️ Key Actions Taken
- Files created, edited, or commands executed.

### 🔍 Workspace Status
- Final state, test/build status, and unresolved issues if any.

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
        if (attempt > maxRetries) return this.buildPruneSummary(messages);
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
