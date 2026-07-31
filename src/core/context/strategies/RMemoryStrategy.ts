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
import { getRMemoryClient, getRMemorySessionKey } from "../../rmemoryUtil.js";

export class RMemoryStrategy implements CompactionStrategy {
  name = "rmemory";
  private lastCapturedTimestamp = 0;
  private lastConnectAttempt = 0;
  private gatewayOffline = false;
  private recallCache: { key: string; ts: number; value: any } | null = null;
  private static RECALL_TTL = 60 * 1000;

  constructor() {}

  canHandle(context: CompactionContext): boolean {
    const settings = getSettings();
    return !!settings.enableRmemory && context.messages.length > 5;
  }

  async execute(
    messages: Message[],
    options: CompactionOptions
  ): Promise<CompactionResult> {
    const now = Date.now();

    // Silent fallback if gateway is known to be offline (cooldown for 5 minutes)
    if (this.gatewayOffline && now - this.lastConnectAttempt < 5 * 60 * 1000) {
      const fallback = new SummarizationStrategy();
      return fallback.execute(messages, options);
    }

    const client = getRMemoryClient(3000); // 3s timeout to prevent CLI hang
    const sessionKey = getRMemorySessionKey(null);

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
      const recallKey = `${sessionKey}::${query}`;
      const nowTs = Date.now();
      let searchResult: PromiseSettledResult<any>;
      let persona: PromiseSettledResult<any>;
      let scenarios: PromiseSettledResult<any>;
      if (
        this.recallCache &&
        this.recallCache.key === recallKey &&
        nowTs - this.recallCache.ts < RMemoryStrategy.RECALL_TTL
      ) {
        ({ searchResult, persona, scenarios } = this.recallCache.value);
      } else {
        [searchResult, persona, scenarios] = await Promise.allSettled([
          client.searchAtomic({ query, limit: Math.min(10, Math.ceil((options.tokenBudget || 8000) / 2000)) }),
          client.readCore(),
          client.listScenarios({}),
        ]);
        this.recallCache = { key: recallKey, ts: nowTs, value: { searchResult, persona, scenarios } };
      }

      const l1Items = searchResult.status === "fulfilled" ? (searchResult.value?.items ?? []) : [];
      const personaContent = persona.status === "fulfilled" && persona.value ? persona.value.content : null;
      const sceneEntries = scenarios.status === "fulfilled" && scenarios.value ? (scenarios.value.entries ?? []) : [];

      // Reset offline status on success
      this.gatewayOffline = false;

      // 3. Format the recalled memories
      const formattedMemories: string[] = [];

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
          let typeTag = item.type || "memory";
          const meta = (item as any).metadata;
          if (meta && meta.session) {
            if (meta.session === sessionKey) {
              typeTag = `current session ${meta.role || "message"}`;
            } else {
              typeTag = `past session ${meta.role || "message"}`;
            }
          }
          formattedMemories.push(`- [${typeTag}] ${item.content}`);
        }
        formattedMemories.push("</relevant-memories>");
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
        },
      };
    } catch (error) {
      this.lastConnectAttempt = Date.now();
      if (!this.gatewayOffline) {
        console.warn("RMemoryStrategy gateway connection failed, falling back to SummarizationStrategy. Offline cooldown active for 5m. Error:", (error as Error).message);
        this.gatewayOffline = true;
      }
      
      // Fallback to SummarizationStrategy
      const fallback = new SummarizationStrategy();
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
