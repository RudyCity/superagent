import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
  estimateTokensCached,
} from "../CompactionStrategy.js";
import { Message, contentToString } from "../../conversation.js";
import { generateText } from "ai";
import { SemanticAnalyzer } from "../SemanticAnalyzer.js";
import { TokenTracker } from "../TokenTracker.js";

export interface SummarizationConfig {
  model?: any;
  abortSignal?: AbortSignal;
}

export class SummarizationStrategy implements CompactionStrategy {
  name = "summarization";
  private config?: SummarizationConfig;

  constructor(config?: SummarizationConfig) {
    this.config = config;
  }

  setConfig(config: SummarizationConfig): void {
    this.config = config;
  }

  canHandle(context: CompactionContext): boolean {
    return context.messages.length > 10;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const preserveRecent = options.preserveRecent || 20;
    const tokenBudget = options.tokenBudget || 0;
    const abortSignal = options.abortSignal ?? this.config?.abortSignal;

    const filteredMessages = messages.filter(
      (m) => !contentToString(m.content).includes("[System Conversation Summary]")
    );

    let keepIndex = Math.max(0, filteredMessages.length - preserveRecent);
    while (keepIndex < filteredMessages.length && filteredMessages[keepIndex]?.role === "tool") {
      keepIndex++;
    }
    let toSummarize = filteredMessages.slice(0, keepIndex);
    let toKeep = filteredMessages.slice(keepIndex);

    // Enforce token budget: reduce preserved messages if they exceed budget
    if (tokenBudget > 0) {
      const summaryOverhead = 500; // estimated token budget for the summary message
      const keepBudget = Math.floor(tokenBudget * 0.6) - summaryOverhead;
      const modelName = options.modelName || "";
      const tracker = new TokenTracker(modelName);
      let keepTokens = 0;
      for (const m of toKeep) keepTokens += tracker.estimateTokens(m);
      while (keepTokens > keepBudget && toKeep.length > 0) {
        // Move oldest kept message back to summarize pile (incremental delta)
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

    let summary: string;
    let usedFallback = false;
    if (this.config?.model) {
      summary = await this.generateLLMSummary(toSummarize, abortSignal);
    } else {
      // No LLM available — fall back to heuristic so compaction still proceeds.
      // The metadata flag below makes this silent degradation visible to the
      // UI/event listeners.
      summary = this.createHeuristicSummary(toSummarize);
      usedFallback = true;
    }

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
        summaryTokens: Math.ceil(summary.length / 4),
        // Indicates compaction ran via heuristic fallback (no LLM). Lets
        // UI/dashboards surface "low-quality compaction" warnings to the user
        // instead of silently degrading.
        usedFallback,
        usedLLM: !usedFallback,
      },
    };
  }

  estimateCost(messages: Message[]): CompactionCost {
    const inputTokens = messages.reduce(
      (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
      0
    );
    const outputTokens = 500;

    return {
      tokens: inputTokens + outputTokens,
      time: 2000,
      apiCalls: this.config?.model ? 1 : 0,
    };
  }

  private async generateLLMSummary(messages: Message[], abortSignal?: AbortSignal): Promise<string> {
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

    // Guard: truncate if too large to avoid LLM context overflow + expensive retries
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
            "SummarizationStrategy:summarizeMessages",
            this.config?.model?.modelId || (typeof this.config?.model === "string" ? this.config?.model : undefined),
            "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
            prompt
          );
        } catch {}

        const result = await generateText({
          model: this.config!.model,
          system:
            "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
          prompt,
          abortSignal: abortSignal ?? this.config!.abortSignal,
        });
        return result.text;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }
        attempt++;
        if (attempt > maxRetries) {
          // Fallback to heuristic summary on repeated failure
          return this.createHeuristicSummary(messages);
        }
        if (abortSignal?.aborted) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1))
        );
      }
    }
  }

  private createHeuristicSummary(messages: Message[]): string {
    const userMessages = messages.filter((m) => m.role === "user");
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    const errorMessages = messages.filter((m) =>
      /error|failed|exception/i.test(contentToString(m.content))
    );

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

    if (errorMessages.length > 0) {
      parts.push(`${errorMessages.length} error-related messages encountered.`);
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

    parts.push("Key topics and actions were preserved in task files.");

    return parts.join(" ");
  }
}
