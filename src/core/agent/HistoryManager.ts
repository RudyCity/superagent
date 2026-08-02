import { clearHistoryCache, getSettings, getCurrentWorkspaceIdentifier } from "../config.js";
import { getRMemoryClient, getRMemorySessionKey, isRmemoryActive } from "../rmemoryUtil.js";
import { contentToString } from "../conversation.js";
import type { Agent } from "../agent.js";

export class HistoryManager {
  public static async loadHistory(agent: Agent, autoResume: boolean | string = false): Promise<void> {
    const resolved = agent.resolveHistoryFilePath(autoResume);
    (agent as any).currentHistoryFilePath = resolved;
    process.env.SUPERAGENT_SESSION_PATH = resolved;
    await agent.conversation.loadFromFile(resolved);
    if (agent.conversation.loadedPlanState) {
      agent.planState = agent.conversation.loadedPlanState;
    }
  }

  public static async loadHistoryFromPath(agent: Agent, filePath: string): Promise<void> {
    (agent as any).currentHistoryFilePath = filePath;
    process.env.SUPERAGENT_SESSION_PATH = filePath;
    await agent.conversation.loadFromFile(filePath);
    if (agent.conversation.loadedPlanState) {
      agent.planState = agent.conversation.loadedPlanState;
    }
  }

  public static async saveHistory(agent: Agent): Promise<void> {
    let historyPath = (agent as any).currentHistoryFilePath;
    if (!historyPath) {
      historyPath = agent.resolveHistoryFilePath(false);
      (agent as any).currentHistoryFilePath = historyPath;
    }
    process.env.SUPERAGENT_SESSION_PATH = historyPath;

    try {
      await this.syncConversationToRmemory(agent);
    } catch (err: any) {
      agent.writeToLogFile("WARN", `Failed to incrementally sync conversation to RMemory: ${err.message}`);
    }

    const wsIdentifier = getCurrentWorkspaceIdentifier(agent.workingDirectory);
    await agent.conversation.saveToFile(historyPath, agent.planState, wsIdentifier);
    clearHistoryCache();
  }

  public static saveHistorySync(agent: Agent): void {
    let historyPath = (agent as any).currentHistoryFilePath;
    if (!historyPath) {
      historyPath = agent.resolveHistoryFilePath(false);
      (agent as any).currentHistoryFilePath = historyPath;
    }
    process.env.SUPERAGENT_SESSION_PATH = historyPath;

    const wsIdentifier = getCurrentWorkspaceIdentifier(agent.workingDirectory);
    agent.conversation.saveToFileSync(historyPath, agent.planState, wsIdentifier);
    clearHistoryCache();
  }

  public static async clearHistory(agent: Agent): Promise<void> {
    agent.conversation.clear();
    (agent as any).textLogBuffer = "";
    (agent as any).pendingMessagesQueue = [];
    agent.lastSpeed = null;
    agent.wasRunningBeforeAbort = false;
    (agent as any).currentHistoryFilePath = agent.resolveHistoryFilePath(false);
    await this.saveHistory(agent);
  }

  public static async syncConversationToRmemory(agent: Agent): Promise<void> {
    if (!(await isRmemoryActive())) return;

    const client = getRMemoryClient(3000);
    const historyPath = agent.getCurrentHistoryFilePath();
    const sessionKey = getRMemorySessionKey(historyPath);

    const messages = agent.conversation.getMessages();
    const lastCaptured = agent.conversation.lastCapturedTimestamp || 0;

    const newMessages = messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.timestamp > lastCaptured)
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
      agent.writeToLogFile("INFO", `Incrementally syncing ${newMessages.length} new messages to RMemory (session: ${sessionKey})...`);
      await client.addConversation({
        session_id: sessionKey,
        messages: newMessages,
      });
      const maxTs = Math.max(...messages.map((m) => m.timestamp || 0));
      if (maxTs > lastCaptured) {
        agent.conversation.lastCapturedTimestamp = maxTs;
      }
    }
  }
}
