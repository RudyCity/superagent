import path from "path";
import { Tool } from "./types.js";
import { getRMemoryClient } from "../rmemoryUtil.js";
import { getNormalizedProjectPath } from "./helpers.js";

// Helper to get MemoryClient using the active global settings
function getClient() {
  return getRMemoryClient(5000); // 5 seconds timeout for tools
}

function formatError(err: unknown): string {
  return (err as Error).message || String(err);
}

export const rmemorySearchTool: Tool = {
  name: "rmemory_search",
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
      projectOnly: {
        type: "boolean",
        description: "If true, restricts search results to the active workspace project.",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd) {
    const query = String(args.query || "");
    const limit = Number(args.limit) || 5;
    const projectOnly = Boolean(args.projectOnly);
    const activeProjectPath = getNormalizedProjectPath(cwd || process.cwd());
    const projectName = path.basename(activeProjectPath);
    const client = getClient();

    try {
      const searchQuery = projectOnly ? `[project:${projectName}] ${query}` : query;
      const res = await client.searchAtomic({ query: searchQuery, limit: limit * 2 });
      if (!res.items || res.items.length === 0) {
        return "No memories found matching the query.";
      }

      let items = res.items;
      if (projectOnly) {
        items = items.filter((item) => item.content.includes(`[project:${projectName}]`) || item.content.includes("[global]"));
      } else {
        items.sort((a, b) => {
          const aIsProject = a.content.includes(`[project:${projectName}]`) || a.content.includes("[global]");
          const bIsProject = b.content.includes(`[project:${projectName}]`) || b.content.includes("[global]");
          if (aIsProject && !bIsProject) return -1;
          if (!aIsProject && bIsProject) return 1;
          return 0;
        });
      }

      items = items.slice(0, limit);
      if (items.length === 0) {
        return "No workspace memories found matching the query.";
      }

      return items
        .map((item) => `- [${item.type || "memory"}] ${item.content}`)
        .join("\n");
    } catch (err) {
      return `Memory search failed: ${formatError(err)}. Make sure the RMemory system is initialized.`;
    }
  },
};

export const rmemoryConversationSearchTool: Tool = {
  name: "rmemory_conversation_search",
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
      projectOnly: {
        type: "boolean",
        description: "If true, restricts conversation search results to the active workspace project.",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd) {
    const query = String(args.query || "");
    const limit = Number(args.limit) || 5;
    const projectOnly = Boolean(args.projectOnly);
    const activeProjectPath = getNormalizedProjectPath(cwd || process.cwd());
    const projectName = path.basename(activeProjectPath);
    const client = getClient();

    try {
      const searchQuery = projectOnly ? `${projectName} ${query}` : query;
      const res = await client.searchConversation({ query: searchQuery, limit: limit * 2 });
      if (!res.messages || res.messages.length === 0) {
        return "No matching conversation history found.";
      }

      let messages = res.messages;
      if (projectOnly) {
        messages = messages.filter((m) => m.content.toLowerCase().includes(projectName.toLowerCase()));
      } else {
        messages.sort((a, b) => {
          const aMatch = a.content.toLowerCase().includes(projectName.toLowerCase());
          const bMatch = b.content.toLowerCase().includes(projectName.toLowerCase());
          if (aMatch && !bMatch) return -1;
          if (!aMatch && bMatch) return 1;
          return 0;
        });
      }

      messages = messages.slice(0, limit);
      if (messages.length === 0) {
        return "No matching workspace conversation history found.";
      }

      return messages
        .map((m) => {
          const dateStr = m.timestamp ? new Date(m.timestamp).toLocaleString() : "unknown";
          return `[${dateStr}] ${m.role}: ${m.content}`;
        })
        .join("\n----------------------------------------------------------------------\n");
    } catch (err) {
      return `Conversation search failed: ${formatError(err)}. Make sure the RMemory system is initialized.`;
    }
  },
};

export const rmemoryReadCosTool: Tool = {
  name: "rmemory_read_cos",
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
      const res = await client.readScenario({ path: filePath });
      if (!res || res.content === null) {
        return `Failed to read scenario block file: File not found: ${filePath}`;
      }
      return `----------------------------------------------------------------------\nSCENARIO BLOCK FILE: ${filePath}\n----------------------------------------------------------------------\n\n${res.content}\n----------------------------------------------------------------------`;
    } catch (err) {
      return `Failed to read scenario block file: ${formatError(err)}. Make sure the path is correct and RMemory is initialized.`;
    }
  },
};

export const rmemorySaveTool: Tool = {
  name: "rmemory_save",
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
      return `Failed to save memory: ${formatError(err)}. Make sure RMemory is initialized.`;
    }
  },
};

export const rmemoryConversationAddTool: Tool = {
  name: "rmemory_conversation_add",
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
    const rawContent = String(args.content || "").trim();
    const content = rawContent.length > 0 ? rawContent : "[empty message]";
    const client = getClient();

    try {
      const res = await client.addConversation({
        session_id: sessionId,
        messages: [{ role, content, timestamp: new Date().toISOString() }],
      });
      return `Conversation message added. Accepted IDs: ${res.accepted_ids.join(", ")}. Total messages in session: ${res.total_count}`;
    } catch (err) {
      return `Failed to add conversation message: ${formatError(err)}. Make sure RMemory is initialized.`;
    }
  },
};