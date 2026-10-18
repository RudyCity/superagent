import { Tool } from "./types.js";
import { getRMemoryClient, getRMemoryDiagnostics, getRMemoryProjectId } from "../rmemoryUtil.js";
import { createMemoryRecordMetadata } from "../memoryRecord.js";

// Helper to get MemoryClient using the active global settings
function getClient() {
  return getRMemoryClient(5000); // 5 seconds timeout for tools
}

function formatError(err: unknown): string {
  return (err as Error).message || String(err);
}

function safeMemoryMetadata(metadata: Record<string, any> = {}): Record<string, unknown> {
  const provenance = metadata.provenance && typeof metadata.provenance === "object" ? metadata.provenance as Record<string, unknown> : {};
  return {
    ...(metadata.schemaVersion !== undefined ? { schemaVersion: metadata.schemaVersion } : {}),
    ...(metadata.memoryId ? { memoryId: String(metadata.memoryId).slice(0, 160) } : {}),
    ...(metadata.memoryType ? { memoryType: metadata.memoryType } : {}),
    ...(metadata.scope ? { scope: metadata.scope } : {}),
    ...(metadata.projectId ? { projectId: metadata.projectId } : {}),
    ...(metadata.sessionId ? { sessionId: String(metadata.sessionId).slice(0, 128) } : {}),
    ...(metadata.taskId ? { taskId: String(metadata.taskId).slice(0, 128) } : {}),
    ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
    ...(metadata.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
    ...(metadata.validationStatus ? { validationStatus: metadata.validationStatus } : {}),
    ...(Array.isArray(metadata.evidence) ? { evidence: metadata.evidence.slice(0, 10).flatMap((entry: unknown) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.kind !== "string") return [];
      return [{
        id: item.id.slice(0, 160),
        kind: item.kind.slice(0, 24),
        ...(typeof item.status === "string" ? { status: item.status.slice(0, 32) } : {}),
      }];
    }) } : {}),
    ...(provenance.source || provenance.agentTier || provenance.sessionId || provenance.taskId ? { provenance: {
      ...(provenance.source ? { source: provenance.source } : {}),
      ...(provenance.agentTier ? { agentTier: provenance.agentTier } : {}),
      ...(provenance.sessionId ? { sessionId: provenance.sessionId } : {}),
      ...(provenance.taskId ? { taskId: provenance.taskId } : {}),
    } } : {}),
  };
}

const canManagePersistentMemory = (tier: unknown): boolean => tier === "master" || tier === "superagent" || tier === "single";

export const rmemoryStatusTool: Tool = {
  name: "rmemory_status",
  description: "Read-only diagnostic for the configured RMemory provider, embedding model/dimensions, local index readiness, migration state, and safe degraded-mode status. Never returns API keys or filesystem paths.",
  parameters: { type: "object", properties: {}, required: [] },
  async execute() {
    try {
      return JSON.stringify(getRMemoryDiagnostics(), null, 2);
    } catch {
      return JSON.stringify({
        initializationState: "degraded",
        degraded: true,
        retryAvailable: true,
        error: "RMemory diagnostics could not be read safely.",
      }, null, 2);
    }
  },
};

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
        description: "Compatibility field. Search always returns only the active workspace project's memories plus explicitly global memories; it never expands to other projects.",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd) {
    const query = String(args.query || "");
    const limit = Number(args.limit) || 5;
    const projectId = getRMemoryProjectId(cwd);
    const client = getClient();

    try {
      const res = await client.searchAtomic({ query, limit: limit * 2, projectId });
      if (!res.items || res.items.length === 0) {
        return "No memories found matching the query.";
      }

      const items = res.items.filter((item) => {
        const scope = item.metadata?.scope;
        if (scope === "global" || (!scope && item.content.startsWith("[global]"))) return true;
        if (scope === "project" && item.metadata?.projectId === projectId) return true;
        return !scope && item.content.startsWith(`[project:${projectId}]`);
      }).slice(0, limit);
      if (items.length === 0) {
        return "No workspace memories found matching the query.";
      }

      return items
        .map((item) => {
          const metadata = item.metadata || {};
          const provenance = metadata.provenance && typeof metadata.provenance === "object"
            ? metadata.provenance as Record<string, unknown>
            : {};
          const details = [
            metadata.scope ? `scope=${String(metadata.scope)}` : undefined,
            metadata.projectId ? `projectId=${String(metadata.projectId)}` : undefined,
            metadata.schemaVersion ? `schemaVersion=${String(metadata.schemaVersion)}` : undefined,
            metadata.validationStatus ? `validation=${String(metadata.validationStatus)}` : undefined,
            metadata.updatedAt ? `updatedAt=${String(metadata.updatedAt)}` : undefined,
            provenance.source ? `source=${String(provenance.source)}` : undefined,
          ].filter(Boolean).join(", ");
          return `- [${item.type || "memory"}] ${item.content}${details ? ` (metadata: ${details})` : ""}`;
        })
        .join("\n");
    } catch (err) {
      return `Memory search failed: ${formatError(err)}. Make sure the RMemory system is initialized.`;
    }
  },
};

