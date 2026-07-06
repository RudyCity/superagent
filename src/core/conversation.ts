import fs from "fs/promises";
import path from "path";
import {
  superagentInstances,
  subagentInstances,
  notifySuperagentsChanged,
  notifySubagentsChanged,
  historicalSuperagentTokens,
  setHistoricalSuperagentTokens,
  masterPromptTokens,
  masterCompletionTokens,
  lastMasterPromptTokens,
  setMasterTokens,
  setLastMasterPromptTokens
} from "./tools/state.js";
import type { ContextManager, ContextManagerConfig, PinnedMessage } from "./context/index.js";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; image: string; mimeType: string }; // image is base64 string
export type MessageContent = string | Array<TextPart | ImagePart>;

/**
 * Convert MessageContent to a plain string.
 * Used by legacy code paths that work only with strings (display, summarization, token counting).
 * Image parts are represented as "[image]" placeholders.
 */
export function contentToString(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((p) => (p.type === "text" ? p.text : "[image]"))
    .join(" ");
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: MessageContent;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: string;
  isError?: boolean;
}

export class Conversation {
  private messages: Message[] = [];
  private maxHistory = 200;
  public loadedPlanState?: "IDLE" | "PLANNING_PENDING" | "APPROVED";
  private contextManager: ContextManager | null = null;
  public lastCapturedTimestamp = 0;
  /** Pinned messages loaded from file, waiting for ContextManager to be initialized */
  private pendingPinnedMessages: PinnedMessage[] | null = null;

  async initContextManager(config: ContextManagerConfig): Promise<void> {
    const { ContextManager: CM } = await import("./context/index.js");
    this.contextManager = new CM(config);

    // Restore any pinned messages that were loaded from file before ContextManager existed
    if (this.pendingPinnedMessages && this.pendingPinnedMessages.length > 0) {
      this.contextManager.restorePinnedMessages(this.pendingPinnedMessages);
      this.pendingPinnedMessages = null;
    }
  }

  async updateContextManagerLLM(model: any, abortSignal?: AbortSignal): Promise<void> {
    if (!this.contextManager) return;
    this.contextManager.setLLMModel(model, abortSignal);
  }

  getContextManager(): ContextManager | null {
    return this.contextManager;
  }

  hasContextManager(): boolean {
    return this.contextManager !== null;
  }

