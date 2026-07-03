import { Tool } from "./types.js";
import { getTencentDBClient } from "../tencentdbUtil.js";

// Helper to get MemoryClient using the active global settings
function getClient() {
  return getTencentDBClient(5000); // 5 seconds timeout for tools
}

function formatError(err: unknown): string {
  return (err as Error).message || String(err);
}

export const tdaiMemorySearchTool: Tool = {
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
    } catch (err) {
      return `Memory search failed: ${formatError(err)}. Make sure the TencentDB memory gateway is running on the configured port.`;
    }
  },
};

export const tdaiConversationSearchTool: Tool = {
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
    } catch (err) {
      return `Conversation search failed: ${formatError(err)}. Make sure the TencentDB memory gateway is running on the configured port.`;
    }
  },
};

export const tdaiReadCosTool: Tool = {
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
    } catch (err) {
      return `Failed to read scenario block file: ${formatError(err)}. Make sure the path is correct and the gateway is running.`;
    }
  },
};

export const tdaiMemorySaveTool: Tool = {
  name: "tdai_memory_save",
  description: "Save a structured atomic memory (L1) to long-term storage. Specify scope as 'project' (default, workspace-specific) or 'global' (universal preference).",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Unique identifier for this memory. Use a semantic ID like 'user-name' or 'project-framework'. Reusing an existing ID overwrites that memory.",
      },
      content: {
        type: "string",
        description: "The content of the memory to save. Should be a concise factual statement.",
      },
      type: {
        type: "string",
        description: "Optional type/category for the memory (e.g. 'preference', 'fact', 'context', 'decision').",
      },
      scope: {
        type: "string",
        enum: ["project", "global"],
        description: "Scope of the memory. 'project' (default) isolates memory to current workspace. 'global' applies universally.",
      },
    },
    required: ["id", "content"],
  },
  async execute(args, cwd) {
    const id = String(args.id || "");
    const rawContent = String(args.content || "");
    const type = args.type ? String(args.type) : undefined;
    const scope = args.scope === "global" ? "global" : "project";
    const client = getClient();

    const scopePrefix = scope === "global" ? "[global]" : `[project]`;
    const content = rawContent.startsWith("[global]") || rawContent.startsWith("[project")
      ? rawContent
      : `${scopePrefix} ${rawContent}`;

    try {
      const res = await client.updateAtomic({ id, content });
      return `Memory saved successfully (${scope} scope). ID: ${res.id}, updated at: ${res.updated_at}`;
    } catch (err) {
      return `Failed to save memory: ${formatError(err)}. Make sure the TencentDB memory gateway is running.`;
    }
  },
};

export const tdaiConversationAddTool: Tool = {
  name: "tdai_conversation_add",
  description: "Record a conversation message (L0) into the conversation history store. Use to log exchanges for future context retrieval.",
  parameters: {
    type: "object",
    properties: {
      session_id: {
        type: "string",
        description: "Session identifier to group related messages.",
      },
      role: {
        type: "string",
        enum: ["user", "assistant", "system"],
        description: "Who sent the message.",
      },
      content: {
        type: "string",
        description: "The message content.",
      },
    },
    required: ["session_id", "role", "content"],
  },
  async execute(args) {
    const sessionId = String(args.session_id || "");
    const role = String(args.role || "") as "user" | "assistant" | "system";
    const content = String(args.content || "");
    const client = getClient();

    try {
      const res = await client.addConversation({
        session_id: sessionId,
        messages: [{ role, content, timestamp: new Date().toISOString() }],
      });
      return `Conversation message added. Accepted IDs: ${res.accepted_ids.join(", ")}. Total messages in session: ${res.total_count}`;
    } catch (err) {
      return `Failed to add conversation message: ${formatError(err)}. Make sure the TencentDB memory gateway is running.`;
    }
  },
};