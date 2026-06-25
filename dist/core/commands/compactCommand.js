import { registry } from "./registry.js";
import { getDefaultModel } from "./types.js";
import { getContextWindowLimit, getEffectiveMasterModel } from "../config.js";
// /compact command
export const compactCommand = {
    name: "compact",
    description: "Show conversation summary or force compaction",
    async execute(args, ctx) {
        const subcommand = args.trim().toLowerCase();
        // Handle /compact now - force compaction
        if (subcommand === "now") {
            const conversation = ctx.agent?.getHistory();
            const cm = conversation?.getContextManager?.();
            if (!cm || !conversation) {
                ctx.addLine({
                    type: "error",
                    content: "ContextManager not initialized yet. Send a message first.",
                    timestamp: Date.now()
                });
                return;
            }
            if (cm.getState() !== "IDLE") {
                ctx.addLine({
                    type: "error",
                    content: `Cannot compact: ContextManager is in ${cm.getState()} state.`,
                    timestamp: Date.now()
                });
                return;
            }
            const messages = conversation.getMessages();
            if (messages.length < 10) {
                ctx.addLine({
                    type: "error",
                    content: "Not enough messages to compact (minimum 10 messages).",
                    timestamp: Date.now()
                });
                return;
            }
            // Calculate tokens before compaction
            const tokensBefore = cm.estimateTokensForAll(messages).total;
            ctx.addLine({
                type: "system",
                content: "Forcing compaction...",
                timestamp: Date.now()
            });
            try {
                const result = await cm.compact(messages);
                conversation.replaceMessages(result.messages);
                // Calculate tokens after compaction
                const tokensAfter = cm.estimateTokensForAll(result.messages).total;
                const tokensSaved = tokensBefore - tokensAfter;
                const messagesBefore = messages.length;
                const messagesAfter = result.messages.length;
                ctx.addLine({
                    type: "system",
                    content: `✓ Compaction completed!\n  Strategy: ${result.metadata.strategy}\n  Messages: ${messagesBefore} → ${messagesAfter} (-${messagesBefore - messagesAfter})\n  Tokens: ${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} (-${tokensSaved.toLocaleString()})`,
                    timestamp: Date.now()
                });
            }
            catch (err) {
                ctx.addLine({
                    type: "error",
                    content: `Compaction failed: ${err.message}`,
                    timestamp: Date.now()
                });
            }
            return;
        }
        // Default behavior: show summary
        const currentModel = getEffectiveMasterModel("auto") || getDefaultModel();
        const limit = getContextWindowLimit(currentModel);
        const conversation = ctx.agent?.getHistory();
        const summary = conversation?.getCompactSummary(limit) || "No history.";
        ctx.addLine({ type: "system", content: summary, timestamp: Date.now() });
        const cm = conversation?.getContextManager?.();
        if (cm) {
            const history = cm.getHistory();
            const tokensSaved = history.reduce((sum, e) => sum + (e.tokensBefore - e.tokensAfter), 0);
            const lines = [
                "",
                `Context Manager: active`,
                `  Compactions performed: ${history.length}`,
                `  Total tokens saved: ${tokensSaved.toLocaleString()}`,
                `  State: ${cm.getState()}`,
            ];
            if (history.length > 0) {
                const last = history[history.length - 1];
                lines.push(`  Last strategy: ${last.strategy} (${new Date(last.timestamp).toLocaleTimeString()})`);
            }
            ctx.addLine({ type: "system", content: lines.join("\n"), timestamp: Date.now() });
        }
    },
};
registry.register(compactCommand);
//# sourceMappingURL=compactCommand.js.map