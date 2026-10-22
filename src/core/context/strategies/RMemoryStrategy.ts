import {
  CompactionStrategy,
  CompactionContext,
  CompactionResult,
  CompactionOptions,
  CompactionCost,
} from "../CompactionStrategy.js";
import { Message, contentToString } from "../../conversation.js";
import { getSettings } from "../../config.js";
import { SummarizationStrategy } from "./SummarizationStrategy.js";
import { getRMemoryClient, getRMemoryProjectId, getRMemorySessionKey, isRmemoryActiveSync } from "../../rmemoryUtil.js";
import { assessMemoryFreshness, detectScopedMemoryConflicts } from "../../memoryLifecycle.js";
import { ContextContinuityStore, formatCheckpointMemory, activeUserRequest } from "../ContextContinuity.js";

export interface RMemoryConfig {
  model?: any;
  abortSignal?: AbortSignal;
  projectId?: string;
  historyFilePath?: string;
}

export class RMemoryStrategy implements CompactionStrategy {
  name = "rmemory";
  private lastCapturedTimestamp = 0;
  private lastConnectAttempt = 0;
  private gatewayOffline = false;
  private recallCache: { key: string; ts: number; value: any } | null = null;
  private static RECALL_TTL = 60 * 1000;
  private config?: RMemoryConfig;

  constructor(config?: RMemoryConfig) {
    this.config = config;
  }

  setConfig(config: RMemoryConfig): void {
    // Model changes must not erase canonical project and session identity.
    // Otherwise recall silently falls back to process.cwd() and cross-session
    // checkpoints cannot be recovered after an LLM provider switch.
    this.config = { ...this.config, ...config };
  }