export const rmemoryInspectTool: Tool = {
  name: "rmemory_inspect",
  description: "Inspect one atomic memory by logical ID in the active project or explicit global scope. Defaults to active project and never returns another project's records.",
  parameters: { type: "object", properties: {
    id: { type: "string", description: "Logical memory ID to inspect." },
    scope: { type: "string", enum: ["project", "global"], description: "Memory scope; defaults to active project." },
  }, required: ["id"] },
  async execute(args, cwd) {
    const id = String(args.id || "").trim();
    if (!id) return "Error: memory id is required.";
    const scope = args.scope === "global" ? "global" : "project";
    try {
      const item = await getClient().inspectAtomic({ id, scope, projectId: getRMemoryProjectId(cwd) });
      if (!item) return `No ${scope}-scope memory found for ID: ${id}`;
      return JSON.stringify({ id: item.id, content: item.content, scope: item.scope, metadata: safeMemoryMetadata(item.metadata) }, null, 2);
    } catch (err) { return `Memory inspection failed: ${formatError(err)}.`; }
  },
};

export const rmemoryExportTool: Tool = {
  name: "rmemory_export",
  description: "Export a bounded JSON snapshot of active-project atomic memories and explicitly global memories. Excludes other projects, raw conversations, skills and vector embeddings.",
  parameters: { type: "object", properties: {
    limit: { type: "number", description: "Maximum records (default 100, maximum 500)." },
    includeGlobal: { type: "boolean", description: "Include global memories (default true)." },
  }, required: [] },
  async execute(args, cwd) {
    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();
    if (!canManagePersistentMemory(currentAgent?.tier)) return "Error: rmemory_export is restricted to Master, Superagent, and single-agent tiers.";
    try {
      const snapshot = await getClient().exportAtomic({ projectId: getRMemoryProjectId(cwd), includeGlobal: args.includeGlobal !== false, limit: Number(args.limit) || 100 });
      return JSON.stringify({ ...snapshot, items: snapshot.items.map((item) => ({ id: item.id, content: item.content, scope: item.scope, metadata: safeMemoryMetadata(item.metadata) })) }, null, 2);
    } catch (err) { return `Memory export failed: ${formatError(err)}.`; }
  },
};

