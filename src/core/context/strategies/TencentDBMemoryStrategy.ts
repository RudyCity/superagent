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
import { getTencentDBClient, getTencentDBSessionKey } from "../../tencentdbUtil.js";

export class TencentDBMemoryStrategy implements CompactionStrategy {
  name = "tencentdb-memory";
  private historyFilePath?: string;
  private lastCapturedTimestamp = 0;
  private lastConnectAttempt = 0;
  private gatewayOffline = false;

  constructor(config?: { historyFilePath?: string }) {
    this.historyFilePath = config?.historyFilePath;
  }

  canHandle(context: CompactionContext): boolean {
    const settings = getSettings();
    return !!settings.enableTencentdbMemory && context.messages.length > 5;
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

    const client = getTencentDBClient(3000); // 3s timeout to prevent CLI hang
    const sessionKey = getTencentDBSessionKey(this.historyFilePath || null);

    const historyPath = this.historyFilePath || "";
    // Lazily load lastCapturedTimestamp from persisted compaction history
    if (this.lastCapturedTimestamp === 0 && historyPath) {
      try {
        const fs = await import("fs/promises");
        const fileData = await fs.readFile(historyPath, "utf-8");
        const events = JSON.parse(fileData);
        if (Array.isArray(events)) {
          const tdbEvents = events.filter(
            (e: any) =>
              e.strategy === "tencentdb-memory" ||
              e.metadata?.strategy === "tencentdb-memory"
          );
          let maxWatermark = 0;
          for (const e of tdbEvents) {
            const watermark =
              e.metadata?.lastCapturedTimestamp || e.lastCapturedTimestamp || 0;
            if (watermark > maxWatermark) {
              maxWatermark = watermark;
            }
          }
          this.lastCapturedTimestamp = maxWatermark;
        }
      } catch (e) {
        // Ignore file read/parse errors
      }
    }

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
      const [searchResult, persona, scenarios] = await Promise.allSettled([
        client.searchAtomic({ query, limit: Math.min(10, Math.ceil((options.tokenBudget || 8000) / 2000)) }),
        client.readCore(),
        client.listScenarios({}),
      ]);

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
          const typeTag = item.type ? `[${item.type}]` : "";
          formattedMemories.push(`- ${typeTag} ${item.content}`);
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

      const memoryMessage: Message = {
        role: "user",
        content: `[TencentDB Agent Memory Context]:\n${summaryText || "No prior memories recalled."}`,
        timestamp: Date.now(),
      };

      const result = [memoryMessage, ...toKeep];

      return {
        messages: result,
        metadata: {
          strategy: "tencentdb-memory",
          messagesBefore: messages.length,
          messagesAfter: result.length,
          summary: summaryText || "No prior memories recalled.",
          lastCapturedTimestamp: this.lastCapturedTimestamp,
        },
      };
    } catch (error) {
      this.lastConnectAttempt = Date.now();
      if (!this.gatewayOffline) {
        console.warn("TencentDBMemoryStrategy gateway connection failed, falling back to SummarizationStrategy. Offline cooldown active for 5m. Error:", (error as Error).message);
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
