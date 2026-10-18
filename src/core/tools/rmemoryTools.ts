import { createHash } from "node:crypto";
import { Tool } from "./types.js";
import { getRMemoryClient, getRMemoryDiagnostics, getRMemoryProjectId } from "../rmemoryUtil.js";
import { createMemoryRecordMetadata } from "../memoryRecord.js";
import { assessMemoryFreshness, previewMemoryRetention, detectScopedMemoryConflicts } from "../memoryLifecycle.js";

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
    ...(metadata.reviewState ? { reviewState: metadata.reviewState } : {}),
    ...(metadata.lifecycleState ? { lifecycleState: metadata.lifecycleState } : {}),
    ...(metadata.retentionClass ? { retentionClass: metadata.retentionClass } : {}),
    ...(metadata.assertionKey ? { assertionKey: String(metadata.assertionKey).slice(0, 160) } : {}),
    ...(metadata.lastVerifiedAt ? { lastVerifiedAt: metadata.lastVerifiedAt } : {}),
    ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
    ...(metadata.reviewedAt ? { reviewedAt: metadata.reviewedAt } : {}),
    ...(metadata.reviewedBy ? { reviewedBy: String(metadata.reviewedBy).slice(0, 128) } : {}),
    ...(metadata.quarantineReason ? { quarantineReason: String(metadata.quarantineReason).slice(0, 240) } : {}),
    ...(Array.isArray(metadata.conflictWithMemoryIds) ? { conflictWithMemoryIds: metadata.conflictWithMemoryIds.slice(0, 20) } : {}),
    ...(metadata.conflictDetectedAt ? { conflictDetectedAt: metadata.conflictDetectedAt } : {}),
    ...(metadata.conflictDetectedBy ? { conflictDetectedBy: String(metadata.conflictDetectedBy).slice(0, 128) } : {}),
    ...(metadata.conflictReason ? { conflictReason: String(metadata.conflictReason).slice(0, 240) } : {}),
    ...(metadata.supersedesMemoryId ? { supersedesMemoryId: String(metadata.supersedesMemoryId).slice(0, 160) } : {}),
    ...(metadata.supersededByMemoryId ? { supersededByMemoryId: String(metadata.supersededByMemoryId).slice(0, 160) } : {}),
    ...(metadata.supersededAt ? { supersededAt: metadata.supersededAt } : {}),
    ...(metadata.revisionNumber !== undefined ? { revisionNumber: metadata.revisionNumber } : {}),
    ...(metadata.mappedFromLegacyId ? { mappedFromLegacyId: String(metadata.mappedFromLegacyId).slice(0, 160) } : {}),
    ...(metadata.mappedAt ? { mappedAt: metadata.mappedAt } : {}),
    ...(metadata.mappingReason ? { mappingReason: String(metadata.mappingReason).slice(0, 200) } : {}),
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

      const scopedItems = res.items.filter((item) => {
        const scope = item.metadata?.scope;
        if (scope === "global" || (!scope && item.content.startsWith("[global]"))) return true;
        if (scope === "project" && item.metadata?.projectId === projectId) return true;
        return !scope && item.content.startsWith(`[project:${projectId}]`);
      });
      const candidateConflicts = detectScopedMemoryConflicts(scopedItems
        .filter((item) => item.metadata?.type !== "message" && !item.metadata?.session)
        .map((item) => ({ id: String(item.id), content: item.content, scope: item.metadata?.scope, metadata: item.metadata || {} })));
      const conflictingMemoryIds = new Set(candidateConflicts.flatMap(conflict => conflict.memoryIds));
      const items = scopedItems.filter((item) => !conflictingMemoryIds.has(String(item.id))
        && assessMemoryFreshness({ id: String(item.id), content: item.content, metadata: item.metadata || {} }).shouldInject).slice(0, limit);
      const withheld = scopedItems.length - items.length;
      if (items.length === 0) {
        return withheld > 0
          ? `No eligible current memories matched the query; ${withheld} scoped record(s) were withheld, including ${candidateConflicts.length} explicit same-key conflict pair(s). Inspect the records and use rmemory_review before relying on either assertion.`
          : "No workspace memories found matching the query.";
      }
      const rendered = items.map((item) => {
        const metadata = item.metadata || {};
        const provenance = metadata.provenance && typeof metadata.provenance === "object" ? metadata.provenance as Record<string, unknown> : {};
        const details = [
          metadata.scope ? `scope=${String(metadata.scope)}` : undefined,
          metadata.projectId ? `projectId=${String(metadata.projectId)}` : undefined,
          metadata.schemaVersion ? `schemaVersion=${String(metadata.schemaVersion)}` : undefined,
          metadata.validationStatus ? `validation=${String(metadata.validationStatus)}` : undefined,
          metadata.updatedAt ? `updatedAt=${String(metadata.updatedAt)}` : undefined,
          provenance.source ? `source=${String(provenance.source)}` : undefined,
        ].filter(Boolean).join(", ");
        return `- [${item.type || "memory"}] ${item.content}${details ? ` (metadata: ${details})` : ""}`;
      }).join(String.fromCharCode(10));
      const qualityNote = `[Recall quality] ${withheld} scoped record(s) were withheld due to stale/expired/rejected/superseded/quarantined state or ${candidateConflicts.length} explicit same-key conflict pair(s).`;
      return withheld > 0 ? `${rendered}${String.fromCharCode(10)}${String.fromCharCode(10)}${qualityNote}` : rendered;
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
    if (!canManagePersistentMemory(currentAgent?.tier)) return "Error: rmemory_export is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier).";
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
    if (!canManagePersistentMemory(currentAgent?.tier)) return "Error: rmemory_delete is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier).";
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
    if (!canManagePersistentMemory(currentAgent?.tier)) return "Error: legacy memory migration is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier).";
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
      assertionKey: { type: "string", description: "Optional owner-defined stable assertion key for conflict review. Similarity alone is never treated as proof of conflict." },
      retentionClass: { type: "string", enum: ["durable", "temporary", "environment", "decision", "task-summary"], description: "Optional type-aware freshness class; durable memories are not aged out by default." },
      expiresAt: { type: "string", description: "Optional explicit expiration timestamp in ISO 8601 form." },
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
      return `Error: rmemory_save is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier). Current tier: ${currentAgent.tier}. Return findings to your parent Superagent and let it decide what to persist.`;
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
        existingMetadata: {
          ...(typeof args.assertionKey === "string" && args.assertionKey.trim() ? { assertionKey: args.assertionKey.trim().slice(0, 160) } : {}),
          ...(typeof args.retentionClass === "string" ? { retentionClass: args.retentionClass } : {}),
          ...(typeof args.expiresAt === "string" ? { expiresAt: args.expiresAt } : {}),
        },
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
      return `Error: rmemory_conversation_add is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier). Current tier: ${currentAgent.tier}.`;
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
export const rmemoryReviseTool: Tool = {
  name: "rmemory_revise",
  description: "Owner-controlled, scope-checked revision workflow for atomic memory. Preview first; apply and restore use optimistic updatedAt tokens, interactive confirmation, preserved history, and verified rollback. Legacy/ambiguous records require migration before revision.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["preview", "apply", "history", "restore"], description: "Preview proposed content, confirm/apply a revision, list history, or restore a historical version." },
    id: { type: "string", description: "Logical memory ID." },
    content: { type: "string", description: "Proposed content for preview/apply." },
    scope: { type: "string", enum: ["project", "global"], description: "Scope; defaults to active project." },
    expectedUpdatedAt: { type: "string", description: "Exact updatedAt token returned by preview or inspect; required for apply/restore." },
    revisionId: { type: "string", description: "Revision ID from history; required for restore." },
    reason: { type: "string", description: "Short owner-provided reason for this revision." },
    limit: { type: "number", description: "Maximum history entries (default 20, maximum 100)." },
  }, required: ["action", "id"] },
  async execute(args, cwd) {
    const { agentLocalStorage } = await import("../agent.js");
    const actor = agentLocalStorage.getStore();
    if (!canManagePersistentMemory(actor?.tier)) return "Error: memory revision is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier).";
    const id = String(args.id || "").trim();
    const action = String(args.action || "preview");
    const scope: "project" | "global" = args.scope === "global" ? "global" : "project";
    const options = { id, scope, projectId: getRMemoryProjectId(cwd) };
    if (!id) return "Error: memory id is required.";
    const client = getClient();
    try {
      if (action === "history") {
        const items = await client.listAtomicRevisions({ ...options, limit: Number(args.limit) || 20 });
        return JSON.stringify({ id, scope, count: items.length, revisions: items.map(item => ({ revisionId: item.revisionId, revisionNumber: item.revisionNumber, revisionCreatedAt: item.revisionCreatedAt, sourceUpdatedAt: item.sourceUpdatedAt, content: item.content.slice(0, 4000), metadata: safeMemoryMetadata(item.metadata) })) }, null, 2);
      }
      const ask = typeof (actor as any)?.onQuestion === "function" ? (actor as any).onQuestion : null;
      if (action === "preview" || action === "apply") {
        if (typeof args.content !== "string" || !args.content.trim()) return "Error: content is required for preview/apply.";
        const preview = await client.previewAtomicRevision({ ...options, content: args.content });
        if (!preview) return `No ${scope}-scope memory found for ID: ${id}.`;
        if (action === "preview") return JSON.stringify({ mode: "preview_only", id, scope, expectedUpdatedAt: preview.expectedUpdatedAt, revisionNumber: preview.revisionNumber, before: preview.currentContent, after: preview.proposedContent, metadata: safeMemoryMetadata(preview.metadata) }, null, 2);
        if (typeof args.expectedUpdatedAt !== "string" || !args.expectedUpdatedAt.trim()) return `Error: apply requires expectedUpdatedAt from preview. Current token: ${preview.expectedUpdatedAt}`;
        if (new Date(args.expectedUpdatedAt).toISOString() !== preview.expectedUpdatedAt) return JSON.stringify({ status: "conflict", currentUpdatedAt: preview.expectedUpdatedAt, message: "Memory changed since preview; preview again before applying." }, null, 2);
        if (!ask) return "Error: interactive owner confirmation is unavailable; no memory was changed.";
        let answer: unknown;
        try { answer = await ask(`Revise ${scope}-scope memory "${id}"?\n\nBefore: ${preview.currentContent.slice(0, 800)}\n\nAfter: ${preview.proposedContent.slice(0, 800)}\n\nA recoverable snapshot will be stored.`, ["Yes", "No"]); }
        catch { return "Error: revision confirmation was unavailable; no memory was changed."; }
        if (answer !== "Yes") return "Memory revision cancelled; no records were changed.";
        const result = await client.reviseAtomic({ ...options, content: args.content, expectedUpdatedAt: args.expectedUpdatedAt, reason: String(args.reason || "owner_confirmed_revision") });
        return JSON.stringify(result, null, 2);
      }
      if (action === "restore") {
        const revisionId = String(args.revisionId || "").trim();
        if (!revisionId) return "Error: revisionId from rmemory_revise history is required.";
        if (typeof args.expectedUpdatedAt !== "string" || !args.expectedUpdatedAt.trim()) return "Error: restore requires expectedUpdatedAt from current memory inspect/preview.";
        const history = await client.listAtomicRevisions({ ...options, limit: 100 });
        const revision = history.find(item => item.revisionId === revisionId);
        if (!revision) return "Error: revision was not found within this memory's exact scope; nothing was changed.";
        if (!ask) return "Error: interactive owner confirmation is unavailable; no memory was changed.";
        let answer: unknown;
        try { answer = await ask(`Restore ${scope}-scope memory "${id}" to revision ${revision.revisionNumber}?\n\nRestored content: ${revision.content.slice(0, 1000)}`, ["Yes", "No"]); }
        catch { return "Error: restore confirmation was unavailable; no memory was changed."; }
        if (answer !== "Yes") return "Memory restore cancelled; no records were changed.";
        const result = await client.restoreAtomicRevision({ ...options, revisionId, expectedUpdatedAt: args.expectedUpdatedAt });
        return JSON.stringify(result, null, 2);
      }
      return "Error: action must be preview, apply, history, or restore.";
    } catch (err) { return `Memory revision workflow failed: ${formatError(err)}. No automatic overwrite or deletion was performed.`; }
  },
};

