import { registry } from "./registry.js";
import { getSettings } from "../config.js";
import { getTencentDBClient, getTencentDBSessionKey } from "../tencentdbUtil.js";
export const memoryCommand = {
    name: "memory",
    description: "Manage and inspect TencentDB long-term memory",
    async execute(args, ctx) {
        const trimmed = args.trim();
        const parts = trimmed.split(/\s+/);
        const subcommand = parts[0]?.toLowerCase() || "help";
        const settings = getSettings();
        if (!settings.enableTencentdbMemory) {
            ctx.addLine({
                type: "error",
                content: "TencentDB memory is currently disabled. Enable it in settings first.",
                timestamp: Date.now(),
            });
            return;
        }
        const client = getTencentDBClient(3000); // 3s timeout
        if (subcommand === "status") {
            ctx.addLine({
                type: "system",
                content: "Checking TencentDB memory status...",
                timestamp: Date.now(),
            });
            try {
                const historyPath = ctx.agent?.getCurrentHistoryFilePath() || null;
                const sessionKey = getTencentDBSessionKey(historyPath);
                // Quick connection ping using readCore
                await client.readCore();
                const watermark = ctx.agent?.getHistory()?.lastCapturedTimestamp;
                const watermarkStr = watermark
                    ? new Date(watermark).toLocaleString()
                    : "None (no turns synchronized yet)";
                const lines = [
                    "TencentDB Memory Status: Connected",
                    `  Gateway URL: ${settings.tencentdbGatewayUrl || "http://127.0.0.1:8420"}`,
                    `  Service ID: ${settings.tencentdbServiceId || "default"}`,
                    `  Active Session Key: ${sessionKey}`,
                    `  Last Sync Watermark: ${watermarkStr}`,
                ];
                ctx.addLine({
                    type: "system",
                    content: lines.join("\n"),
                    timestamp: Date.now(),
                });
            }
            catch (err) {
                ctx.addLine({
                    type: "error",
                    content: `TencentDB Memory Status: Offline / Connection Failed\n  Error: ${err.message}\n  Make sure your local tencentdb-gateway is running.`,
                    timestamp: Date.now(),
                });
            }
            return;
        }
        if (subcommand === "list") {
            ctx.addLine({
                type: "system",
                content: "Retrieving long-term structured memories (L1)...",
                timestamp: Date.now(),
            });
            try {
                const res = await client.queryAtomic({});
                const items = res.items || [];
                if (items.length === 0) {
                    ctx.addLine({
                        type: "system",
                        content: "No long-term structured memories found.",
                        timestamp: Date.now(),
                    });
                    return;
                }
                const lines = ["=== Long-Term Structured Memories ==="];
                for (const item of items) {
                    const typeTag = item.type ? `[${item.type}]` : "";
                    lines.push(`- ID: ${item.id} ${typeTag}\n  Content: ${item.content}`);
                }
                ctx.addLine({
                    type: "system",
                    content: lines.join("\n"),
                    timestamp: Date.now(),
                });
            }
            catch (err) {
                ctx.addLine({
                    type: "error",
                    content: `Failed to retrieve memories: ${err.message}`,
                    timestamp: Date.now(),
                });
            }
            return;
        }
        if (subcommand === "search") {
            const query = parts.slice(1).join(" ");
            if (!query) {
                ctx.addLine({
                    type: "error",
                    content: "Usage: /memory search <query>",
                    timestamp: Date.now(),
                });
                return;
            }
            ctx.addLine({
                type: "system",
                content: `Searching memories for: "${query}"...`,
                timestamp: Date.now(),
            });
            try {
                const res = await client.searchAtomic({ query, limit: 5 });
                const items = res.items || [];
                if (items.length === 0) {
                    ctx.addLine({
                        type: "system",
                        content: "No matching memories found.",
                        timestamp: Date.now(),
                    });
                    return;
                }
                const lines = [`=== Search Results for: "${query}" ===`];
                for (const item of items) {
                    const typeTag = item.type ? `[${item.type}]` : "";
                    lines.push(`- ID: ${item.id} ${typeTag}\n  Content: ${item.content}\n  Score: ${item.score?.toFixed(4) || "N/A"}`);
                }
                ctx.addLine({
                    type: "system",
                    content: lines.join("\n"),
                    timestamp: Date.now(),
                });
            }
            catch (err) {
                ctx.addLine({
                    type: "error",
                    content: `Memory search failed: ${err.message}`,
                    timestamp: Date.now(),
                });
            }
            return;
        }
        if (subcommand === "add") {
            const argsText = parts.slice(1).join(" ");
            const matches = argsText.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
            const key = matches[0]?.replace(/"/g, "");
            const value = matches[1]?.replace(/"/g, "");
            const type = matches[2]?.replace(/"/g, "") || "preference";
            if (!key || !value) {
                ctx.addLine({
                    type: "error",
                    content: "Usage: /memory add <key> <value> [type]\nExample: /memory add user-name \"John Doe\" preference",
                    timestamp: Date.now(),
                });
                return;
            }
            ctx.addLine({
                type: "system",
                content: `Saving memory "${key}"...`,
                timestamp: Date.now(),
            });
            try {
                const res = await client.updateAtomic({ id: key, content: value, type, upsert: true });
                ctx.addLine({
                    type: "system",
                    content: `✓ Memory saved successfully.\n  ID: ${res.id}\n  Type: ${type}\n  Updated: ${new Date(res.updated_at).toLocaleString()}`,
                    timestamp: Date.now(),
                });
            }
            catch (err) {
                ctx.addLine({
                    type: "error",
                    content: `Failed to save memory: ${err.message}`,
                    timestamp: Date.now(),
                });
            }
            return;
        }
        if (subcommand === "delete") {
            const key = parts[1];
            if (!key) {
                ctx.addLine({
                    type: "error",
                    content: "Usage: /memory delete <key>",
                    timestamp: Date.now(),
                });
                return;
            }
            ctx.addLine({
                type: "system",
                content: `Deleting memory "${key}"...`,
                timestamp: Date.now(),
            });
            try {
                await client.deleteAtomic({ ids: [key] });
                ctx.addLine({
                    type: "system",
                    content: `✓ Memory "${key}" deleted successfully.`,
                    timestamp: Date.now(),
                });
            }
            catch (err) {
                ctx.addLine({
                    type: "error",
                    content: `Failed to delete memory: ${err.message}`,
                    timestamp: Date.now(),
                });
            }
            return;
        }
        const helpLines = [
            "Usage: /memory <subcommand> [args]",
            "",
            "Subcommands:",
            "  /memory status           Check the connection status of the TencentDB Memory gateway",
            "  /memory list             List all long-term structured memories (L1)",
            "  /memory search <query>   Perform a vector search through your long-term memories",
            "  /memory add <id> <val>   Save or overwrite a long-term structured memory",
            "  /memory delete <id>      Delete a specific long-term structured memory",
            "  /memory help             Show this help menu",
        ];
        ctx.addLine({
            type: "system",
            content: helpLines.join("\n"),
            timestamp: Date.now(),
        });
    },
};
registry.register(memoryCommand);
//# sourceMappingURL=memoryCommand.js.map