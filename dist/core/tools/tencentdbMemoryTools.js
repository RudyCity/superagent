import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts";
import { getSettings } from "../config.js";
// Helper to get MemoryClient using the active global settings
function getClient() {
    const settings = getSettings();
    const endpoint = settings.tencentdbGatewayUrl || "http://127.0.0.1:8420";
    const apiKey = settings.tencentdbGatewayApiKey || "sk-xxxx";
    const serviceId = settings.tencentdbServiceId || "default";
    return new MemoryClient({
        endpoint,
        apiKey,
        serviceId,
    });
}
export const tdaiMemorySearchTool = {
    name: "tdai_memory_search",
    description: "Search through the user's long-term structured memories (L1). Use this to recall specific facts, user preferences, instructions, or context from previous conversations.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query text describing what you want to recall.",
            },
            limit: {
                type: "number",
                description: "Maximum number of results to return (default: 5).",
            },
        },
        required: ["query"],
    },
    async execute(args) {
        const query = String(args.query || "");
        const limit = Number(args.limit) || 5;
        const client = getClient();
        try {
            const res = await client.searchAtomic({ query, limit });
            if (!res.items || res.items.length === 0) {
                return "No memories found matching the query.";
            }
            return res.items
                .map((item) => `- [${item.type || "memory"}] ${item.content}`)
                .join("\n");
        }
        catch (err) {
            return `Memory search failed: ${err.message}. Make sure the TencentDB memory gateway is running on the configured port.`;
        }
    },
};
export const tdaiConversationSearchTool = {
    name: "tdai_conversation_search",
    description: "Search raw past conversation history (L0). Use this to find specific messages, exact words, or dialogue details that the user said previously.",
    parameters: {
        type: "object",
        properties: {
            query: {
                type: "string",
                description: "Search query describing what conversation content you want to find.",
            },
            limit: {
                type: "number",
                description: "Maximum number of messages to return (default: 5).",
            },
        },
        required: ["query"],
    },
    async execute(args) {
        const query = String(args.query || "");
        const limit = Number(args.limit) || 5;
        const client = getClient();
        try {
            const res = await client.searchConversation({ query, limit });
            if (!res.messages || res.messages.length === 0) {
                return "No matching conversation history found.";
            }
            return res.messages
                .map((m) => `[${m.timestamp || "unknown"}] ${m.role}: ${m.content}`)
                .join("\n\n");
        }
        catch (err) {
            return `Conversation search failed: ${err.message}. Make sure the TencentDB memory gateway is running on the configured port.`;
        }
    },
};
export const tdaiReadCosTool = {
    name: "tdai_read_cos",
    description: "Read a scenario file details (L2 index) using a path from Scene Navigation (e.g. 'scene_blocks/xxx.md').",
    parameters: {
        type: "object",
        properties: {
            path: {
                type: "string",
                description: "Relative file path of the scenario block, e.g., 'scene_blocks/coding-style.md'.",
            },
        },
        required: ["path"],
    },
    async execute(args) {
        const filePath = String(args.path || "");
        const client = getClient();
        try {
            const content = await client.readFile(filePath);
            return `=== File: ${filePath} ===\n\n${content}`;
        }
        catch (err) {
            return `Failed to read scenario block file: ${err.message}. Make sure the path is correct and the gateway is running.`;
        }
    },
};
//# sourceMappingURL=tencentdbMemoryTools.js.map