export const rmemoryMemoryReviewTool: Tool = {
  name: "rmemory_review",
  description: "Owner review for memory quality: preview only deterministic same-scope explicit-key conflicts, flag a confirmed conflict pair, verify a memory, quarantine/unquarantine ambiguous content, or resolve one reviewed conflict. Mutations require confirmation and updatedAt compare-and-swap.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["conflicts", "mark_conflicted", "verify", "quarantine", "unquarantine", "resolve_conflict", "preview_legacy_mapping", "map_legacy"], description: "Review candidates or perform an owner-confirmed state transition." },
    id: { type: "string", description: "Logical ID for a memory transition." },
    withId: { type: "string", description: "Second memory ID for pair-based conflict marking/resolution; must share explicit assertionKey and exact scope." },
    sourceId: { type: "string", description: "Raw legacy record ID; required for preview_legacy_mapping/map_legacy." },
    content: { type: "string", description: "Optional corrected content to re-save while mapping an ambiguous legacy record." },
    expectedSourceFingerprint: { type: "string", description: "Exact fingerprint returned by preview_legacy_mapping; required for map_legacy." },
    scope: { type: "string", enum: ["project", "global"], description: "Scope; defaults to active project." },
    expectedUpdatedAt: { type: "string", description: "Exact updatedAt from inspect/conflict preview; required for state transitions." },
    reason: { type: "string", description: "Owner-provided reason for quarantine or review decision." },
    limit: { type: "number", description: "Maximum conflict candidates to return (default 50, maximum 200)." },
  }, required: ["action"] },
  async execute(args, cwd) {
    const { agentLocalStorage } = await import("../agent.js");
    const actor = agentLocalStorage.getStore();
    if (!canManagePersistentMemory(actor?.tier)) return "Error: memory review mutations are restricted to Master Agent and Superagent tiers (or the explicit single-agent tier).";
    const action = String(args.action || "conflicts");
    const projectId = getRMemoryProjectId(cwd);
    const scope: "project" | "global" = args.scope === "global" ? "global" : "project";
    const client = getClient();
    try {
      if (action === "conflicts") {
        const exported = await client.exportAtomic({ projectId, includeGlobal: true, limit: 500 });
        const candidates = detectScopedMemoryConflicts(exported.items).slice(0, Math.max(1, Math.min(200, Number(args.limit) || 50)));
        return JSON.stringify({ mode: "review_preview_only", scanned: exported.items.length, conflicts: candidates.map(candidate => ({
          ...candidate,
          assertions: candidate.memoryIds.map(memoryId => {
            const item = exported.items.find(entry => entry.id === memoryId && (candidate.scopeKey === "global" ? entry.scope === "global" : `project:${entry.metadata.projectId}` === candidate.scopeKey));
            return item ? { id: item.id, content: item.content.slice(0, 1000), updatedAt: item.metadata.updatedAt } : { id: memoryId, missing: true };
          }),
        })) }, null, 2);
      }
      if (action === "preview_legacy_mapping" || action === "map_legacy") {
        const sourceId = String(args.sourceId || "").trim();
        const targetId = String(args.id || sourceId).trim();
        if (!sourceId) return "Error: sourceId is required for legacy mapping.";
        if (args.scope !== "project" && args.scope !== "global") return "Error: explicitly choose project or global scope; legacy ownership is never inferred.";
        if (action === "map_legacy" && !String(args.expectedSourceFingerprint || "").trim()) return "Error: expectedSourceFingerprint from preview_legacy_mapping is required.";
        const mapping = await client.previewLegacyAtomicMapping({ sourceId, targetId, content: typeof args.content === "string" ? args.content : undefined, scope: args.scope, projectId });
        if (!mapping) return `Legacy source not found: ${sourceId}.`;
        if (action === "preview_legacy_mapping") return JSON.stringify({ mode: "preview_only", ...mapping, sourceContent: mapping.sourceContent.slice(0, 4000), proposedContent: mapping.proposedContent.slice(0, 4000), note: "Scope was explicitly chosen. Applying will create and verify a scoped replacement; the original legacy row is preserved." }, null, 2);
        if (mapping.expectedSourceFingerprint !== String(args.expectedSourceFingerprint)) return JSON.stringify({ status: "source_changed", message: "Legacy source changed since preview; preview again before applying." }, null, 2);
        if (mapping.targetExists) return JSON.stringify({ status: "target_conflict", targetId, targetContent: mapping.targetContent, message: "Target exists; inspect it and choose a new target ID. Nothing was overwritten." }, null, 2);
        const askMapping = typeof (actor as any)?.onQuestion === "function" ? (actor as any).onQuestion : null;
        if (!askMapping) return "Error: interactive owner confirmation is unavailable; no memory was changed.";
        let mappingAnswer: unknown;
        try { mappingAnswer = await askMapping(`Create a scoped memory from legacy row "${sourceId}" as "${targetId}" in ${args.scope} scope?

Before: ${mapping.sourceContent.slice(0, 700)}

After: ${mapping.proposedContent.slice(0, 700)}

The original legacy row will remain untouched.`, ["Yes", "No"]); }
        catch { return "Error: legacy mapping confirmation was unavailable; no memory was changed."; }
        if (mappingAnswer !== "Yes") return "Legacy mapping cancelled; no records were changed.";
        const mapped = await client.mapLegacyAtomicMemory({ sourceId, targetId, content: typeof args.content === "string" ? args.content : undefined, scope: args.scope, projectId,
          expectedSourceFingerprint: String(args.expectedSourceFingerprint), reason: String(args.reason || "owner_confirmed_legacy_mapping"), agentTier: String(actor?.tier || "master") });
        return JSON.stringify(mapped, null, 2);
      }

      const id = String(args.id || "").trim();
      if (!id) return "Error: id is required for this review action.";
      const current = await client.inspectAtomic({ id, scope, projectId });
      if (!current) return `No ${scope}-scope memory found for ID: ${id}.`;
      const expectedUpdatedAt = String(args.expectedUpdatedAt || "").trim();
      if (!expectedUpdatedAt) return `Error: expectedUpdatedAt is required. Current token: ${String(current.metadata.updatedAt || "missing")}`;
      if (!current.metadata.updatedAt || new Date(expectedUpdatedAt).toISOString() !== new Date(String(current.metadata.updatedAt)).toISOString()) return JSON.stringify({ status: "conflict", currentUpdatedAt: current.metadata.updatedAt, message: "Memory changed; inspect again before review." }, null, 2);
      const ask = typeof (actor as any)?.onQuestion === "function" ? (actor as any).onQuestion : null;
      if (!ask) return "Error: interactive owner confirmation is unavailable; no memory was changed.";
      let peer: Awaited<ReturnType<typeof client.inspectAtomic>> = null;
      if (action === "mark_conflicted" || action === "resolve_conflict") {
        const withId = String(args.withId || "").trim();
        if (!withId || withId === id) return "Error: withId must be a different memory ID.";
        peer = await client.inspectAtomic({ id: withId, scope, projectId });
        if (!peer) return `No matching ${scope}-scope memory found for conflict peer ${withId}.`;
        if (action === "mark_conflicted") {
          const conflicts = detectScopedMemoryConflicts([
            { id: current.id, content: current.content, scope: current.scope, metadata: current.metadata },
            { id: peer.id, content: peer.content, scope: peer.scope, metadata: peer.metadata },
          ]);
          if (conflicts.length !== 1) return "Error: the pair does not prove a conflict. Both records must share the same explicit assertionKey and exact scope, with different normalized assertions.";
        } else if (current.metadata.lifecycleState !== "conflicted" || peer.metadata.lifecycleState !== "conflicted"
          || !Array.isArray(current.metadata.conflictWithMemoryIds) || !current.metadata.conflictWithMemoryIds.includes(peer.id)
          || !Array.isArray(peer.metadata.conflictWithMemoryIds) || !peer.metadata.conflictWithMemoryIds.includes(current.id)) {
          return "Error: resolve_conflict requires a currently symmetric conflict pair. No records were changed.";
        }
      }
      const actionText: Record<string, string> = {
        mark_conflicted: `Mark both "${id}" and "${peer?.id}" as conflicting so neither is injected into recall?`,
        verify: `Mark "${id}" as reviewed and verified? This records an owner verification timestamp.`,
        quarantine: `Quarantine "${id}" from default recall? Reason: ${String(args.reason || "Owner requested quarantine")}`,
        unquarantine: `Remove quarantine from "${id}"? It will return to unverified state and may be recalled again.`,
        resolve_conflict: `Resolve the conflict relationship between "${id}" and "${peer?.id}"? Both will return to reviewed but unverified state; neither assertion is chosen as truth.`,
      };
      if (!actionText[action]) return "Error: unknown review action.";
      let answer: unknown;
      try { answer = await ask(actionText[action], ["Yes", "No"]); }
      catch { return "Error: review confirmation was unavailable; no memory was changed."; }
      if (answer !== "Yes") return "Memory review cancelled; no records were changed.";
      const base = { scope, projectId, reviewedBy: String(actor?.tier || "owner"), reason: String(args.reason || "Owner review") };
      if (peer && action === "mark_conflicted") {
        const result = await client.reviewAtomicConflictPair({
          first: { id, expectedUpdatedAt },
          second: { id: peer.id, expectedUpdatedAt: String(peer.metadata.updatedAt || "") },
          scope, projectId, reviewedBy: String(actor?.tier || "owner"), reason: String(args.reason || "Owner confirmed conflicting assertions"),
        });
        return JSON.stringify(result, null, 2);
      }
      if (peer && action === "resolve_conflict") {
        const result = await client.resolveAtomicConflictPair({
          first: { id, expectedUpdatedAt },
          second: { id: peer.id, expectedUpdatedAt: String(peer.metadata.updatedAt || "") },
          scope, projectId, reviewedBy: String(actor?.tier || "owner"),
        });
        return JSON.stringify(result, null, 2);
      }
      const result = await client.reviewAtomic({ ...base, id, expectedUpdatedAt, action: action as any });
      return JSON.stringify(result, null, 2);
    } catch (err) { return `Memory review failed: ${formatError(err)}.`; }
  },
};

