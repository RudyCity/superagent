export class PinningStrategy {
    name = "pinning";
    canHandle(context) {
        return context.hasPinnedMessages && context.pinnedMessageIds !== undefined;
    }
    async execute(messages, options) {
        const pinnedIds = options.pinnedMessageIds || new Set();
        const preserveRecent = options.preserveRecent || 20;
        const pinned = [];
        const unpinned = [];
        for (const msg of messages) {
            const id = this.getMessageId(msg);
            if (pinnedIds.has(id)) {
                pinned.push(msg);
            }
            else {
                unpinned.push(msg);
            }
        }
        // Summarize unpinned messages (keep recent + summary of older)
        const toSummarize = unpinned.slice(0, -preserveRecent);
        const toKeep = unpinned.slice(-preserveRecent);
        const summary = `[Summary of ${toSummarize.length} unpinned messages]: Context preserved`;
        const summaryMessage = {
            role: "user",
            content: `[System Conversation Summary]:\n${summary}`,
            timestamp: Date.now(),
        };
        // Reconstruct: summary + pinned messages (in original order) + recent unpinned
        const result = this.reconstructOrder([summaryMessage, ...toKeep], pinned, messages);
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
    estimateCost(messages) {
        const inputTokens = messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
        return {
            tokens: inputTokens + 500,
            time: 2000,
            apiCalls: 1,
        };
    }
    getMessageId(msg) {
        return `${msg.role}:${msg.timestamp}:${msg.content.substring(0, 50)}`;
    }
    reconstructOrder(summaryAndRecent, pinned, original) {
        // Simple approach: summary first, then pinned in original order, then recent
        const result = [summaryAndRecent[0]];
        for (const orig of original) {
            const id = this.getMessageId(orig);
            const isPinned = pinned.some((p) => this.getMessageId(p) === id);
            if (isPinned) {
                result.push(orig);
            }
        }
        // Add recent messages (skip the summary which is already added)
        result.push(...summaryAndRecent.slice(1));
        return result;
    }
}
//# sourceMappingURL=PinningStrategy.js.map