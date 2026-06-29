import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
  tokensForMessages,
} from "../CompactionStrategy.js";
import { Message, contentToString } from "../../conversation.js";
import { generateText } from "ai";
import { SemanticAnalyzer } from "../SemanticAnalyzer.js";

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

    let keepIndex = Math.max(0, messages.length - preserveRecent);
    while (keepIndex < messages.length && messages[keepIndex]?.role === "tool") {
      keepIndex++;
    }
    let toSummarize = messages.slice(0, keepIndex);
    let toKeep = messages.slice(keepIndex);

    // Enforce token budget: reduce preserved messages if they exceed budget
    if (tokenBudget > 0) {
      const summaryOverhead = 500; // estimated token budget for the summary message
      const keepBudget = Math.floor(tokenBudget * 0.6) - summaryOverhead;
      let keepTokens = tokensForMessages(toKeep);
      while (keepTokens > keepBudget && toKeep.length > 0) {
        // Move oldest kept message back to summarize pile
        const moved = toKeep.shift()!;
        toSummarize.push(moved);
        keepTokens = tokensForMessages(toKeep);
      }
    }

    let summary: string;
    if (this.config?.model) {
      summary = await this.generateLLMSummary(toSummarize, abortSignal);
    } else {
      summary = this.createHeuristicSummary(toSummarize);
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

    const prompt = `You are a helper system node. Summarize the following past coding assistant chat history turns extremely briefly.
Identify:
1. What the user's goals or requirements were.
2. What actions the assistant took (e.g. edited files, ran commands).
3. The resulting workspace state or any unresolved issues.

Keep the summary concise, clear, and direct. Preserve key file paths, function names, and technical decisions.

---
PAST CHAT HISTORY:
${truncated}`;

    let attempt = 0;
    const maxRetries = 3;
    const baseDelay = 2000;

    while (true) {
      try {
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