export const rmemoryRetentionReviewTool: Tool = {
  name: "rmemory_retention_review",
  description: "Preview type-aware memory retention candidates, or explicitly mark one scoped memory stale after owner confirmation. Never deletes memory. Durable and ambiguous records are not auto-expired; update tokens protect against concurrent changes.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["preview", "mark_stale"], description: "Preview candidate records (default) or mark one previously inspected record stale." },
    id: { type: "string", description: "Logical memory ID; required for mark_stale." },
    scope: { type: "string", enum: ["project", "global"], description: "Scope; defaults to active project." },
    expectedUpdatedAt: { type: "string", description: "Exact updatedAt from memory inspect/preview; required for mark_stale." },
    reason: { type: "string", description: "Reason to keep in the stale marker." },
    limit: { type: "number", description: "Maximum preview candidates (default 100, maximum 500)." },
  }, required: [] },
  async execute(args, cwd) {
    const { agentLocalStorage } = await import("../agent.js");
    const actor = agentLocalStorage.getStore();
    if (!canManagePersistentMemory(actor?.tier)) return "Error: retention review is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier).";
    const action = String(args.action || "preview");
    const projectId = getRMemoryProjectId(cwd);
    const client = getClient();
    try {
      if (action === "preview") {
        const exported = await client.exportAtomic({ projectId, includeGlobal: true, limit: 500 });
        const preview = previewMemoryRetention(exported.items, { limit: Math.max(1, Math.min(500, Number(args.limit) || 100)) });
        return JSON.stringify({ mode: "preview_only", ...preview, exportTruncated: exported.truncated,
          note: "No records were changed or deleted. Review each candidate; mark_stale requires a fresh owner confirmation and matching updatedAt." }, null, 2);
      }
      if (action !== "mark_stale") return "Error: action must be preview or mark_stale.";
      const id = String(args.id || "").trim();
      if (!id) return "Error: id is required for mark_stale.";
      const scope = args.scope === "global" ? "global" : "project";
      const current = await client.inspectAtomic({ id, scope, projectId });
      if (!current) return `No ${scope}-scope memory found for ID: ${id}.`;
      const expectedUpdatedAt = String(args.expectedUpdatedAt || "").trim();
      if (!expectedUpdatedAt) return `Error: expectedUpdatedAt is required. Current token: ${String(current.metadata.updatedAt || "missing")}`;
      const preview = previewMemoryRetention([{ id: current.id, content: current.content, scope: current.scope, metadata: current.metadata }], { limit: 1 });
      if (!preview.items.some(item => item.id === id && item.scope === scope)) return "Error: this record is not an eligible type-aware retention candidate. No changes were made; use rmemory_review to inspect content or keep durable records.";
      const ask = typeof (actor as any)?.onQuestion === "function" ? (actor as any).onQuestion : null;
      if (!ask) return "Error: interactive owner confirmation is unavailable; no memory was changed.";
      let answer: unknown;
      try { answer = await ask(`Mark ${scope}-scope memory "${id}" stale? This only excludes it from default recall; it does not delete or rewrite content. Reason: ${String(args.reason || "Retention review interval exceeded")}`, ["Yes", "No"]); }
      catch { return "Error: retention confirmation was unavailable; no memory was changed."; }
      if (answer !== "Yes") return "Retention update cancelled; no records were changed.";
      const result = await client.markAtomicStale({ id, scope, projectId, expectedUpdatedAt, reason: String(args.reason || "retention_review") });
      return JSON.stringify(result, null, 2);
    } catch (err) { return `Memory retention review failed: ${formatError(err)}. No records were deleted.`; }
  },
};