export const rmemoryDeleteTool: Tool = {
  name: "rmemory_delete",
  description: "Delete one atomic memory in project or explicit global scope. Requires interactive owner confirmation; headless/non-interactive calls fail closed.",
  parameters: { type: "object", properties: {
    id: { type: "string", description: "Logical memory ID to delete." },
    scope: { type: "string", enum: ["project", "global"], description: "Memory scope; defaults to active project." },
  }, required: ["id"] },
  async execute(args, cwd) {
    const id = String(args.id || "").trim();
    if (!id) return "Error: memory id is required.";
    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();
    if (!canManagePersistentMemory(currentAgent?.tier)) return "Error: rmemory_delete is restricted to Master, Superagent, and single-agent tiers.";
    const askQuestion = (currentAgent as any)?.onQuestion;
    if (typeof askQuestion !== "function") return "Error: deletion requires an interactive owner confirmation; no record was changed.";
    const scope = args.scope === "global" ? "global" : "project";
    let answer: unknown;
    try { answer = await askQuestion(`Permanently delete ${scope}-scope memory "${id}"?`, ["Yes", "No"]); }
    catch { return "Error: deletion confirmation was unavailable; no record was changed."; }
    if (answer !== "Yes") return "Memory deletion cancelled; no record was changed.";
    try {
      const deleted = await getClient().deleteAtomicScoped({ id, scope, projectId: getRMemoryProjectId(cwd) });
      return deleted ? `Deleted ${scope}-scope memory "${id}".` : `No ${scope}-scope memory found for ID: ${id}; nothing was deleted.`;
    } catch (err) { return `Memory deletion failed: ${formatError(err)}.`; }
  },
};
export const rmemoryMigrateLegacyTool: Tool = {
  name: "rmemory_migrate_legacy",
  description: "Preview or migrate legacy atomic memories only when an exact [global] or [project:<canonical-project-id>] prefix proves scope. Read-only preview is the default; changes require interactive owner confirmation. Ambiguous records and conflicts are preserved.",
  parameters: { type: "object", properties: {
    dryRun: { type: "boolean", description: "Preview only (default true). Set false to request a confirmed migration." },
    includeGlobal: { type: "boolean", description: "Include clearly marked global memories (default true)." },
    limit: { type: "number", description: "Maximum candidate records to inspect (default 100, maximum 500)." },
  }, required: [] },
  async execute(args, cwd) {
    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();
    if (!canManagePersistentMemory(currentAgent?.tier)) return "Error: legacy memory migration is restricted to Master, Superagent, and single-agent tiers.";
    const options = { projectId: getRMemoryProjectId(cwd), includeGlobal: args.includeGlobal !== false, limit: Number(args.limit) || 100 };
    try {
      if (args.dryRun !== false) {
        const preview = await getClient().migrateLegacyAtomicMemories({ ...options, dryRun: true });
        return JSON.stringify({ mode: "preview_only", ...preview }, null, 2);
      }

      const preview = await getClient().migrateLegacyAtomicMemories({ ...options, dryRun: true });
      if (preview.candidates === 0) return JSON.stringify({ mode: "migration", ...preview, message: "No confidently scoped legacy records need migration." }, null, 2);
      const askQuestion = (currentAgent as any)?.onQuestion;
      if (typeof askQuestion !== "function") return "Error: migration requires interactive owner confirmation; no records were changed.";
      let answer: unknown;
      try {
        answer = await askQuestion("Migrate up to " + preview.candidates + " legacy memory record(s) for the active project? Ambiguous records and conflicts will be preserved.", ["Yes", "No"]);
      } catch {
        return "Error: migration confirmation was unavailable; no records were changed.";
      }
      if (answer !== "Yes") return "Legacy memory migration cancelled; no records were changed.";

      const result = await getClient().migrateLegacyAtomicMemories({ ...options, dryRun: false });
      return JSON.stringify({ mode: "migration", ...result }, null, 2);
    } catch (err) {
      return "Legacy memory migration failed: " + formatError(err) + ".";
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
        description: "Defaults to true and restricts search to the active workspace project. Set false only when you explicitly need conversation history across projects.",
      },
    },
    required: ["query"],
  },
  async execute(args, cwd) {
    const query = String(args.query || "");
    const limit = Number(args.limit) || 5;
    const projectOnly = args.projectOnly !== false;
    const projectId = getRMemoryProjectId(cwd);
    const client = getClient();

    try {
      const res = await client.searchConversation({ query, limit: limit * 2, ...(projectOnly ? { projectId } : {}) });
      if (!res.messages || res.messages.length === 0) {
        return "No matching conversation history found.";
      }

      let messages = res.messages;
      if (projectOnly) {
        messages = messages.filter((message) => message.project_id === projectId);
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

    // Tier guard (audit fix M4): only Master Agent and Superagent may
    // write to long-term rmemory. Subagents MUST be read-only so a
    // single subagent cannot poison the L1 atomic-memory store.
    // The toolset already filters these tools out of subagent
    // definitions; this is the runtime belt-and-suspenders check.
    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();
    if (
      currentAgent &&
      currentAgent.tier !== "master" &&
      currentAgent.tier !== "superagent" &&
      currentAgent.tier !== "single"
    ) {
      return `Error: rmemory_save is restricted to Master, Superagent, and single-agent tiers. Current tier: ${currentAgent.tier}. Return findings to your parent Superagent and let it decide what to persist.`;
    }

    const client = getClient();

    const projectId = getRMemoryProjectId(cwd);
    const scopePrefix = scope === "global" ? "[global]" : `[project:${projectId}]`;
    const contentWithoutCallerScope = rawContent.replace(/^\[(?:global|project(?::[^\]]+)?)\]\s*/i, "");
    const content = `${scopePrefix} ${contentWithoutCallerScope}`;

    try {
      const now = new Date().toISOString();
      const metadata = createMemoryRecordMetadata({
        memoryId: id,
        memoryType: type || "fact",
        scope,
        projectId,
        source: "rmemory_save",
        agentTier: currentAgent?.tier || "unknown",
        sessionId: currentAgent?.sessionId,
        now,
      });
      const res = await client.updateAtomic({ id, content, metadata });
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
  async execute(args, cwd) {
    const sessionId = String(args.session_id || "");
    const role = String(args.role || "") as "user" | "assistant" | "system";
    const rawContent = String(args.content || "").trim();
    const content = rawContent.length > 0 ? rawContent : "[empty message]";

    // Tier guard (audit fix M4): only Master Agent and Superagent may
    // add to conversation history. Subagents MUST be read-only so a
    // single subagent cannot pollute cross-session L0 history. The
    // toolset already filters these tools out of subagent definitions;
    // this is the runtime belt-and-suspenders check.
    const { agentLocalStorage } = await import("../agent.js");
    const currentAgent = agentLocalStorage.getStore();
    if (
      currentAgent &&
      currentAgent.tier !== "master" &&
      currentAgent.tier !== "superagent" &&
      currentAgent.tier !== "single"
    ) {
      return `Error: rmemory_conversation_add is restricted to Master, Superagent, and single-agent tiers. Current tier: ${currentAgent.tier}.`;
    }

    const client = getClient();

    try {
      const res = await client.addConversation({
        session_id: sessionId,
        projectId: getRMemoryProjectId(cwd),
        messages: [{ role, content, timestamp: new Date().toISOString() }],
      });
      return `Conversation message added. Accepted IDs: ${res.accepted_ids.join(", ")}. Total messages in session: ${res.total_count}`;
    } catch (err) {
      return `Failed to add conversation message: ${formatError(err)}. Make sure RMemory is initialized.`;
    }
  },
};