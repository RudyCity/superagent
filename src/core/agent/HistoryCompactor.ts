import { generateText } from "ai";
import { getContextWindowLimit, getSettings, getConfig } from "../config.js";
import { rateLimiter, concurrencyLimiter } from "../rateLimiter.js";
import { contentToString, type Message } from "../conversation.js";
import { getRMemoryClient, getRMemorySessionKey } from "../rmemoryUtil.js";
import type { Agent } from "../agent.js";

export class HistoryCompactor {
  public static async contextManagerCompact(
    agent: Agent,
    signal?: AbortSignal,
    force: boolean = false,
    tokenBudget?: number,
    byteBudget?: number
  ): Promise<void> {
    const contextManager = agent.conversation.getContextManager()!;
    if (signal) {
      await agent.conversation.updateContextManagerLLM(agent.getModel(), signal);
    }
    const messages = agent.conversation.getMessages();
    const decision = contextManager.shouldCompact(messages);

    if (!decision.shouldCompact && !force && !tokenBudget) {
      return;
    }

    try {
      agent.writeToLogFile(
        "INFO",
        `Context compaction triggered: ${force ? "forced-413" : (tokenBudget ? "forced-token-limit" : decision.reason)} (strategy: ${force ? "pruning" : (decision.recommendedStrategy?.name || "auto")})`
      );

      let strategy;
      let compactionOptions: Partial<import("../context/CompactionStrategy.js").CompactionOptions> = {
        modelName: getConfig().model,
      };
      if (force && !tokenBudget) {
        const { PruningStrategy } = await import("../context/strategies/PruningStrategy.js");
        strategy = new PruningStrategy();
        compactionOptions = {
          ...compactionOptions,
          byteBudget: byteBudget ?? 3 * 1024 * 1024, // 3.0 MB safety threshold
        };
      } else if (tokenBudget) {
        compactionOptions = {
          ...compactionOptions,
          tokenBudget,
        };
      }

      const result = await contextManager.compact(messages, strategy, signal, compactionOptions);

      agent.conversation.replaceMessages(result.messages);
      await agent.saveHistory();

      agent.writeToLogFile(
        "INFO",
        `Compaction completed: ${result.metadata.strategy} strategy, ${result.metadata.messagesBefore || 0} -> ${result.metadata.messagesAfter || 0} messages`
      );
    } catch (error) {
      console.error("ContextManager compaction failed:", error);
      agent.writeToLogFile("ERROR", `ContextManager compaction failed: ${(error as Error).message}`);
      await this.legacyCompactHistory(agent, signal, force, tokenBudget, byteBudget);
    }
  }

  public static async legacyCompactHistory(
    agent: Agent,
    signal?: AbortSignal,
    force: boolean = false,
    tokenBudget?: number,
    byteBudget?: number
  ): Promise<void> {
    const modelLimit = getContextWindowLimit(getConfig().model);
    const maxHistoryTokens = tokenBudget ?? Math.floor(modelLimit * (force ? 0.3 : 0.5));

    if (force || tokenBudget || agent.conversation.getTokenEstimate() > maxHistoryTokens) {
      const allMsgs = agent.conversation.getMessages();
      if (allMsgs.length > 20) {
        const toSummarize = allMsgs.slice(0, 20);
        try {
          if (force) {
            agent.conversation.pruneToTokenLimit(maxHistoryTokens);
            await agent.saveHistory();
          } else {
            const summary = await this.summarizeMessages(agent, toSummarize, signal);
            agent.conversation.replaceOldMessagesWithSummary(20, summary);
            await agent.saveHistory();
          }
        } catch (err) {
          console.error("Failed to summarize and compact conversation history:", err);
          agent.conversation.pruneToTokenLimit(maxHistoryTokens);
          await agent.saveHistory();
        }
      } else {
        agent.conversation.pruneToTokenLimit(maxHistoryTokens);
        await agent.saveHistory();
      }
    }
  }