export const rmemoryTaskSummaryTool: Tool = {
  name: "rmemory_task_summary",
  description: "Preview or save a candidate project memory derived only from a persisted task_completed event and its persisted same-task evidence. The saved memory remains a candidate/unverified until separately reviewed; task summaries never auto-promote to verified durable facts.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["preview", "save"], description: "Preview a summary or save it as a candidate memory after owner confirmation." },
    taskId: { type: "string", description: "Exact task ID from SelfDev task events." },
    terminalEventId: { type: "string", description: "Persisted task_completed event ID; must belong to this task and workspace." },
  }, required: ["action", "taskId", "terminalEventId"] },
  async execute(args, cwd) {
    const { agentLocalStorage } = await import("../agent.js");
    const actor = agentLocalStorage.getStore();
    if (!canManagePersistentMemory(actor?.tier)) return "Error: task summary memory is restricted to Master Agent and Superagent tiers (or the explicit single-agent tier).";
    const taskId = String(args.taskId || "").trim();
    const terminalEventId = String(args.terminalEventId || "").trim();
    const action = String(args.action || "preview");
    if (!taskId || !terminalEventId) return "Error: taskId and terminalEventId are required.";
    if (action !== "preview" && action !== "save") return "Error: action must be preview or save.";
    try {
      const { buildPersistedCompletedTaskSummary } = await import("../selfdev/taskEvidence.js");
      const projectId = getRMemoryProjectId(cwd);
      const result = await buildPersistedCompletedTaskSummary({ workspace: cwd, projectId, taskId, terminalEventId });
      if (!result?.summary) return "No matching persisted task_completed event was found for this task/workspace. Failed, incomplete, aborted, or mismatched tasks cannot produce a task summary.";
      const summary = result.summary;
      const proposed = {
        taskId, projectId, terminalEventId: summary.terminalEventId, outcome: summary.outcome,
        summary: summary.summary, evidenceIds: summary.evidenceIds,
        evidenceValidationStatus: summary.validationStatus,
        missingEvidenceIds: result.missingEvidenceIds, rejectedEvidenceIds: result.rejectedEvidenceIds,
        changedFiles: summary.changedFiles, blockers: summary.blockers, followUp: summary.followUp,
        memoryPolicy: "candidate/unverified; requires separate owner review before treating as a verified fact",
      };
      if (action === "preview") return JSON.stringify({ mode: "preview_only", ...proposed }, null, 2);
      if (result.missingEvidenceIds.length || result.rejectedEvidenceIds.length) return JSON.stringify({ status: "incomplete_evidence", ...proposed, message: "Evidence links are incomplete or invalid. Preview is available, but saving is blocked until the recorded references are complete." }, null, 2);
      const id = `task-summary-${createHash("sha256").update(`${projectId}:${taskId}`).digest("hex").slice(0, 24)}`;
      const client = getClient();
      const existing = await client.inspectAtomic({ id, scope: "project", projectId });
      if (existing) return JSON.stringify({ status: "already_exists", id, scope: "project", updatedAt: existing.metadata.updatedAt, message: "No overwrite was performed; inspect/revise the existing task summary explicitly." }, null, 2);
      const ask = typeof (actor as any)?.onQuestion === "function" ? (actor as any).onQuestion : null;
      if (!ask) return "Error: interactive owner confirmation is unavailable; no memory was saved.";
      let answer: unknown;
      try { answer = await ask(`Save a candidate memory for completed task "${taskId}"? It remains unverified until separately reviewed.

Summary: ${summary.summary}
Evidence: ${summary.evidenceIds.join(", ")}
Evidence check: ${summary.validationStatus}`, ["Yes", "No"]); }
      catch { return "Error: task summary confirmation was unavailable; no memory was saved."; }
      if (answer !== "Yes") return "Task summary save cancelled; no record was changed.";
      const now = new Date().toISOString();
      const content = `[project:${projectId}] Completed task summary: ${summary.summary}${summary.changedFiles.length ? ` Changed files: ${summary.changedFiles.join(", ")}` : ""}${summary.blockers.length ? ` Blockers: ${summary.blockers.join("; ")}` : ""}${summary.followUp ? ` Follow-up: ${summary.followUp}` : ""} Evidence IDs: ${summary.evidenceIds.join(", ")}`.slice(0, 7900);
      const evidence = result.evidence.slice(0, 20).map(item => ({ id: item.id,
        kind: item.kind === "test_result" ? "test" as const : item.kind === "build_result" ? "build" as const : "other" as const,
        status: item.verifiedSuccess ? "passed" : "unverified", summary: `${item.kind} evidence for task ${taskId}`.slice(0, 240), recordedAt: now }));
      const metadata = createMemoryRecordMetadata({ memoryId: id, memoryType: "task-summary", scope: "project", projectId,
        taskId, source: "rmemory_task_summary", agentTier: String(actor?.tier || "master"), now, validationStatus: "candidate", evidence,
        existingMetadata: { retentionClass: "task-summary", reviewState: "unreviewed", lifecycleState: "active", taskOutcome: "completed", terminalEventId, evidenceValidationStatus: summary.validationStatus } });
      const saved = await client.updateAtomic({ id, content, metadata });
      return JSON.stringify({ status: "saved_candidate", id: saved.id, scope: "project", projectId, validationStatus: "candidate", updatedAt: saved.updated_at, evidenceCount: evidence.length, message: "Saved as candidate/unverified. Use rmemory_review to verify it explicitly." }, null, 2);
    } catch (err) { return `Task summary workflow failed: ${formatError(err)}. No overwrite or automatic promotion was performed.`; }
  },
};
