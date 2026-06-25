import { registry } from "./registry.js";
// /compaction-history command - view compaction audit trail
export const compactionHistoryCommand = {
    name: "compaction-history",
    aliases: ["ch"],
    description: "View compaction audit trail",
    execute(args, ctx) {
        const now = Date.now();
        const agent = ctx.agent;
        if (!agent) {
            ctx.addLine({
                type: "error",
                content: "No active agent.",
                timestamp: now,
            });
            return;
        }
        const cm = agent.getContextManager();
        if (!cm) {
            ctx.addLine({
                type: "error",
                content: "ContextManager not initialized. Send a message first to initialize it.",
                timestamp: now,
            });
            return;
        }
        const history = cm.getHistory();
        if (history.length === 0) {
            ctx.addLine({
                type: "system",
                content: "No compaction events recorded.\n\nCompaction occurs automatically when context usage exceeds threshold.",
                timestamp: now,
            });
            return;
        }
        const trimmed = args.trim();
        let displayCount = history.length;
        // /compaction-history <count> - show last N events
        if (trimmed) {
            const num = parseInt(trimmed, 10);
            if (!isNaN(num) && num > 0) {
                displayCount = Math.min(num, history.length);
            }
        }
        const events = history.slice(-displayCount);
        const lines = [`Compaction History (showing ${events.length} of ${history.length} events):`];
        lines.push("═".repeat(70));
        for (const event of events) {
            const timestamp = new Date(event.timestamp).toLocaleString();
            const tokensSaved = event.tokensBefore - event.tokensAfter;
            const messagesRemoved = event.messagesBefore - event.messagesAfter;
            lines.push("");
            lines.push(`[${timestamp}]`);
            lines.push(`  Strategy: ${event.strategy}`);
            lines.push(`  Messages: ${event.messagesBefore} → ${event.messagesAfter} (-${messagesRemoved})`);
            lines.push(`  Tokens: ${event.tokensBefore.toLocaleString()} → ${event.tokensAfter.toLocaleString()} (-${tokensSaved.toLocaleString()})`);
            lines.push(`  Reason: ${event.reason}`);
            if (event.summary) {
                const preview = event.summary.length > 100 ? event.summary.substring(0, 100) + "..." : event.summary;
                lines.push(`  Summary: ${preview}`);
            }
        }
        lines.push("");
        lines.push("═".repeat(70));
        const totalTokensSaved = history.reduce((sum, e) => sum + (e.tokensBefore - e.tokensAfter), 0);
        const avgTokensSaved = Math.round(totalTokensSaved / history.length);
        lines.push(`Total tokens saved: ${totalTokensSaved.toLocaleString()} (avg: ${avgTokensSaved.toLocaleString()} per compaction)`);
        ctx.addLine({
            type: "system",
            content: lines.join("\n"),
            timestamp: now,
        });
    },
};
registry.register(compactionHistoryCommand);
//# sourceMappingURL=compactionHistoryCommand.js.map