  public static async summarizeMessages(agent: Agent, messages: any[], signal?: AbortSignal): Promise<string> {
    const formatted = messages
      .map((m) => {
        const role = m.role.toUpperCase();
        let details = typeof m.content === "string" ? m.content.trim() : "";
        if (m.toolCalls && m.toolCalls.length > 0) {
          const tcNames = m.toolCalls.map((tc: any) => tc.name).join(", ");
          details += details ? `\n[Tool Calls]: ${tcNames}` : `[Tool Calls]: ${tcNames}`;
        }
        if (!details) return null;
        return `[${role}]: ${details}`;
      })
      .filter(Boolean)
      .join("\n\n");

    const prompt = `You are a helper system node. Summarize the following past coding assistant chat history turns extremely briefly.
Identify:
1. What the user's goals or requirements were.
2. What actions the assistant took (e.g. edited files, ran commands).
3. The resulting workspace state or any unresolved issues.

Keep the summary concise, clear, and direct.

---
PAST CHAT HISTORY:
${formatted}`;

    let attempt = 0;
    const maxRetries = 10;
    const baseDelay = 5000;
    let result;

    while (true) {
      let concurrencyAcquired = false;
      try {
        if (getSettings().concurrencyLimit === 1) {
          await concurrencyLimiter.acquire();
          concurrencyAcquired = true;
        }
        await rateLimiter.acquire(1);

        try {
          const { logPrompt } = await import("./PromptLogger.js");
          logPrompt(
            "HistoryCompactor:summarizeMessages",
            agent.getModel()?.modelId,
            "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
            prompt,
            agent
          );
        } catch {}

        result = await generateText({
          model: agent.getModel(),
          system: "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
          prompt,
          abortSignal: signal,
        });
        break;
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          throw err;
        }
        attempt++;
        if (attempt > maxRetries) {
          throw err;
        }
        const summarySignal = signal;
        await new Promise<void>((resolve, reject) => {
          if (summarySignal?.aborted) {
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
            return;
          }
          const timeout = setTimeout(() => {
            if (summarySignal) summarySignal.removeEventListener("abort", onAbort);
            resolve();
          }, baseDelay * Math.pow(2, attempt - 1));
          const onAbort = () => {
            clearTimeout(timeout);
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            reject(err);
          };
          if (summarySignal) {
            summarySignal.addEventListener("abort", onAbort);
          }
        });
      } finally {
        if (concurrencyAcquired) {
          concurrencyLimiter.release();
        }
      }
    }

    // Track token usage so Master's token counter stays accurate
    try {
      const { addMasterTokens } = await import("../tools/state.js");
      addMasterTokens(result.usage?.promptTokens || 0, result.usage?.completionTokens || 0);
    } catch {}

    return result.text.trim();
  }

  public static async prepopulateRmemoryContext(agent: Agent): Promise<void> {
    const messages = agent.conversation.getMessages();
    // Check if we already have a memory context message in the conversation
    const hasMemoryContext = messages.some(
      (m) => m.role === "user" && contentToString(m.content).startsWith("[RMemory Agent Memory Context]:")
    );
    if (hasMemoryContext) return;

    // Fetch the memories
    const settings = getSettings();
    if (!settings.enableRmemory) return;

    const client = getRMemoryClient(2000); // 2s timeout for fast startup check

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const query = lastUserMsg ? contentToString(lastUserMsg.content) : "latest coding context";

    agent.writeToLogFile("INFO", `Pre-populating RMemory memory context for query: "${query.slice(0, 50)}"...`);

    // Fetch in parallel
    const [searchResult, persona, scenarios] = await Promise.allSettled([
      client.searchAtomic({ query, limit: 5 }),
      client.readCore(),
      client.listScenarios({}),
    ]);

    const l1Items = searchResult.status === "fulfilled" ? (searchResult.value?.items ?? []) : [];
    const personaContent = persona.status === "fulfilled" && persona.value ? persona.value.content : null;
    const sceneEntries = scenarios.status === "fulfilled" && scenarios.value ? (scenarios.value.entries ?? []) : [];

    if (!personaContent && l1Items.length === 0 && sceneEntries.length === 0) {
      return; // No memories to inject
    }

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

    const historyPath = agent.getCurrentHistoryFilePath();
    const currentSessionKey = getRMemorySessionKey(historyPath);

    if (l1Items.length > 0) {
      formattedMemories.push("\n<relevant-memories>");
      for (const item of l1Items) {
        let typeTag = item.type || "memory";
        const meta = (item as any).metadata;
        if (meta && meta.session) {
          if (meta.session === currentSessionKey) {
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
    if (!summaryText) return;

    // Check if we are in a brand new session (e.g. current messages count is small, e.g. <= 2)
    const isNewSession = messages.length <= 2;

    let warningHeader = "";
    if (isNewSession) {
      warningHeader = `IMPORTANT: This is a NEW, clean session. The memories below are retrieved from your long-term memory of PREVIOUS sessions and are provided for context and reference only.
Do NOT automatically resume or reference these past sessions, previous code modifications, or past conversation threads unless the user's current request explicitly asks you to. Focus entirely on the user's new request.\n\n`;
    }

    const memoryMessage: Message = {
      role: "user",
      content: `[RMemory Agent Memory Context]:\n${warningHeader}${summaryText}`,
      timestamp: Date.now(),
    };

    agent.conversation.replaceMessages([memoryMessage, ...messages]);
    agent.writeToLogFile("INFO", "RMemory memory context successfully pre-populated and injected.");
  }
}