  replaceMessages(newMessages: Message[]): void {
    this.messages = [...newMessages];
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }
  }

  async saveToFile(filePath: string, planState?: "IDLE" | "PLANNING_PENDING" | "APPROVED", workingDirectory?: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      const serializedSuperagents = Array.from(superagentInstances.values()).map(inst => {
        const { agent, ...rest } = inst;
        return {
          ...rest,
          historyFilePath: inst.historyFilePath || (agent && typeof agent.getCurrentHistoryFilePath === "function" ? agent.getCurrentHistoryFilePath() : undefined)
        };
      });

      const serializedSubagents = Array.from(subagentInstances.values()).map(inst => {
        const { agent, ...rest } = inst;
        return {
          ...rest,
          historyFilePath: inst.historyFilePath || (agent && typeof agent.getCurrentHistoryFilePath === "function" ? agent.getCurrentHistoryFilePath() : undefined)
        };
      });

      // Serialize pinned messages from ContextManager (if available)
      const pinnedMessages = this.contextManager
        ? this.contextManager.serializePinnedMessages()
        : (this.pendingPinnedMessages || []);

      const data = {
        messages: this.messages,
        planState,
        workingDirectory,
        superagents: serializedSuperagents,
        subagents: serializedSubagents,
        historicalSuperagentTokens,
        masterPromptTokens,
        masterCompletionTokens,
        lastMasterPromptTokens,
        pinnedMessages,
        lastCapturedTimestamp: this.lastCapturedTimestamp,
      };
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save history:", err);
    }
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const data = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
        this.messages = parsed.messages;
        this.loadedPlanState = parsed.planState;
        this.lastCapturedTimestamp = parsed.lastCapturedTimestamp || 0;

        // Restore historical superagent tokens
        setHistoricalSuperagentTokens(parsed.historicalSuperagentTokens || 0);
        setMasterTokens(parsed.masterPromptTokens || 0, parsed.masterCompletionTokens || 0);
        setLastMasterPromptTokens(parsed.lastMasterPromptTokens || 0);

        // Restore superagents
        if (Array.isArray(parsed.superagents)) {
          for (const inst of superagentInstances.values()) {
            if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
              try {
                inst.agent.abort();
              } catch {}
            }
          }
          superagentInstances.clear();
          for (const s of parsed.superagents) {
            let status = s.status;
            let result = s.result;
            const logs = [...(s.logs || [])];
            let completedAt = s.completedAt;

            if (status === "running") {
              status = "paused";
              result = "[Paused by session exit]";
              logs.push("\n[SYSTEM: Resumed session, marked as paused]\n");
            }

            superagentInstances.set(s.id, {
              ...s,
              status,
              result,
              logs,
              completedAt,
              agent: {
                abort: () => {},
                getCurrentHistoryFilePath: () => s.historyFilePath || "",
              }
            });
          }
          notifySuperagentsChanged();
        }

        // Restore subagents
        if (Array.isArray(parsed.subagents)) {
          for (const inst of subagentInstances.values()) {
            if (inst.status === "running" && inst.agent && typeof inst.agent.abort === "function") {
              try {
                inst.agent.abort();
              } catch {}
            }
          }
          subagentInstances.clear();
          for (const s of parsed.subagents) {
            let status = s.status;
            let result = s.result;
            const logs = [...(s.logs || [])];
            let completedAt = s.completedAt;

            if (status === "running" || status === "idle") {
              status = "paused";
              result = "[Paused by session exit]";
              logs.push("\n[SYSTEM: Resumed session, marked as paused]\n");
            }

            subagentInstances.set(s.id, {
              ...s,
              status,
              result,
              logs,
              completedAt,
              agent: {
                abort: () => {},
                getCurrentHistoryFilePath: () => s.historyFilePath || "",
              }
            });
          }
          notifySubagentsChanged();
        }

        // Restore pinned messages
        if (Array.isArray(parsed.pinnedMessages) && parsed.pinnedMessages.length > 0) {
          if (this.contextManager) {
            // ContextManager already initialized — restore directly
            this.contextManager.restorePinnedMessages(parsed.pinnedMessages);
          } else {
            // ContextManager not yet initialized — store for later restoration
            this.pendingPinnedMessages = parsed.pinnedMessages;
          }
        }
        this.stripOldToolResults(2);
      } else if (Array.isArray(parsed)) {
        this.messages = parsed;
        this.loadedPlanState = undefined;
        setHistoricalSuperagentTokens(0);
        setMasterTokens(0, 0);
        setLastMasterPromptTokens(0);
        this.stripOldToolResults(2);
      }
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error("Failed to load history:", err);
      }
    }
  }

  /**
   * Truncate old tool results to save tokens while preserving enough context
   * for the AI to understand what was previously found.
   *
   * Strategy:
   * - Keep the most recent `keepCycles` tool round-trips in full.
   * - For older results: keep a meaningful preview (first PREVIEW_LINES lines,
   *   capped at PREVIEW_CHARS chars) so the AI is NOT left completely blind.
   * - Errors always keep at least 300 chars so failure reasons remain visible.
   * - Routine read/list/grep tools age out one cycle sooner (keepCycles - 1)
   *   because their outputs are usually large and transient.
   */
  stripOldToolResults(keepCycles = 2): void {
    /** Max lines to keep in the preview snippet */
    const PREVIEW_LINES = 20;
    /** Hard character cap for the preview snippet */
    const PREVIEW_CHARS = 800;
    /** Max chars to keep from error results */
    const ERROR_CHARS = 300;

    /**
     * Produce a trimmed preview of a successful tool result.
     * Returns the first PREVIEW_LINES lines, capped at PREVIEW_CHARS,
     * with a suffix indicating how much was omitted.
     */
    const makePreview = (result: string): string => {
      if (result.length <= PREVIEW_CHARS) return result;
      const lines = result.split(/\r?\n/);
      const previewLines = lines.slice(0, PREVIEW_LINES);
      let preview = previewLines.join("\n");
      if (preview.length > PREVIEW_CHARS) {
        preview = preview.slice(0, PREVIEW_CHARS);
      }
      const omittedLines = lines.length - previewLines.length;
      const suffix = omittedLines > 0
        ? `\n... [truncated — ${omittedLines} more line(s) omitted for token efficiency]`
        : `\n... [truncated — content too long, omitted for token efficiency]`;
      return preview + suffix;
    };

    const truncateResult = (tr: ToolResult): ToolResult => {
      if (tr.isError) {
        const trimmed = tr.result.length > ERROR_CHARS
          ? `${tr.result.substring(0, ERROR_CHARS)}... [Error truncated]`
          : tr.result;
        return { ...tr, result: trimmed };
      }
      return { ...tr, result: makePreview(tr.result) };
    };

    let toolMessagesSeen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === "tool") {
        toolMessagesSeen++;
        const isRoutine = msg.toolResults?.some(tr =>
          ["read_file", "list_directory", "grep", "list_dir", "grep_search"].includes(tr.name)
        ) || false;

        const currentKeepCycles = isRoutine ? Math.max(1, keepCycles - 1) : keepCycles;

        if (toolMessagesSeen > currentKeepCycles && msg.toolResults) {
          msg.toolResults = msg.toolResults.map(truncateResult);
        }
      } else if (msg.role === "assistant") {
        const isRoutine = msg.toolCalls?.some(tc =>
          ["read_file", "list_directory", "grep", "list_dir", "grep_search"].includes(tc.name)
        ) || false;
        const currentKeepCycles = isRoutine ? Math.max(1, keepCycles - 1) : keepCycles;

        if (msg.toolResults && toolMessagesSeen > currentKeepCycles) {
          msg.toolResults = msg.toolResults.map(truncateResult);
        }
      }
    }
  }

  addMessage(msg: Message): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }
    this.stripOldToolResults(2);
  }

  addUserMessage(content: MessageContent): void {
    this.addMessage({
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }

  addAssistantMessage(
    content: string,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[]
  ): void {
    this.addMessage({
      role: "assistant",
      content,
      toolCalls,
      toolResults,
      timestamp: Date.now(),
    });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getApiMessages(): Array<{
    role: "user" | "assistant";
    content: string;
  }> {
    return this.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: typeof m.content === "string"
          ? m.content
          : m.content.map(p => p.type === "text" ? p.text : "[image]").join(" "),
      }));
  }

  clear(): void {
    this.messages = [];
    this.pendingPinnedMessages = null;
    if (this.contextManager) {
      this.contextManager.restorePinnedMessages([]);
    }
    setHistoricalSuperagentTokens(0);
    setMasterTokens(0, 0);
    setLastMasterPromptTokens(0);
  }

  getMessageTokenEstimate(m: Message): number {
    if (this.contextManager) {
      return this.contextManager.estimateTokens(m);
    }
    const text = typeof m.content === "string"
      ? m.content
      : m.content.map(p => p.type === "text" ? p.text : "").join("");
    return Math.ceil(text.length / 4);
  }

  pruneToTokenLimit(maxTokens: number): void {
    let currentTokens = this.getTokenEstimate();
    if (currentTokens <= maxTokens) return;

    while (this.messages.length > 2 && currentTokens > maxTokens) {
      const first = this.messages[0];
      const firstTokens = this.getMessageTokenEstimate(first);

      if (first.role === "assistant" && first.toolCalls && first.toolCalls.length > 0) {
        this.messages.shift();
        currentTokens -= firstTokens;

        if (this.messages.length > 0 && this.messages[0].role === "tool") {
          const second = this.messages[0];
          const secondTokens = this.getMessageTokenEstimate(second);
          this.messages.shift();
          currentTokens -= secondTokens;
        }
      } else {
        this.messages.shift();
        currentTokens -= firstTokens;
      }
    }
  }

  replaceOldMessagesWithSummary(count: number, summaryText: string): void {
    let keptIndex = count;
    while (keptIndex < this.messages.length && this.messages[keptIndex]?.role === "tool") {
      keptIndex++;
    }
    const kept = this.messages.slice(keptIndex);
    const summaryMsg: Message = {
      role: "user",
      content: `[System Conversation Summary of older turns]:\n${summaryText}`,
      timestamp: Date.now(),
    };
    this.messages = [summaryMsg, ...kept];
  }

  getCompactSummary(limit?: number): string {
    if (this.messages.length === 0) return "No messages yet.";
    const userMsgs = this.messages.filter((m) => m.role === "user").length;
    const assistantMsgs = this.messages.filter(
      (m) => m.role === "assistant"
    ).length;
    const tokens = this.getTokenEstimate();
    let summary = `${this.messages.length} messages (${userMsgs} user, ${assistantMsgs} assistant)\n`;
    summary += `Estimated Token Usage: ${tokens.toLocaleString()} tokens`;
    if (limit) {
      const pct = Math.min(100, (tokens / limit) * 100);
      const barLength = 20;
      const filled = Math.round((pct / 100) * barLength);
      const bar = "█".repeat(filled) + "░".repeat(barLength - filled);
      summary += `\nContext Window Limit : ${limit.toLocaleString()} tokens\n`;
      summary += `Usage: [${bar}] ${pct.toFixed(1)}%`;
    }
    return summary;
  }

  getTokenEstimate(): number {
    if (this.contextManager) {
      const breakdown = this.contextManager.estimateTokensForAll(this.messages);
      return breakdown.total;
    }

    return this.messages.reduce(
      (sum, m) => {
        const text = typeof m.content === "string"
          ? m.content
          : m.content.map(p => p.type === "text" ? p.text : "").join("");
        let total = Math.ceil(text.length / 4);
        // Include tool call arguments in the estimate (legacy path)
        if (m.toolCalls) {
          for (const tc of m.toolCalls) {
            total += Math.ceil(JSON.stringify(tc.args).length / 4);
          }
        }
        // Include tool results in the estimate (legacy path)
        if (m.toolResults) {
          for (const tr of m.toolResults) {
            total += Math.ceil(tr.result.length / 4);
          }
        }
        return sum + total;
      },
      0
    );
  }
}
