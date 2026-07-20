import fs from "fs/promises";
import fsSync from "fs";
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
import { getActivePreset, saveSessionPreset } from "./config/jsonConfig.js";
import { cleanAssistantResponse } from "../utils/text.js";
import { saveSessionToDb, loadSessionFromDb } from "./storage/historyDb.js";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; image: string; mimeType: string }; // image is base64 string
export type MessageContent = string | Array<TextPart | ImagePart>;

/**
 * Convert MessageContent to a plain string.
 * Used by legacy code paths that work only with strings (display, summarization, token counting).
 * Image parts are represented as "[image]" placeholders.
 */
export function contentToString(content: MessageContent): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && p.type === "text" ? p.text : "[image]"))
    .join(" ");
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: MessageContent;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
  reasoning?: string;
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
  /**
   * When true, buildMessages() in agent.ts converts large tool results to images
   * on-the-fly via vision token saving. stripOldToolResults uses a much higher
   * keepCycles so the AI can see full outputs via vision rather than a text preview.
   */
  private visionMode = false;

  /** Called by agent.ts each iteration once vision capability is known. */
  setVisionMode(enabled: boolean): void {
    this.visionMode = enabled;
  }

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
      try {
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "", "utf-8");
      } catch {}
      const sid = path.basename(filePath, ".json");
      const userMessages = this.messages.filter((m) => m.role === "user");
      const firstUser = userMessages[0];
      const lastUser = userMessages[userMessages.length - 1];
      const firstUserText = firstUser ? contentToString(firstUser.content).trim() : "";
      const lastUserText = lastUser ? contentToString(lastUser.content).trim() : "";
      const preview = lastUser
        ? lastUserText.slice(0, 60).replace(/\n/g, " ") + (lastUserText.length > 60 ? "…" : "")
        : "(no user messages)";

      const cleanName = sid.replace(/_\d+$/, "");
      const folderPathName = cleanName
        .replace(/^([a-zA-Z])__/, "$1:\\")
        .replace(/^_+/, "/")
        .replace(/_/g, "/");

      const formatSnippet = (text: string, maxLen = 30) => {
        const clean = text.replace(/\n/g, " ").trim();
        return clean.length > maxLen ? clean.slice(0, maxLen) + "…" : clean;
      };

      let displayName: string;
      if (firstUserText && lastUserText && firstUserText !== lastUserText) {
        displayName = `[First: ${formatSnippet(firstUserText, 30)}] → [Last: ${formatSnippet(lastUserText, 30)}]`;
      } else if (firstUserText) {
        displayName = formatSnippet(firstUserText, 60);
      } else {
        displayName = folderPathName;
      }

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

      const pinnedMessages = this.contextManager
        ? this.contextManager.serializePinnedMessages()
        : (this.pendingPinnedMessages || []);

      let activePreset: any = undefined;
      try {
        const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
        const mode = isMulti ? "multi" : "single";
        activePreset = getActivePreset(mode);
      } catch {}

      const extraData = {
        superagents: serializedSuperagents,
        subagents: serializedSubagents,
        historicalSuperagentTokens,
        masterPromptTokens,
        masterCompletionTokens,
        lastMasterPromptTokens,
        lastCapturedTimestamp: this.lastCapturedTimestamp,
      };

      saveSessionToDb(
        {
          id: sid,
          filePath,
          displayName,
          messageCount: this.messages.length,
          lastModified: Date.now(),
          preview,
          workingDirectory,
          planState,
          activePreset: activePreset ? JSON.stringify(activePreset) : undefined,
          extraData: JSON.stringify(extraData),
        },
        this.messages.map((m, idx) => ({
          sessionId: sid,
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
          toolResults: m.toolResults ? JSON.stringify(m.toolResults) : undefined,
          reasoning: m.reasoning,
          timestamp: m.timestamp || Date.now(),
          sequenceOrder: idx,
        })),
        pinnedMessages ? JSON.stringify(pinnedMessages) : undefined
      );
    } catch (err) {
      console.error("Failed to save history to SQLite:", err);
    }
  }

  saveToFileSync(filePath: string, planState?: "IDLE" | "PLANNING_PENDING" | "APPROVED", workingDirectory?: string): void {
    try {
      try {
        fsSync.mkdirSync(path.dirname(filePath), { recursive: true });
        fsSync.writeFileSync(filePath, "");
      } catch {}
      const sid = path.basename(filePath, ".json");
      const userMessages = this.messages.filter((m) => m.role === "user");
      const firstUser = userMessages[0];
      const lastUser = userMessages[userMessages.length - 1];
      const firstUserText = firstUser ? contentToString(firstUser.content).trim() : "";
      const lastUserText = lastUser ? contentToString(lastUser.content).trim() : "";
      const preview = lastUser
        ? lastUserText.slice(0, 60).replace(/\n/g, " ") + (lastUserText.length > 60 ? "…" : "")
        : "(no user messages)";

      const cleanName = sid.replace(/_\d+$/, "");
      const folderPathName = cleanName
        .replace(/^([a-zA-Z])__/, "$1:\\")
        .replace(/^_+/, "/")
        .replace(/_/g, "/");

      const formatSnippet = (text: string, maxLen = 30) => {
        const clean = text.replace(/\n/g, " ").trim();
        return clean.length > maxLen ? clean.slice(0, maxLen) + "…" : clean;
      };

      let displayName: string;
      if (firstUserText && lastUserText && firstUserText !== lastUserText) {
        displayName = `[First: ${formatSnippet(firstUserText, 30)}] → [Last: ${formatSnippet(lastUserText, 30)}]`;
      } else if (firstUserText) {
        displayName = formatSnippet(firstUserText, 60);
      } else {
        displayName = folderPathName;
      }

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

      const pinnedMessages = this.contextManager
        ? this.contextManager.serializePinnedMessages()
        : (this.pendingPinnedMessages || []);

      let activePreset: any = undefined;
      try {
        const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
        const mode = isMulti ? "multi" : "single";
        activePreset = getActivePreset(mode);
      } catch {}

      const extraData = {
        superagents: serializedSuperagents,
        subagents: serializedSubagents,
        historicalSuperagentTokens,
        masterPromptTokens,
        masterCompletionTokens,
        lastMasterPromptTokens,
        lastCapturedTimestamp: this.lastCapturedTimestamp,
      };

      saveSessionToDb(
        {
          id: sid,
          filePath,
          displayName,
          messageCount: this.messages.length,
          lastModified: Date.now(),
          preview,
          workingDirectory,
          planState,
          activePreset: activePreset ? JSON.stringify(activePreset) : undefined,
          extraData: JSON.stringify(extraData),
        },
        this.messages.map((m, idx) => ({
          sessionId: sid,
          role: m.role,
          content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          toolCalls: m.toolCalls ? JSON.stringify(m.toolCalls) : undefined,
          toolResults: m.toolResults ? JSON.stringify(m.toolResults) : undefined,
          reasoning: m.reasoning,
          timestamp: m.timestamp || Date.now(),
          sequenceOrder: idx,
        })),
        pinnedMessages ? JSON.stringify(pinnedMessages) : undefined
      );
    } catch (err) {
      console.error("Failed to save history synchronously to SQLite:", err);
    }
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const sid = path.basename(filePath, ".json");
      const dbResult = loadSessionFromDb(sid);
      if (dbResult.session) {
        this.messages = dbResult.messages.map((m) => {
          let content: MessageContent = m.content;
          if (m.content.startsWith("[") || m.content.startsWith("{")) {
            try { content = JSON.parse(m.content); } catch {}
          }
          let toolCalls = undefined;
          if (m.toolCalls) {
            try { toolCalls = JSON.parse(m.toolCalls); } catch {}
          }
          let toolResults = undefined;
          if (m.toolResults) {
            try { toolResults = JSON.parse(m.toolResults); } catch {}
          }
          return {
            role: m.role as any,
            content,
            toolCalls,
            toolResults,
            reasoning: m.reasoning,
            timestamp: m.timestamp,
          };
        });
        this.loadedPlanState = dbResult.session.planState as any;
        if (dbResult.pinnedMessagesJson) {
          try {
            const pinned = JSON.parse(dbResult.pinnedMessagesJson);
            if (Array.isArray(pinned)) this.pendingPinnedMessages = pinned;
          } catch {}
        }
        if (dbResult.session.activePreset) {
          try {
            const preset = JSON.parse(dbResult.session.activePreset);
            const isMulti = process.argv.includes("--multi") || process.env.SUPERAGENT_MULTI === "true";
            const mode = isMulti ? "multi" : "single";
            saveSessionPreset(mode, preset);
          } catch {}
        }
        if (dbResult.session.extraData) {
          try {
            const extra = JSON.parse(dbResult.session.extraData);
            this.lastCapturedTimestamp = extra.lastCapturedTimestamp || 0;
            setHistoricalSuperagentTokens(extra.historicalSuperagentTokens || 0);
            setMasterTokens(extra.masterPromptTokens || 0, extra.masterCompletionTokens || 0);
            setLastMasterPromptTokens(extra.lastMasterPromptTokens || 0);
            if (Array.isArray(extra.superagents)) {
              superagentInstances.clear();
              for (const s of extra.superagents) {
                let status = s.status;
                let result = s.result;
                const logs = [...(s.logs || [])];
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
                  agent: {
                    abort: () => {},
                    getCurrentHistoryFilePath: () => s.historyFilePath || "",
                  }
                });
              }
              notifySuperagentsChanged();
            }
            if (Array.isArray(extra.subagents)) {
              subagentInstances.clear();
              for (const s of extra.subagents) {
                let status = s.status;
                let result = s.result;
                const logs = [...(s.logs || [])];
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
                  agent: {
                    abort: () => {},
                    getCurrentHistoryFilePath: () => s.historyFilePath || "",
                  }
                });
              }
              notifySubagentsChanged();
            }
          } catch {}
        }
        this.stripOldToolResults(2);
      }
    } catch (err) {
      console.error("Failed to load history from SQLite:", err);
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
   *
   * VISION MODE (setVisionMode(true)):
   * When the active model supports vision and autoVisionTokenSaving is on,
   * agent.ts buildMessages() converts large tool results to PNG images
   * on-the-fly before sending to the API. In this mode we keep results
   * intact for VISION_KEEP_CYCLES rounds so the AI can always read full
   * outputs through vision — no preview truncation until results are truly
   * ancient. The storage overhead is acceptable because images are generated
   * dynamically (never stored in history), and ContextManager handles
   * compaction for very long sessions.
   */
  stripOldToolResults(keepCycles = 2): void {
    /**
     * How many full cycles to retain when vision token saving is active.
     * buildMessages() will image-convert anything large within this window.
     */
    const VISION_KEEP_CYCLES = 8;
    /** Effective keep threshold — higher when vision handles large content. */
    const effectiveKeepCycles = this.visionMode ? VISION_KEEP_CYCLES : keepCycles;
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
      if (tr.result.includes("[truncated —") || tr.result.includes("[Error truncated]")) {
        return tr;
      }
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

        const currentKeepCycles = isRoutine ? Math.max(1, effectiveKeepCycles - 1) : effectiveKeepCycles;

        if (toolMessagesSeen > currentKeepCycles && msg.toolResults) {
          msg.toolResults = msg.toolResults.map(truncateResult);
        }
      } else if (msg.role === "assistant") {
        const isRoutine = msg.toolCalls?.some(tc =>
          ["read_file", "list_directory", "grep", "list_dir", "grep_search"].includes(tc.name)
        ) || false;
        const currentKeepCycles = isRoutine ? Math.max(1, effectiveKeepCycles - 1) : effectiveKeepCycles;

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
    toolResults?: ToolResult[],
    reasoning?: string
  ): void {
    const cleanedContent = cleanAssistantResponse(content);
    this.addMessage({
      role: "assistant",
      content: cleanedContent,
      toolCalls,
      toolResults,
      timestamp: Date.now(),
      reasoning,
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