  canHandle(context: CompactionContext): boolean {
    return isRmemoryActiveSync() && context.messages.length > 5;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const now = Date.now();

    // Silent fallback if gateway is known to be offline (cooldown for 5 minutes)
    if (this.gatewayOffline && now - this.lastConnectAttempt < 5 * 60 * 1000) {
      const fallback = new SummarizationStrategy({
        model: this.config?.model ?? (options as any).model,
        abortSignal: this.config?.abortSignal ?? options.abortSignal,
      });
      return fallback.execute(messages, options);
    }

    const client = getRMemoryClient(3000); // 3s timeout to prevent CLI hang
    const projectId = this.config?.projectId || getRMemoryProjectId(process.cwd());
    const sessionKey = getRMemorySessionKey(this.config?.historyFilePath || null);

    try {
      // 1. Capture user/assistant messages to L0 incrementally
      const newMessages = messages
        .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp > this.lastCapturedTimestamp)
        .map((m) => {
          const rawContent = contentToString(m.content).trim();
          const content = rawContent.length > 0
            ? rawContent
            : (m.toolCalls && m.toolCalls.length > 0
              ? `[Tool invocation: ${m.toolCalls.map((t) => t.name).join(", ")}]`
              : "[empty message]");
          return {
            role: m.role as "user" | "assistant",
            content,
            timestamp: new Date(m.timestamp || Date.now()).toISOString(),
          };
        });

      if (newMessages.length > 0) {
        await client.addConversation({
          session_id: sessionKey,
          projectId,
          messages: newMessages,
        });
        const maxTs = Math.max(...messages.map((m) => m.timestamp || 0));
        if (maxTs > this.lastCapturedTimestamp) {
          this.lastCapturedTimestamp = maxTs;
        }
      }

      // 2. Recall long-term memories
      // We find the last user message to use as the query
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const query = lastUserMsg ? contentToString(lastUserMsg.content) : "latest coding context";

      // Parallel requests for L1 memories, L3 persona, and L2 scenarios
      // Memoize for 60s to avoid repeated gateway calls per compaction cycle.
      const recallKey = `${projectId}::${sessionKey}::${query}`;
      const nowTs = Date.now();
      let searchResult: PromiseSettledResult<any>;
      let persona: PromiseSettledResult<any>;
      let scenarios: PromiseSettledResult<any>;
      const recallStartedAt = Date.now();
      if (
        this.recallCache &&
        this.recallCache.key === recallKey &&
        nowTs - this.recallCache.ts < RMemoryStrategy.RECALL_TTL
      ) {
        ({ searchResult, persona, scenarios } = this.recallCache.value);
      } else {
        [searchResult, persona, scenarios] = await Promise.allSettled([
          client.searchAtomic({ query, limit: Math.min(10, Math.ceil((options.tokenBudget || 8000) / 2000)), projectId }),
          client.readCore(),
          client.listScenarios({}),
        ]);
        this.recallCache = { key: recallKey, ts: nowTs, value: { searchResult, persona, scenarios } };
      }

      const retrievedItems = searchResult.status === "fulfilled" ? (searchResult.value?.items ?? []) : [];
      const scopedItems = retrievedItems.filter((item: any) => {
        const metadata = item.metadata || {};
        const content = String(item.content || "");
        if (metadata.scope === "global" || (!metadata.scope && content.startsWith("[global]"))) return true;
        if (metadata.scope === "project" && metadata.projectId === projectId) return true;
        return !metadata.scope && content.startsWith(`[project:${projectId}]`);
      });
      const candidateConflicts = detectScopedMemoryConflicts(scopedItems
        .filter((item: any) => item.metadata?.type !== "message" && !item.metadata?.session)
        .map((item: any) => ({ id: String(item.id || ""), content: String(item.content || ""), scope: item.metadata?.scope, metadata: item.metadata || {} })));
      const conflictingMemoryIds = new Set(candidateConflicts.flatMap(conflict => conflict.memoryIds));
      const l1Items = scopedItems.filter((item: any) => {
        const metadata = item.metadata || {};
        // Conversation episodes follow session recency, not atomic-memory TTLs.
        if (metadata.type === "message" || metadata.session) return true;
        if (conflictingMemoryIds.has(String(item.id || ""))) return false;
        return assessMemoryFreshness({ id: String(item.id || ""), content: String(item.content || ""), metadata }).shouldInject;
      });
      const excludedMemoryCount = scopedItems.length - l1Items.length;
      const recallDurationMs = Math.max(0, Date.now() - recallStartedAt);
      const estimatedRecallCharacters = l1Items.reduce((total: number, item: any) => total + Math.min(800, String(item.content || "").length), 0);
      const memoryRecallStatus = searchResult.status === "rejected" ? "unavailable"
        : scopedItems.length === 0 ? "empty"
        : candidateConflicts.length > 0 ? "conflict"
        : excludedMemoryCount > 0 ? "partial" : "ok";
      const personaContent = persona.status === "fulfilled" && persona.value ? persona.value.content : null;
      const sceneEntries = scenarios.status === "fulfilled" && scenarios.value ? (scenarios.value.entries ?? []) : [];

      // Reset offline status on success
      this.gatewayOffline = false;

      // 3. Format the recalled memories
      const formattedMemories: string[] = [];
      // Session checkpoint is separate from project memories: no automatic promotion.
      // It is resolved by the same history-path identity as the snapshot store.
      if (this.config?.historyFilePath) {
        const committed = new ContextContinuityStore(this.config.historyFilePath).getCommittedCheckpoint();
        if (committed && committed.goal && activeUserRequest(messages).startsWith(committed.goal.slice(0, 80))) {
          formattedMemories.push(formatCheckpointMemory(committed, 1600));
        }
      }

      if (personaContent) {
        formattedMemories.push("<user-persona>");
        formattedMemories.push(personaContent);
        formattedMemories.push("</user-persona>");
      }

      if (sceneEntries.length > 0) {
        formattedMemories.push("\n## 🗺️ Scene Navigation");
        for (const scene of sceneEntries) {
          formattedMemories.push(`- \`${scene.path}\``);
        }
      }

      if (l1Items.length > 0) {
        formattedMemories.push("\n<relevant-memories>");
        for (const item of l1Items) {
          const meta = item.metadata && typeof item.metadata === "object" ? item.metadata as Record<string, any> : {};
          let memoryType = String(item.type || "memory");
          if (meta.session) {
            memoryType = meta.session === sessionKey
              ? `current session ${meta.role || "message"}`
              : `past session ${meta.role || "message"}`;
          }
          const provenance = meta.provenance && typeof meta.provenance === "object" ? meta.provenance as Record<string, unknown> : {};
          const typeTag = [
            memoryType.slice(0, 48),
            meta.scope ? `scope=${String(meta.scope).slice(0, 16)}` : undefined,
            meta.projectId ? `project=${String(meta.projectId).slice(0, 24)}` : undefined,
            meta.schemaVersion !== undefined ? `schema=${String(meta.schemaVersion).slice(0, 8)}` : undefined,
            meta.validationStatus ? `validation=${String(meta.validationStatus).slice(0, 24)}` : undefined,
            provenance.source ? `source=${String(provenance.source).slice(0, 32)}` : undefined,
          ].filter(Boolean).join(" | ").slice(0, 180);
          const memoryContent = String(item.content || "");
          const maxChars = 800;
          formattedMemories.push(`- [${typeTag}] ${memoryContent.slice(0, maxChars)}${memoryContent.length > maxChars ? "… [truncated]" : ""}`);
        }
        formattedMemories.push("</relevant-memories>");
      }

      // Preserve the difference between successful empty recall and a provider/search failure.
      if (searchResult.status === "rejected") {
        formattedMemories.push("## Memory recall status");
        formattedMemories.push("- Long-term memory search was unavailable for this compaction. Treat missing memories as unknown, not as proof that no prior memory exists.");
      } else if (scopedItems.length === 0) {
        formattedMemories.push("## Memory recall status");
        formattedMemories.push("- Long-term memory search completed successfully and returned no records eligible for this project/global scope.");
      } else if (excludedMemoryCount > 0) {
        formattedMemories.push("## Memory recall status");
        formattedMemories.push(`- ${excludedMemoryCount} scoped memory record(s) were withheld because they are stale, expired, rejected, superseded, quarantined, or conflicted. Inspect and review before reusing them.`);
      }

      const summaryText = formattedMemories.join("\n").trim();

      // 4. Construct compacted messages
      const preserveRecent = options.preserveRecent || 20;
      let keepIndex = Math.max(0, messages.length - preserveRecent);
      while (keepIndex < messages.length && messages[keepIndex]?.role === "tool") {
        keepIndex++;
      }
      const toKeep = messages.slice(keepIndex);

      // Check if we are in a brand new session (e.g. current messages count is small, e.g. <= 2)
      const isNewSession = messages.length <= 2;

      let warningHeader = "";
      if (isNewSession) {
        warningHeader = `IMPORTANT: This is a NEW, clean session. The memories below are retrieved from your long-term memory of PREVIOUS sessions and are provided for context and reference only.
Do NOT automatically resume or reference these past sessions, previous code modifications, or past conversation threads unless the user's current request explicitly asks you to. Focus entirely on the user's new request.\n\n`;
      }

      // Check if a memory context message already exists in toKeep or original messages
      const existingMemoryIdx = toKeep.findIndex((m) =>
        contentToString(m.content).startsWith("[RMemory Agent Memory Context]:")
      );

      const memoryMessage: Message = {
        role: "system",
        content: `[RMemory Agent Memory Context]:\n${warningHeader}${summaryText || "No prior memories recalled."}`,
        timestamp: Date.now(),
      };

      let result: Message[];
      if (existingMemoryIdx !== -1) {
        toKeep[existingMemoryIdx] = memoryMessage;
        result = toKeep;
      } else {
        result = [memoryMessage, ...toKeep];
      }

      return {
        messages: result,
        metadata: {
          strategy: "rmemory",
          messagesBefore: messages.length,
          messagesAfter: result.length,
          summary: summaryText || "No prior memories recalled.",
          lastCapturedTimestamp: this.lastCapturedTimestamp,
          usedFallback: false,
          usedLLM: false,
          memoryRecallStatus,
          memoryRecallRetrievedRecordCount: retrievedItems.length,
          memoryRecallCrossScopeRejectedCount: retrievedItems.length - scopedItems.length,
          memoryRecallScopedRecordCount: scopedItems.length,
          memoryRecallInjectedCount: l1Items.length,
          memoryRecallWithheldCount: excludedMemoryCount,
          memoryRecallConflictPairCount: candidateConflicts.length,
          memoryRecallConflictingRecordCount: conflictingMemoryIds.size,
          memoryRecallEstimatedCharacters: estimatedRecallCharacters,
          memoryRecallEstimatedTokens: Math.ceil(estimatedRecallCharacters / 4),
          memoryRecallDurationMs: recallDurationMs,
          memoryRecallCacheHit: this.recallCache?.key === recallKey && nowTs - this.recallCache.ts < RMemoryStrategy.RECALL_TTL,
        },
      };
    } catch (error) {
      this.lastConnectAttempt = Date.now();
      if (!this.gatewayOffline) {
        console.warn("RMemoryStrategy gateway connection failed, falling back to SummarizationStrategy. Offline cooldown active for 5m. Error:", (error as Error).message);
        this.gatewayOffline = true;
      }
      
      // Fallback to SummarizationStrategy with AI model when available (smart compact)
      const fallback = new SummarizationStrategy({
        model: this.config?.model ?? (options as any).model,
        abortSignal: this.config?.abortSignal ?? options.abortSignal,
      });
      return fallback.execute(messages, options);
    }
  }

  estimateCost(messages: Message[]): CompactionCost {
    const inputTokens = messages.reduce(
      (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
      0
    );
    return {
      tokens: inputTokens + 1000,
      time: 1500,
      apiCalls: 4,
    };
  }
}
