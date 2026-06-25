import { contentToString } from "../../conversation.js";
import { generateText } from "ai";
export class SummarizationStrategy {
    name = "summarization";
    config;
    constructor(config) {
        this.config = config;
    }
    setConfig(config) {
        this.config = config;
    }
    canHandle(context) {
        return context.messages.length > 10;
    }
    async execute(messages, options) {
        const preserveRecent = options.preserveRecent || 20;
        const abortSignal = options.abortSignal ?? this.config?.abortSignal;
        let keepIndex = Math.max(0, messages.length - preserveRecent);
        while (keepIndex < messages.length && messages[keepIndex]?.role === "tool") {
            keepIndex++;
        }
        const toSummarize = messages.slice(0, keepIndex);
        const toKeep = messages.slice(keepIndex);
        let summary;
        if (this.config?.model) {
            summary = await this.generateLLMSummary(toSummarize, abortSignal);
        }
        else {
            summary = this.createHeuristicSummary(toSummarize);
        }
        const summaryMessage = {
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
    estimateCost(messages) {
        const inputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
        const outputTokens = 500;
        return {
            tokens: inputTokens + outputTokens,
            time: 2000,
            apiCalls: this.config?.model ? 1 : 0,
        };
    }
    async generateLLMSummary(messages, abortSignal) {
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
                    model: this.config.model,
                    system: "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
                    prompt,
                    abortSignal: abortSignal ?? this.config.abortSignal,
                });
                return result.text;
            }
            catch (err) {
                if (err instanceof Error && err.name === "AbortError") {
                    throw err;
                }
                attempt++;
                if (attempt > maxRetries) {
                    // Fallback to heuristic summary on repeated failure
                    return this.createHeuristicSummary(messages);
                }
                if (abortSignal?.aborted)
                    throw err;
                await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));
            }
        }
    }
    createHeuristicSummary(messages) {
        const userMessages = messages.filter((m) => m.role === "user");
        const assistantMessages = messages.filter((m) => m.role === "assistant");
        const errorMessages = messages.filter((m) => /error|failed|exception/i.test(contentToString(m.content)));
        const fileMatches = messages
            .flatMap((m) => contentToString(m.content).match(/[\w.-]+(?:\/|\\)[\w.-]+(?:\.\w+)?/g) || [])
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 10);
        const parts = [
            `Conversation had ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant).`,
        ];
        if (fileMatches.length > 0) {
            parts.push(`Files referenced: ${fileMatches.join(", ")}.`);
        }
        if (errorMessages.length > 0) {
            parts.push(`${errorMessages.length} error-related messages encountered.`);
        }
        parts.push("Key topics and actions were preserved in task files.");
        return parts.join(" ");
    }
}
//# sourceMappingURL=SummarizationStrategy.js.map