export class PruningStrategy {
    name = "pruning";
    canHandle(_context) {
        return true;
    }
    async execute(messages, options) {
        const preserveRecent = options.preserveRecent || 20;
        const toPrune = messages.slice(0, -preserveRecent);
        const toKeep = messages.slice(-preserveRecent);
        const emergencySummary = this.createEmergencySummary(toPrune);
        const summaryMessage = {
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
    estimateCost(_messages) {
        return {
            tokens: 0,
            time: 100,
            apiCalls: 0,
        };
    }
    createEmergencySummary(messages) {
        const userMessages = messages.filter((m) => m.role === "user");
        const assistantMessages = messages.filter((m) => m.role === "assistant");
        const fileMatches = messages
            .flatMap((m) => m.content.match(/[\w.-]+(?:\/|\\)[\w.-]+(?:\.\w+)?/g) || [])
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 10);
        const parts = [
            `Conversation had ${messages.length} messages (${userMessages.length} user, ${assistantMessages.length} assistant).`,
        ];
        if (fileMatches.length > 0) {
            parts.push(`Files referenced: ${fileMatches.join(", ")}.`);
        }
        parts.push("Key topics discussed and actions taken were preserved in task files.");
        return parts.join(" ");
    }
}
//# sourceMappingURL=PruningStrategy.js.map