import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import { execa } from "execa";
import { renderTextToImageBase64, sliceTextIntoPages, minifyTextForImage } from "../utils/textToImage.js";
import { captureGitSnapshot, getGitDiffSummary, type GitSnapshot } from "./agent/GitUtils.js";
import fs from "fs";
import crypto from "crypto";
import { getConfig, getContextWindowLimit, getGlobalConfigDir, ensureGlobalConfigDir, getModelInstanceForTier, getModelInstanceForString, loadAgentSkills, getSettings, getTierModel, getTierModelConfig, getPackageRootDir, getModelConnectionDetailsForTier, clearHistoryCache, DEFAULT_VISION_TOKEN_SAVING_THRESHOLD, getDynamicVisionThreshold } from "./config.js";
import { GuidelineLoader } from "./agent/GuidelineLoader.js";
import { Conversation } from "./conversation.js";
import { getToolDefinitions, backgroundTasks, isTaskInWorkspace } from "./tools.js";
import type { Tool, AgentTier, ViolationRecord } from "./tools.js";
import { rateLimiter, concurrencyLimiter } from "./rateLimiter.js";
import {
  executeToolCall,
  getToolDescription,
  isDangerousCommand,
  MODIFYING_TOOLS,
  isToolCallOutOfBounds,
  isModelConfigAccess,
  isSensitiveEnvFileAccess,
  normalizeAndCheckSubpath,
} from "./permissions.js";
import type { ToolCall, ToolResult } from "./conversation.js";
import { contentToString, Message } from "./conversation.js";
import { getRMemoryClient, getRMemorySessionKey, isRmemoryActive } from "./rmemoryUtil.js";
import { AsyncLocalStorage } from "async_hooks";
import { allTasksCompleted, archiveCompletedTasks, getTaskHistoryPath } from "./taskChecklist.js";
import { createCheckpoint } from "./checkpoints.js";
import { RealtimeAdvisor } from "./advisor.js";

import { PathResolver } from "./agent/PathResolver.js";
import { HistoryManager } from "./agent/HistoryManager.js";
import { RequestProcessor } from "./agent/RequestProcessor.js";
import { ContextBuilder } from "./agent/ContextBuilder.js";
import { isRetryableError as isRetryableErrorHelper, parsePayloadLimitBytes as parsePayloadLimitBytesHelper, answerQuestionAsMaster as answerQuestionAsMasterHelper } from "./agent/AgentUtils.js";
import { checkPlanStructure } from "./agent/PlanValidator.js";
import { MessageBuilder } from "./agent/MessageBuilder.js";
import { HistoryCompactor } from "./agent/HistoryCompactor.js";
import {
  AgentEvent,
  PermissionHandler,
  QuestionItem,
  QuestionHandler,
  formatError
} from "./agent/AgentEvents.js";

export { checkPlanStructure };
export { captureGitSnapshot, getGitDiffSummary, type GitSnapshot } from "./agent/GitUtils.js";
export {
  type AgentEvent,
  type PermissionHandler,
  type QuestionItem,
  type QuestionHandler,
  formatError
};

export const agentLocalStorage = new AsyncLocalStorage<Agent>();

function isRetryableError(err: unknown): boolean {
  return isRetryableErrorHelper(err);
}

export function parsePayloadLimitBytes(msg: string): number | null {
  return parsePayloadLimitBytesHelper(msg);
}


export class Agent {
  public detectedPayloadLimitBytes?: number;
  public delegationDepth = 0;
  /** Agent tier in the 3-tier hierarchy: master | superagent | subagent */
  public tier: AgentTier = "master";
  /** Whether the agent is running in multi-agent orchestrator mode */
  public isMultiAgent: boolean = false;
  /** For superagents: absolute path to the isolated git worktree */
  public worktreePath: string | null = null;
  /** For subagents: subagent type name (e.g. researcher, coder, reviewer) */
  public subagentType?: string;
  public workingDirectory: string;
  public planState: "IDLE" | "PLANNING_PENDING" | "APPROVED" = "IDLE";
  public isSimpleTask: boolean = false;
  public simpleTaskApproved: boolean = false;
  /** Multi-category classification result from the request classifier */
  public currentClassification: import("./requestClassifier.js").ClassificationResult | null = null;
  public lastSpeed: number | null = null;
  public goalMode: string | null = null;
  public goalMaxIterations: number = 200;
  public wasRunningBeforeAbort = false;
  public allowSessionOutOfBounds = false;
  /** Separate flag — file write tools (write_to_file, replace_file_content, etc.) are NEVER granted session-wide bypass. */
  public allowSessionFileWriteOutOfBounds = false;
  public allowSessionEnvAccess = false;
  public allowSessionDangerous = false;
  public workspaceCache: any = null;
  private workspaceCacheNeedsUpdate: boolean = true;
  public disableWorkspaceDiscovery: boolean = !!process.env.VITEST;
  public conversation: Conversation;
  private customSystemPrompt?: string;
  /** Custom tool list for this agent (tier-specific). Undefined = use allTools. */
  private customTools?: Tool[];
  private get config() {
    return getConfig();
  }
  public onEvent: (event: AgentEvent) => void;
  private onPermission: PermissionHandler;
  private onQuestion: QuestionHandler;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private pendingMessagesQueue: (string | import("./conversation.js").MessageContent)[] = [];
  private textLogBuffer = "";
  /** Flag set when completed tasks were just archived — used to inject system prompt hint */
  private tasksJustArchived: boolean = false;
  /** Number of tasks that were archived in the last sendMessage call */
  private archivedTaskCount: number = 0;
  /** Timestamp of last auto-checkpoint (for cooldown) */
  private lastAutoCheckpointAt: number = 0;
  /** Minimum interval between auto-checkpoints in ms */
  private static readonly AUTO_CHECKPOINT_COOLDOWN_MS = 10_000;
  private skillContentCache: Map<string, string> = new Map();
  /** Keys of skills that were successfully preloaded into guidelinesText */
  private preloadedSkillKeys: Set<string> = new Set();
  private gitStartSnapshot: Record<string, { added: number; deleted: number }> | null = null;
  private advisor = new RealtimeAdvisor();

  public approvePlan(): void {
    this.planState = "APPROVED";
  }

  public dispose(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.skillContentCache.clear();
    this.preloadedSkillKeys.clear();
  }



  private buildGuidelinesText(userQuery?: string): string {
    return GuidelineLoader.buildGuidelines({
      workingDirectory: this.workingDirectory,
      workspaceCacheAgentsMd: this.workspaceCache?.agentsMd,
      isSimpleTask: this.isSimpleTask,
      planState: this.planState,
      userQuery,
      tier: this.tier,
      skillContentCache: this.skillContentCache,
      preloadedSkillKeys: this.preloadedSkillKeys
    });
  }

  private markPreloadedSkillsInList(skillsPrompt: string): string {
    return GuidelineLoader.markPreloadedSkills(skillsPrompt, this.preloadedSkillKeys);
  }

  /**
   * Answer a question on behalf of a Subagent/Superagent using the Master's
   * LLM and context (implementation plan + recent conversation). Does NOT
   * pollute Master's conversation history — uses a standalone generateText call.
   *
   * Returns the selected option string.
   */
  public async answerQuestionAsMaster(
    question: string,
    options: string[],
    context: any
  ): Promise<string> {
    return answerQuestionAsMasterHelper(this, question, options, context);
  }


  private flushTextLogBuffer(): void {
    if (this.textLogBuffer) {
      this.writeToLogFile("TEXT", this.textLogBuffer.trim());
      this.textLogBuffer = "";
    }
  }

  constructor(
    onEvent: (event: AgentEvent) => void,
    onPermission: PermissionHandler,
    onQuestion: QuestionHandler,
    customSystemPrompt?: string,
    customTools?: Tool[],
    workingDirectory?: string
  ) {
    this.customSystemPrompt = customSystemPrompt;
    this.customTools = customTools;
    this.workingDirectory = workingDirectory || getConfig().workingDirectory;
    this.conversation = new Conversation();
    // ContextManager initializes async via ensureContextManager() on first use
    this.onEvent = (event: AgentEvent) => {
      if (event.type !== "text") {
        this.flushTextLogBuffer();
      }

      if (event.type === "text") {
        this.textLogBuffer += event.content;
      } else if (event.type === "tool_start") {
        const argsStr = JSON.stringify(event.toolCall.args);
        this.writeToLogFile("TOOL_START", `Tool: ${event.toolCall.name}, Description: ${event.description}, Args: ${argsStr}`);
      } else if (event.type === "tool_end") {
        const success = !event.toolResult.isError;
        const resultStr = typeof event.toolResult.result === "string"
          ? event.toolResult.result
          : JSON.stringify(event.toolResult.result);
        const truncatedResult = resultStr.length > 500 ? resultStr.substring(0, 500) + "... (truncated)" : resultStr;
        this.writeToLogFile("TOOL_END", `Tool: ${event.toolResult.name}, Success: ${success}, Result: ${truncatedResult}`);
      } else if (event.type === "error") {
        this.writeToLogFile("ERROR", event.message);
      } else if (event.type === "permission_required") {
        this.writeToLogFile("PERMISSION_REQUIRED", `Tool: ${event.toolCall.name}, Description: ${event.description}`);
      } else if (event.type === "illegal_operation") {
        const v = event.violation;
        this.writeToLogFile("ILLEGAL_OPERATION", `[${v.severity}] ${v.reason} | tool:${v.toolName} | ${v.description}`);
      } else if (event.type === "token_usage") {
        let logMsg = `Prompt Tokens: ${event.promptTokens}, Completion Tokens: ${event.completionTokens}`;
        if (event.durationMs !== undefined) {
          logMsg += `, Duration: ${event.durationMs}ms`;
        }
        this.writeToLogFile("TOKEN_USAGE", logMsg);
      } else if (event.type === "goal_done") {
        this.writeToLogFile("GOAL_DONE", `Goal: ${event.goal}\nSummary: ${event.summary}`);
      } else if (event.type === "done") {
        this.writeToLogFile("DONE", "Agent execution iteration/loop done");
      } else if (event.type === "checkpoint_auto") {
        this.writeToLogFile("CHECKPOINT_AUTO", `ID: ${event.id}, Name: ${event.name}`);
      }
      onEvent(event);
    };
    this.onPermission = onPermission;
    this.onQuestion = onQuestion;

    // Register this agent's event handler for progress updates from utilities
    import("./tools/state.js").then(({ registerProgressCallback }) => {
      registerProgressCallback((event) => this.onEvent(event));
    }).catch(() => {});

    // Asynchronously pre-load/warm up the local 51M classifier model in the background
    if (process.env.NODE_ENV !== "test") {
      import("./requestClassifier.js")
        .then(({ warmUpClassifier }) => warmUpClassifier((event) => this.onEvent(event)))
        .catch(() => {});
    }
  }

  private async initContextManager(): Promise<void> {
    const modelLimit = getContextWindowLimit(this.config.model);
    const historyFilePath = this.getCurrentHistoryFilePath().replace(/\.json$/, ".compaction.json");
    await this.conversation.initContextManager({
      model: this.config.model,
      contextWindowLimit: modelLimit,
      historyFilePath,
      llmModel: this.getModel(),
      abortSignal: this.abortController?.signal,
    });
  }

  /**
   * Emit a text event into the live UI stream.
   * Used by tools that need to show progress/output while executing.
   */
  public emitToolLog(msg: string): void {
    this.onEvent({ type: "text", content: msg });
  }

  public writeToLogFile(level: string, message: string): void {
    try {
      ensureGlobalConfigDir();
      const logPath = path.join(getGlobalConfigDir(), "superagent.log");
      const timestamp = new Date().toISOString();
      const tier = this.tier;
      const depth = this.delegationDepth;
      const multi = this.isMultiAgent;
      const worktree = this.worktreePath || "-";
      const subagentType = this.subagentType || "-";
      const prefix = `[${timestamp}] [tier:${tier}] [depth:${depth}] [multi:${multi}] [worktree:${worktree}] [subagentType:${subagentType}] [${level}]`;
      const lines = message.split("\n");
      const formattedLines = lines.map(line => `${prefix} ${line}`).join("\n") + "\n";
      fs.appendFileSync(logPath, formattedLines, "utf-8");
    } catch (err) {
      // Ignore log writing errors to prevent crashing the agent
    }
  }

  /**
   * Emit a structured illegal_operation event when a child agent's operation
   * is blocked. This propagates to the parent agent's event handler in
   * multi-agent mode so the parent can track violations and take action.
   */
  private emitViolation(
    reason: string,
    toolName: string,
    description: string,
    severity: "warning" | "critical" = "warning",
    meta?: Record<string, unknown>
  ): void {
    const violation: ViolationRecord = {
      timestamp: Date.now(),
      reason,
      toolName,
      description,
      severity,
      meta,
    };
    this.onEvent({ type: "illegal_operation", violation });
  }

  private currentHistoryFilePath: string | null = null;
  private contextManagerInitFailed = false;

  public getPlanFilePath(): string {
    return PathResolver.getPlanFilePath(this);
  }


  public async getActiveTools(): Promise<Tool[]> {
    let tools: Tool[] = [];
    if (this.customTools) {
      tools = [...this.customTools];
    } else {
      const { masterToolset, superagentToolset, subagentToolsets, defaultSubagentToolset } = await import("./tools/toolsets.js");
      if (this.tier === "master") {
        tools = [...masterToolset];
      } else if (this.tier === "superagent" || this.tier === "single") {
        tools = [...superagentToolset];
      } else if (this.tier === "subagent") {
        tools = [...((this.subagentType && subagentToolsets[this.subagentType]) || defaultSubagentToolset)];
      }
    }

    if (!(await isRmemoryActive())) {
      tools = tools.filter((t) => !t.name.startsWith("rmemory_"));
    }

    const isServerMode = process.argv.some(arg => arg === "--server" || arg === "-s" || arg === "--server-only") || !!process.env.VITEST;
    if (!isServerMode) {
      tools = tools.filter((t) => !t.name.startsWith("control_browser_"));
    }
    return tools;
  }

  public getTaskFilePath(): string {
    return PathResolver.getTaskFilePath(this);
  }

  public getWalkthroughFilePath(): string {
    return PathResolver.getWalkthroughFilePath(this);
  }

  public getTaskHistoryFilePath(): string {
    return PathResolver.getTaskHistoryFilePath(this);
  }


  public resolveHistoryFilePath(autoResume: boolean | string): string {
    return PathResolver.resolveHistoryFilePath(this, autoResume);
  }

  public getCurrentHistoryFilePath(): string {
    return PathResolver.getCurrentHistoryFilePath(this);
  }


  getConversationMessages(): Message[] {
    return this.conversation.getMessages();
  }

  async loadHistory(autoResume: boolean | string = false): Promise<void> {
    await HistoryManager.loadHistory(this, autoResume);
  }

  async loadHistoryFromPath(filePath: string): Promise<void> {
    await HistoryManager.loadHistoryFromPath(this, filePath);
  }

  async saveHistory(): Promise<void> {
    await HistoryManager.saveHistory(this);
  }

  saveHistorySync(): void {
    HistoryManager.saveHistorySync(this);
  }


  public getModel() {
    return getModelInstanceForTier(this.tier, this.delegationDepth, this.subagentType, !this.isMultiAgent);
  }

  async sendMessage(userInput: string | import("./conversation.js").MessageContent): Promise<void> {
    if (this.isRunning) {
      const msgText = typeof userInput === "string" ? userInput : "[multimodal message]";
      this.pendingMessagesQueue.push(userInput);
      this.writeToLogFile("INFO", `Message queued (agent is running): "${msgText.substring(0, 80)}..."`);
      return;
    }
    const proceed = await RequestProcessor.processRequest(this, userInput);
    if (!proceed) return;

    this.isRunning = true;
    this.abortController = new AbortController();

    const signal = this.abortController?.signal;
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => {
        const err = new Error("AbortError");
        err.name = "AbortError";
        reject(err);
      };
      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener("abort", onAbort);
      }
    });

    try {
      await Promise.race([
        agentLocalStorage.run(this, () => this.runAgentLoop()),
        abortPromise
      ]);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        this.onEvent({ type: "text", content: "\n\n[Interrupted]" });
        await this.saveHistory();
      } else {
        const message = formatError(err);
        this.writeToLogFile("AGENT_ERROR", message);
        this.onEvent({ type: "error", message });
        this.conversation.addMessage({
          role: "system",
          content: `[ERROR] ${message}`,
          timestamp: Date.now(),
        });
        await this.saveHistory();
      }
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      this.flushTextLogBuffer();
      this.isRunning = false;
      this.abortController = null;

      if (this.pendingMessagesQueue.length > 0) {
        const queued = this.pendingMessagesQueue.shift()!;
        const logText = typeof queued === "string" ? queued : "[multimodal message]";
        this.writeToLogFile("INFO", `Auto-sending queued message: "${logText.substring(0, 80)}..."`);
        this.onEvent({ type: "text", content: "\n[SYS] Resuming with queued approval message...\n" });
        await this.sendMessage(queued);
      } else {
        this.onEvent({ type: "done" });
      }
    }
  }


  private async runAgentLoop(): Promise<void> {
    this.advisor.reset();
    const signal = this.abortController?.signal;
    const isGoalMode = !!this.goalMode;
    const defaultMax = getSettings().maxIterations === 0 ? Infinity : (getSettings().maxIterations || 50);
    const maxIterations = isGoalMode ? this.goalMaxIterations : defaultMax;
    const maxIterationsStr = maxIterations === Infinity ? "unlimited" : maxIterations.toString();
    let continueCount = 0;
    // In goal mode, allow many more auto-continues without prompting the user
    const maxContinues = isGoalMode ? 10 : 3;

    let baseSystemPrompt = this.customSystemPrompt || this.config.systemPrompt || "";

    const userMessages = this.conversation.getMessages().filter(m => m.role === "user");
    const recentUserMessages = userMessages.slice(-3);
    const queryStr = recentUserMessages.map(m => contentToString(m.content)).join(" ");

    // Build (or reuse cached) guidelines text first so that preloadedSkillKeys is
    // populated before we call markPreloadedSkillsInList below.
    const guidelinesText = this.buildGuidelinesText(queryStr);

    // Dynamically load filtered skills based on the user's initial or recent queries in the history
    if (!baseSystemPrompt.includes("INSTALLED AGENT SKILLS:")) {
      const skillsPrompt = loadAgentSkills(this.subagentType, this.tier, queryStr, this.isMultiAgent);
      if (skillsPrompt) {
        baseSystemPrompt += "\n\n" + skillsPrompt;
      }
    }

    // For ALL agents: mark already-preloaded skills in the INSTALLED AGENT SKILLS list
    // (which is present either via customSystemPrompt injection or loaded above)
    // so the AI knows not to re-read files already injected into the context above.
    if (baseSystemPrompt.includes("INSTALLED AGENT SKILLS:")) {
      baseSystemPrompt = this.markPreloadedSkillsInList(baseSystemPrompt);
    }

    // Load scratchpad content if it exists
    let scratchpadText = "";
    try {
      const scratchpadPath = path.resolve(this.workingDirectory, "scratch", "scratchpad.md");
      if (fs.existsSync(scratchpadPath)) {
        scratchpadText = fs.readFileSync(scratchpadPath, "utf-8");
      }
    } catch {
      // Ignored
    }

    // Goal mode addendum injected into every iteration's system prompt
    const goalModeAddendum = isGoalMode
      ? `

🎯 GOAL MODE ACTIVE:
Your PRIMARY OBJECTIVE is: "${this.goalMode}"

CRITICAL GOAL MODE RULES:
- You MUST NOT stop until this goal is FULLY and VERIFIABLY achieved.
- After every action, ask yourself: "Is the goal complete?" — if not, keep going.
- Self-verify completion: run tests, check outputs, read files to confirm correctness.
- If you hit an error, diagnose and fix it. Never give up on the goal.
- Only declare completion when you have concrete evidence the goal is done.
- Use subagents aggressively to parallelize work and meet the goal faster.
- At the end of your work, produce a concise GOAL COMPLETION REPORT starting with "GOAL_COMPLETE:" or "GOAL_PARTIAL:" followed by a brief summary of what was achieved.
`
      : "";

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted) {
          const err = new Error("AbortError");
          err.name = "AbortError";
          throw err;
        }

        const {
          finalSystemPrompt: builderSystemPrompt,
          messages: builderMessages,
          toolDefs: builderToolDefs,
          filteredToolDefs: builderFilteredToolDefs,
          supportsNativeTools: builderSupportsNativeTools,
          dynamicContext: builderDynamicContext,
        } = await ContextBuilder.buildContext(this, signal);

        let finalSystemPrompt = builderSystemPrompt;
        let messages = builderMessages;
        const toolDefs = builderToolDefs;
        const filteredToolDefs = builderFilteredToolDefs;
        const supportsNativeTools = builderSupportsNativeTools;
        const dynamicContext = builderDynamicContext;

        const injectDynamicContext = (msgs: CoreMessage[]) => {
          if (msgs.length > 0) {
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg.role === "user") {
              if (typeof lastMsg.content === "string") {
                lastMsg.content += dynamicContext;
              } else if (Array.isArray(lastMsg.content)) {
                const lastPart = lastMsg.content[lastMsg.content.length - 1];
                if (lastPart && lastPart.type === "text") {
                  lastPart.text += dynamicContext;
                } else {
                  lastMsg.content.push({ type: "text", text: dynamicContext });
                }
              }
            } else if (lastMsg.role === "tool") {
              msgs.push({
                role: "user",
                content: dynamicContext,
              });
            }
          } else {
            msgs.push({
              role: "user",
              content: dynamicContext,
            });
          }
        };

        const modelInstance = this.getModel();
        const modelName = modelInstance ? modelInstance.modelId : "";
        const supportsVision = this.modelSupportsVision(modelName);
        const useVisionTokenSaving = supportsVision && (getSettings().autoVisionTokenSaving ?? false) && (this.detectedPayloadLimitBytes === undefined || this.detectedPayloadLimitBytes >= 500 * 1024);
        let prependSystemMessage: any = null;
        let prependSystemAssistantMessage: any = null;


        // System prompt is kept as text only for both Mode 1 and Mode 2 as requested by user.
        if (useVisionTokenSaving) {
          const visionNotice = "\n\nCRITICAL CONVERSATION PROMPT: The entire conversation history, messages, and dynamic execution context have been compiled and rendered as WebP images inside the user message to save input tokens. You must use your vision capability to read the text inside these images carefully to see all prior messages, inputs, dynamic context, and results. Proceed to execute the next step or tool call directly. Do not mention that the prompt was rendered as images or reference the image format in your response.";
          finalSystemPrompt += visionNotice;
        }

        let textContent = "";
        let reasoningContent = ""; // DeepSeek R1 thinking tokens — displayed in UI but NOT stored in history
        const toolCalls: ToolCall[] = [];

        if (this.config.disableStreaming) {
          let attempt = 0;
          const maxRetries = 10;
          const baseDelay = 5000;
          let currentByteBudget = 3 * 1024 * 1024; // 3.0 MB initial safety threshold
          let payload413Count = 0;

          while (true) {
            let concurrencyAcquired = false;
            try {
              if (getSettings().concurrencyLimit === 1) {
                await concurrencyLimiter.acquire();
                concurrencyAcquired = true;
              }
              await rateLimiter.acquire(1);

              const startTime = Date.now();
              const modelInstance = this.getModel();
              const isTest = !!process.env.VITEST;
              const isAnthropic = !isTest && modelInstance && (modelInstance.provider === "anthropic" || (typeof modelInstance.provider === "string" && modelInstance.provider.includes("anthropic")));

              const callMessages = [...messages];
              if (prependSystemMessage) {
                if (prependSystemAssistantMessage) {
                  callMessages.unshift(prependSystemMessage, prependSystemAssistantMessage);
                } else {
                  callMessages.unshift(prependSystemMessage);
                }
              }

              const result = await generateText({
                model: modelInstance,
                system: finalSystemPrompt,
                messages: callMessages,
                ...(supportsNativeTools && {
                  tools: Object.fromEntries(
                    filteredToolDefs.map((t) => [
                      t.name,
                      {
                        description: t.description,
                        parameters: jsonSchema(t.input_schema),
                      },
                    ])
                  ),
                }),
                maxSteps: 1,
                abortSignal: signal,
                ...(isAnthropic && {
                  experimental_providerMetadata: {
                    anthropic: { cacheControl: { type: "ephemeral" } },
                  },
                }),
              });

              textContent = result.text || "";
              reasoningContent = (result as any).reasoning || "";
              if (reasoningContent) {
                this.onEvent({ type: "reasoning", content: reasoningContent });
              }
              if (textContent) {
                try {
                  const { parseXmlToolCalls } = await import("../utils/xmlToolParser.js");
                  const parsed = parseXmlToolCalls(textContent, toolDefs);
                  if (parsed.toolCalls.length > 0) {
                    this.writeToLogFile(
                      "INFO",
                      `Parsed ${parsed.toolCalls.length} XML tool calls from non-streamed response`
                    );
                    for (const tc of parsed.toolCalls) {
                      const isDuplicate = toolCalls.some(
                        (existing) =>
                          existing.name === tc.name &&
                          JSON.stringify(existing.args) === JSON.stringify(tc.args)
                      );
                      if (!isDuplicate) {
                        toolCalls.push(tc);
                      }
                    }
                  }
                  textContent = parsed.cleanText;
                } catch (err: any) {
                  this.writeToLogFile("WARN", `Failed to parse XML tool calls: ${err.message}`);
                }
                if (textContent) {
                  this.onEvent({ type: "text", content: textContent });
                }
              }
              if (result.toolCalls) {
                for (const tc of result.toolCalls) {
                  toolCalls.push({
                    id: tc.toolCallId,
                    name: tc.toolName,
                    args: tc.args as Record<string, unknown>,
                  });
                }
              }
              const durationMs = Date.now() - startTime;
              const usage = result.usage;
              if (usage) {
                if (durationMs > 0 && usage.completionTokens > 0) {
                  this.lastSpeed = usage.completionTokens / (durationMs / 1000);
                }
                this.onEvent({
                  type: "token_usage",
                  promptTokens: usage.promptTokens || 0,
                  completionTokens: usage.completionTokens || 0,
                  durationMs,
                });
              }

              if (!textContent.trim() && toolCalls.length === 0) {
                throw new Error("Empty response from model");
              }

              break;
            } catch (err: unknown) {
              if (err instanceof Error && err.name === "AbortError") {
                throw err;
              }
              const rawMsg = formatError(err);
              const isPayloadTooLarge = rawMsg.toLowerCase().includes("payload too large") || 
                                        rawMsg.toLowerCase().includes("request entity too large") || 
                                        rawMsg.toLowerCase().includes("request too large") || 
                                        rawMsg.toLowerCase().includes("status 413") ||
                                        rawMsg.toLowerCase().includes("status: 413");
              const isOverloaded = rawMsg.toLowerCase().includes("our servers are currently overloaded") || rawMsg.toLowerCase().includes("overloaded_error");
              const isEmptyResponse = (err instanceof Error && err.message === "Empty response from model") ||
                rawMsg.toLowerCase().includes("model output must contain") ||
                rawMsg.toLowerCase().includes("these cannot both be empty");
              const isRetryable = isRetryableError(err) || isEmptyResponse || isOverloaded || isPayloadTooLarge;
              let currentMaxRetries = isEmptyResponse ? 3 : (isOverloaded ? 5 : maxRetries);
              attempt++;
              if (attempt > currentMaxRetries || !isRetryable) {
                const msg = rawMsg === "Empty response from model"
                  ? "Empty response from model. Check your endpoint/model config."
                  : rawMsg;
                const prefixMsg = (!isRetryable || isEmptyResponse) ? "Fatal error" : `Generate text failed after ${currentMaxRetries} retries`;
                const errMsg = `${prefixMsg}: ${msg}`;
                this.writeToLogFile("MODEL_ERROR", errMsg);
                this.onEvent({ type: "error", message: errMsg });
                this.conversation.addMessage({
                  role: "system",
                  content: `[ERROR] ${errMsg}`,
                  timestamp: Date.now(),
                });
                await this.saveHistory();
                return;
              }
              if (isPayloadTooLarge) {
                payload413Count++;
                const parsedLimit = parsePayloadLimitBytes(rawMsg);
                if (parsedLimit) {
                  this.detectedPayloadLimitBytes = parsedLimit;
                }
                const limitToUse = this.detectedPayloadLimitBytes || parsedLimit || 4 * 1024 * 1024;
                const maxPayloadBytes = Math.floor(limitToUse * 0.9);
                const systemSize = finalSystemPrompt ? Buffer.byteLength(finalSystemPrompt, "utf-8") : 0;
                const toolsSize = supportsNativeTools ? Buffer.byteLength(JSON.stringify(filteredToolDefs), "utf-8") : 0;

                if (payload413Count > 3) {
                  throw new Error(`Payload size limit exceeded repeatedly. System prompt (${(systemSize / 1024).toFixed(1)} KB) and tool schemas (${(toolsSize / 1024).toFixed(1)} KB) exceed the provider payload limit of ${(limitToUse / 1024).toFixed(0)} KB.`);
                }

                // Reduce budget progressively on each 413 attempt: 100% of headroom on 1st, 50% on 2nd, 25% on 3rd
                const reductionFactor = Math.pow(0.5, payload413Count - 1);
                const allowedHeadroom = maxPayloadBytes - systemSize - toolsSize - 5000;
                currentByteBudget = Math.max(1024 * 20, Math.floor(allowedHeadroom * reductionFactor));

                const beforePayloadBytes = Buffer.byteLength(JSON.stringify(messages), "utf-8") + systemSize + toolsSize + 5000;
                this.writeToLogFile("INFO", `413 Compaction (non-stream): attempt ${payload413Count}. Before size: ${(beforePayloadBytes / 1024).toFixed(1)} KB, Budget target: ${(currentByteBudget / 1024).toFixed(1)} KB`);

                this.onEvent({ type: "text", content: `\n[SYS] Payload too large (413) detected. Compacting conversation history before retrying...\n` });
                await this.compactHistoryIfNeeded(signal, true, undefined, currentByteBudget);
                if (useVisionTokenSaving) {
                  messages = this.buildMessages(supportsNativeTools, dynamicContext);
                } else {
                  messages = this.buildMessages(supportsNativeTools);
                  injectDynamicContext(messages);
                }

                const afterPayloadBytes = Buffer.byteLength(JSON.stringify(messages), "utf-8") + systemSize + toolsSize + 5000;
                this.writeToLogFile("INFO", `413 Compaction (non-stream): After size: ${(afterPayloadBytes / 1024).toFixed(1)} KB`);

                if (afterPayloadBytes >= beforePayloadBytes * 0.95 && beforePayloadBytes > 1024 * 30) {
                  this.writeToLogFile("WARN", `413 Compaction was ineffective. Size only reduced from ${(beforePayloadBytes / 1024).toFixed(1)} KB to ${(afterPayloadBytes / 1024).toFixed(1)} KB`);
                  if (payload413Count >= 2) {
                    throw new Error(`Compaction ineffective. System prompt (${(systemSize / 1024).toFixed(1)} KB) and tool schemas (${(toolsSize / 1024).toFixed(1)} KB) are too large for the provider payload limit of ${(limitToUse / 1024).toFixed(0)} KB.`);
                  }
                }
              } else {
                this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${rawMsg}. Retrying attempt ${attempt}/${currentMaxRetries}...\n` });
              }
              let delayMs = baseDelay * Math.pow(2, attempt - 1);
              if (isEmptyResponse) {
                if (attempt === 1) delayMs = 10000;
                else if (attempt === 2) delayMs = 20000;
                else if (attempt === 3) delayMs = 50000;
              } else if (isOverloaded) {
                const overloadedDelays = [5000, 10000, 20000, 50000, 100000];
                delayMs = overloadedDelays[attempt - 1] ?? 100000;
              } else if (isPayloadTooLarge) {
                delayMs = 1000;
              }
              await this.delayWithCountdown(attempt, delayMs, signal);
            } finally {
              if (concurrencyAcquired) {
                concurrencyLimiter.release();
              }
            }
          }
        } else {
          let attempt = 0;
          const maxRetries = 10;
          const baseDelay = 5000;
          let currentByteBudget = 3 * 1024 * 1024; // 3.0 MB initial safety threshold
          let payload413Count = 0;

          while (true) {
            let concurrencyAcquired = false;
            try {
              if (getSettings().concurrencyLimit === 1) {
                await concurrencyLimiter.acquire();
                concurrencyAcquired = true;
              }
              await rateLimiter.acquire(1);

              textContent = "";
              toolCalls.length = 0;

              const startTime = Date.now();
              const modelInstance = this.getModel();
              const isTest = !!process.env.VITEST;
              const modelDetails = getModelConnectionDetailsForTier(
                this.tier,
                this.delegationDepth,
                this.subagentType,
                !this.isMultiAgent
              );
              const modelName = modelDetails.modelName || "";
              
              const focus = getSettings().focus ?? "off";
              const focusBudget = getSettings().focusBudget ?? 4000;

              const isAnthropic = !isTest && modelInstance && (modelInstance.provider === "anthropic" || (typeof modelInstance.provider === "string" && modelInstance.provider.includes("anthropic")));
              const isOpenAI = !isTest && modelInstance && (modelInstance.provider === "openai" || (typeof modelInstance.provider === "string" && modelInstance.provider.includes("openai")));

              // Determine if model supports thinking
              const modelSupportsThinking = isAnthropic && (
                modelName.includes("3-7") || 
                modelName.includes("3.7") || 
                modelName.includes("claude-4") || 
                modelName.includes("opus-4")
              );

              // Map focus to Anthropic thinking configuration
              let anthropicThinking: any = undefined;
              if (modelSupportsThinking && focus !== "off") {
                let budgetTokens = 4000;
                if (focus === "low") budgetTokens = 1024;
                else if (focus === "medium") budgetTokens = 4096;
                else if (focus === "high") budgetTokens = 8192;
                else if (focus === "xhigh") budgetTokens = 16384;
                else if (focus === "max") budgetTokens = 32768;
                else if (focus === "custom") budgetTokens = focusBudget;

                anthropicThinking = {
                  type: "enabled",
                  budgetTokens,
                };
              }

              // Determine if model supports OpenAI reasoning effort (o1, o3, etc.)
              const modelSupportsReasoningEffort = isOpenAI && (
                modelName.startsWith("o1") || 
                modelName.startsWith("o3")
              );

              let openaiReasoningEffort: "low" | "medium" | "high" | undefined = undefined;
              if (modelSupportsReasoningEffort && focus !== "off") {
                if (focus === "low") openaiReasoningEffort = "low";
                else if (focus === "medium") openaiReasoningEffort = "medium";
                else if (focus === "high" || focus === "xhigh" || focus === "max" || focus === "custom") {
                  openaiReasoningEffort = "high";
                }
              }

              const providerOptions: any = {};
              if (openaiReasoningEffort) {
                providerOptions.openai = {
                  reasoningEffort: openaiReasoningEffort,
                };
              }
              if (anthropicThinking) {
                providerOptions.anthropic = {
                  thinking: anthropicThinking,
                };
              }

              const callMessages = [...messages];
              if (prependSystemMessage) {
                if (prependSystemAssistantMessage) {
                  callMessages.unshift(prependSystemMessage, prependSystemAssistantMessage);
                } else {
                  callMessages.unshift(prependSystemMessage);
                }
              }

              const result = streamText({
                model: modelInstance,
                system: finalSystemPrompt,
                messages: callMessages,
                ...(supportsNativeTools && {
                  tools: Object.fromEntries(
                    filteredToolDefs.map((t) => [
                      t.name,
                      {
                        description: t.description,
                        parameters: jsonSchema(t.input_schema),
                      },
                    ])
                  ),
                }),
                maxSteps: 1,
                abortSignal: signal,
                ...(isAnthropic && {
                  experimental_providerMetadata: {
                    anthropic: { cacheControl: { type: "ephemeral" } },
                  },
                }),
                ...(Object.keys(providerOptions).length > 0 && {
                  providerOptions,
                }),
              });

              let xmlFilter: any = null;
              try {
                const { StreamXmlFilter } = await import("../utils/xmlToolParser.js");
                xmlFilter = new StreamXmlFilter((text) => {
                  this.onEvent({ type: "text", content: text });
                }, toolDefs);
              } catch (err: any) {
                this.writeToLogFile("WARN", `Failed to initialize StreamXmlFilter: ${err.message}`);
              }

              for await (const delta of result.fullStream) {
                if (signal?.aborted) {
                  const err = new Error("AbortError");
                  err.name = "AbortError";
                  throw err;
                }
                if (delta.type === "text-delta") {
                  textContent += delta.textDelta;
                  if (xmlFilter) {
                    xmlFilter.push(delta.textDelta);
                  } else {
                    this.onEvent({ type: "text", content: delta.textDelta });
                  }
                } else if ((delta.type as string) === "reasoning" || (delta.type as string) === "reasoning-delta") {
                  // DeepSeek R1 and similar models return reasoning/thinking tokens separately.
                  // These MUST NOT be merged into textContent — doing so causes a 400 error
                  // from DeepSeek: "reasoning_content in thinking mode must be passed back to the API".
                  // We track them separately and emit to UI only; they are excluded from conversation history.
                  const reasoningText = (delta as any).reasoning || (delta as any).reasoningDelta || (delta as any).delta || "";
                  if (reasoningText) {
                    reasoningContent += reasoningText;
                    this.onEvent({ type: "reasoning", content: reasoningText });
                  }
                } else if (delta.type === "tool-call") {
                  const tc: ToolCall = {
                    id: delta.toolCallId,
                    name: delta.toolName,
                    args: delta.args as Record<string, unknown>,
                  };
                  toolCalls.push(tc);
                } else if (delta.type === "error") {
                  throw delta.error instanceof Error ? delta.error : new Error(formatError(delta.error));
                }
              }

              if (xmlFilter) {
                xmlFilter.flush();
              }

              if (signal?.aborted) {
                const err = new Error("AbortError");
                err.name = "AbortError";
                throw err;
              }

              try {
                const usage = await result.usage;
                const durationMs = Date.now() - startTime;
                if (usage) {
                  if (durationMs > 0 && usage.completionTokens > 0) {
                    this.lastSpeed = usage.completionTokens / (durationMs / 1000);
                  }
                  this.onEvent({
                    type: "token_usage",
                    promptTokens: usage.promptTokens || 0,
                    completionTokens: usage.completionTokens || 0,
                    durationMs,
                  });
                }
              } catch (err) {
                // Ignore or log error silently
              }

              if (!textContent.trim() && toolCalls.length === 0) {
                if (reasoningContent.trim()) {
                  // Reasoning-only response (e.g. DeepSeek-R1 with no final answer text).
                  // Use the reasoning content as the assistant's response so it is stored in history.
                  textContent = reasoningContent;
                } else {
                  throw new Error("Empty response from model");
                }
              }

              break;
            } catch (err: unknown) {
              if (err instanceof Error && err.name === "AbortError") {
                throw err;
              }
              const rawMsg = formatError(err);
              const isPayloadTooLarge = rawMsg.toLowerCase().includes("payload too large") || 
                                        rawMsg.toLowerCase().includes("request entity too large") || 
                                        rawMsg.toLowerCase().includes("request too large") || 
                                        rawMsg.toLowerCase().includes("status 413") ||
                                        rawMsg.toLowerCase().includes("status: 413");
              const isOverloaded = rawMsg.toLowerCase().includes("our servers are currently overloaded") || rawMsg.toLowerCase().includes("overloaded_error");
              const isEmptyResponse = (err instanceof Error && err.message === "Empty response from model") ||
                rawMsg.toLowerCase().includes("model output must contain") ||
                rawMsg.toLowerCase().includes("these cannot both be empty");
              const isRetryable = isRetryableError(err) || isEmptyResponse || isOverloaded || isPayloadTooLarge;
              let currentMaxRetries = isEmptyResponse ? 3 : (isOverloaded ? 5 : maxRetries);
              attempt++;
              if (attempt > currentMaxRetries || !isRetryable) {
                const msg = rawMsg === "Empty response from model"
                  ? "Empty response from model. Check your endpoint/model config."
                  : rawMsg;
                const prefixMsg = (!isRetryable || isEmptyResponse) ? "Fatal error" : `Stream error after ${currentMaxRetries} retries`;
                const errMsg = `${prefixMsg}: ${msg}`;
                this.writeToLogFile("STREAM_ERROR", errMsg);
                this.onEvent({ type: "error", message: errMsg });
                this.conversation.addMessage({
                  role: "system",
                  content: `[ERROR] ${errMsg}`,
                  timestamp: Date.now(),
                });
                await this.saveHistory();
                return;
              }
              if (isPayloadTooLarge) {
                payload413Count++;
                const parsedLimit = parsePayloadLimitBytes(rawMsg);
                if (parsedLimit) {
                  this.detectedPayloadLimitBytes = parsedLimit;
                }
                const limitToUse = this.detectedPayloadLimitBytes || parsedLimit || 4 * 1024 * 1024;
                const maxPayloadBytes = Math.floor(limitToUse * 0.9);
                const systemSize = finalSystemPrompt ? Buffer.byteLength(finalSystemPrompt, "utf-8") : 0;
                const toolsSize = supportsNativeTools ? Buffer.byteLength(JSON.stringify(filteredToolDefs), "utf-8") : 0;

                if (payload413Count > 3) {
                  throw new Error(`Payload size limit exceeded repeatedly. System prompt (${(systemSize / 1024).toFixed(1)} KB) and tool schemas (${(toolsSize / 1024).toFixed(1)} KB) exceed the provider payload limit of ${(limitToUse / 1024).toFixed(0)} KB.`);
                }

                // Reduce budget progressively on each 413 attempt: 100% of headroom on 1st, 50% on 2nd, 25% on 3rd
                const reductionFactor = Math.pow(0.5, payload413Count - 1);
                const allowedHeadroom = maxPayloadBytes - systemSize - toolsSize - 5000;
                currentByteBudget = Math.max(1024 * 20, Math.floor(allowedHeadroom * reductionFactor));

                const beforePayloadBytes = Buffer.byteLength(JSON.stringify(messages), "utf-8") + systemSize + toolsSize + 5000;
                this.writeToLogFile("INFO", `413 Compaction (stream): attempt ${payload413Count}. Before size: ${(beforePayloadBytes / 1024).toFixed(1)} KB, Budget target: ${(currentByteBudget / 1024).toFixed(1)} KB`);

                this.onEvent({ type: "text", content: `\n[SYS] Payload too large (413) detected. Compacting conversation history before retrying...\n` });
                await this.compactHistoryIfNeeded(signal, true, undefined, currentByteBudget);
                if (useVisionTokenSaving) {
                  messages = this.buildMessages(supportsNativeTools, dynamicContext);
                } else {
                  messages = this.buildMessages(supportsNativeTools);
                  injectDynamicContext(messages);
                }

                const afterPayloadBytes = Buffer.byteLength(JSON.stringify(messages), "utf-8") + systemSize + toolsSize + 5000;
                this.writeToLogFile("INFO", `413 Compaction (stream): After size: ${(afterPayloadBytes / 1024).toFixed(1)} KB`);

                if (afterPayloadBytes >= beforePayloadBytes * 0.95 && beforePayloadBytes > 1024 * 30) {
                  this.writeToLogFile("WARN", `413 Compaction was ineffective. Size only reduced from ${(beforePayloadBytes / 1024).toFixed(1)} KB to ${(afterPayloadBytes / 1024).toFixed(1)} KB`);
                  if (payload413Count >= 2) {
                    throw new Error(`Compaction ineffective. System prompt (${(systemSize / 1024).toFixed(1)} KB) and tool schemas (${(toolsSize / 1024).toFixed(1)} KB) are too large for the provider payload limit of ${(limitToUse / 1024).toFixed(0)} KB.`);
                  }
                }
              } else {
                this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${rawMsg}. Retrying attempt ${attempt}/${currentMaxRetries}...\n` });
              }
              let delayMs = baseDelay * Math.pow(2, attempt - 1);
              if (isEmptyResponse) {
                if (attempt === 1) delayMs = 10000;
                else if (attempt === 2) delayMs = 20000;
                else if (attempt === 3) delayMs = 50000;
              } else if (isOverloaded) {
                const overloadedDelays = [5000, 10000, 20000, 50000, 100000];
                delayMs = overloadedDelays[attempt - 1] ?? 100000;
              } else if (isPayloadTooLarge) {
                delayMs = 1000;
              }
              await this.delayWithCountdown(attempt, delayMs, signal);
            } finally {
              if (concurrencyAcquired) {
                concurrencyLimiter.release();
              }
            }
          }
        }
        if (textContent.trim()) {
          try {
            const { parseXmlToolCalls } = await import("../utils/xmlToolParser.js");
            const parsed = parseXmlToolCalls(textContent, toolDefs);
            if (parsed.toolCalls.length > 0) {
              this.writeToLogFile(
                "INFO",
                `Parsed ${parsed.toolCalls.length} XML tool calls from model response text`
              );
              for (const tc of parsed.toolCalls) {
                const isDuplicate = toolCalls.some(
                  (existing) =>
                    existing.name === tc.name &&
                    JSON.stringify(existing.args) === JSON.stringify(tc.args)
                );
                if (!isDuplicate) {
                  toolCalls.push(tc);
                }
              }
            }
            textContent = parsed.cleanText;
          } catch (err: any) {
            this.writeToLogFile("WARN", `Failed to parse XML tool calls: ${err.message}`);
          }
        }

        if (toolCalls.length === 0) {
          if (!textContent.trim()) {
            const errMsg = "Empty response from model. Check your endpoint/model config.";
            this.onEvent({
              type: "error",
              message: errMsg,
            });
            this.conversation.addMessage({
              role: "system",
              content: `[ERROR] ${errMsg}`,
              timestamp: Date.now(),
            });
            await this.saveHistory();
          } else {
            // ── Auto-continue for planning/narration responses ──────────────
            // Some models (e.g. GPT-5.5 via OpenRouter) output a text-only
            // "planning" sentence (e.g. "Reading BrowserTab regions...") without
            // issuing tool calls, then stop. On early iterations this is almost
            // certainly NOT a final answer — inject a nudge and keep looping
            // instead of breaking immediately.
            const isEarlyIteration = i < 2;
            const category = this.currentClassification?.category || "complex_task";
            const skipPlanningCategories = ["conversation", "question"];
            const isPlanningText =
              isEarlyIteration &&
              !skipPlanningCategories.includes(category) &&
              textContent.trim().length > 0 &&
              textContent.trim().length < 500 &&
              !/\?$/.test(textContent.trim()); // Not a question to the user

            if (isPlanningText) {
              this.writeToLogFile(
                "INFO",
                `Text-only response on iteration ${i} (likely planning narration). Auto-continuing with nudge.`
              );
              this.conversation.addAssistantMessage(textContent, undefined, undefined, reasoningContent);
              this.conversation.addMessage({
                role: "user",
                content: "[SYS] Continue. Use the available tools to execute the plan you described.",
                timestamp: Date.now(),
              });
              await this.saveHistory();
              // Do NOT break — let the loop continue to next iteration
              continue;
            }

            const currentCwd = (this.tier === "superagent" && this.worktreePath)
              ? this.worktreePath
              : this.workingDirectory;
            const endSnapshot = await captureGitSnapshot(currentCwd);
            const gitSummary = getGitDiffSummary(this.gitStartSnapshot, endSnapshot);
            if (gitSummary) {
              const summaryHeader = "\n\nChanges summary:\n" + gitSummary;
              textContent += summaryHeader;
              this.onEvent({ type: "text", content: summaryHeader });
            }

            this.conversation.addAssistantMessage(textContent, undefined, undefined, reasoningContent);
            await this.saveHistory();
          }
          break;
        }


        const { ToolExecutor } = await import("./agent/ToolExecutor.js");
        const toolResults = await ToolExecutor.executeTools(
          this,
          toolCalls,
          toolDefs,
          filteredToolDefs,
          supportsNativeTools,
          finalSystemPrompt,
          signal
        );
        this.conversation.addAssistantMessage(
          textContent,
          toolCalls,
          toolResults,
          reasoningContent
        );

        this.conversation.addMessage({
          role: "tool",
          content: "",
          toolResults,
          timestamp: Date.now(),
        });
        await this.saveHistory();

        // ── Real-Time Advisor evaluation ────────────────────────────────────
        if (getSettings().enableAdvisor ?? true) {
          const advisorResult = this.advisor.evaluateStep(toolCalls, toolResults);
          if (advisorResult.action === "warn_agent" && advisorResult.message) {
            this.onEvent({
              type: "text",
              content: `\n⚠️ [Advisor] Warning: ${advisorResult.message}\n`,
            });
            this.conversation.addMessage({
              role: "user",
              content: advisorResult.message,
              timestamp: Date.now(),
            });
            await this.saveHistory();
          } else if (advisorResult.action === "pause_execution" && advisorResult.message) {
            this.onEvent({
              type: "text",
              content: `\n❌ [Advisor] Critical: ${advisorResult.message}\n`,
            });
            this.onEvent({
              type: "error",
              message: advisorResult.message,
            });
            break;
          }
        }

        // ── Post-iteration compaction check ──────────────────────────────────
        // Tool results can be large (file reads, command outputs, etc).
        // Compaction normally runs at the START of the next iteration, but by
        // then messages may already exceed the model limit. Check immediately
        // after appending results so compaction has a chance to reduce the
        // conversation before the next API call.
        {
          const ctxMgr = this.conversation.getContextManager();
          if (ctxMgr) {
            const postMessages = this.conversation.getMessages();
            if (postMessages.length === 0) continue;
            const postDecision = ctxMgr.shouldCompact(postMessages);
            if (postDecision.shouldCompact) {
              this.writeToLogFile(
                "INFO",
                `Post-iteration compaction triggered: ${postDecision.reason}`
              );
              await this.compactHistoryIfNeeded(signal);
            }
          }
        }

        // ── Stop the loop as soon as a plan becomes pending approval ──────────
        // When the model writes a valid implementation plan, planState flips to
        // PLANNING_PENDING (see the MODIFYING_TOOLS block above). We must break
        // out of the loop here so runAgentLoop() returns normally and the
        // `finally` block in sendMessage() emits the "done" event. The UI's
        // handleEvent opens the plan approval wizard precisely on that "done"
        // event (see app.tsx handleEvent). Without this break the loop would
        // keep iterating in read-only mode and the approval dialog would only
        // surface when the user manually aborts with ESC.
        if (this.planState === "PLANNING_PENDING") {
          break;
        }

        if (i === maxIterations - 1) {
          if (continueCount >= maxContinues) {
            const stopMsg = isGoalMode
              ? `\n\n⚠️ [GOAL MODE: Reached maximum auto-continue limit (${maxContinues}x). Stopping to prevent infinite loop. Your goal was: "${this.goalMode}". You can continue with '/resume'.]\n`
              : `\n\n⚠️ [System Warning: Reached maximum iteration limit and maximum auto-continues (${maxContinues}). Stopping to prevent infinite loop. You can continue the session by sending a message or running '/resume'.]\n`;
            this.onEvent({ type: "text", content: stopMsg });
          } else if (isGoalMode) {
            continueCount++;
            this.onEvent({
              type: "text",
              content: `\n\n🎯 [GOAL MODE: Auto-continuing iteration block ${continueCount}/${maxContinues} to achieve goal: "${this.goalMode}"]\n`,
            });
            i = -1;
            continue;
          } else {
            try {
              const selected = await this.onQuestion(
                `Reached maximum iteration limit of ${maxIterations} steps. The task may be incomplete. Would you like to continue for another ${maxIterations} steps?`,
                ["Yes, continue", "No, stop here"]
              );
              if (selected === "Yes, continue") {
                continueCount++;
                i = -1;
                continue;
              }
            } catch (err) {
              this.onEvent({
                type: "text",
                content: `\n\n⚠️ [System Warning: Reached maximum iteration limit of ${maxIterations} steps. The task may be incomplete. You can continue the session by sending a message or running '/resume'.]\n`
              });
            }
          }
        }
      }
    } finally {
      let finalSummary = "Agent has finished executing. Check the output above for GOAL_COMPLETE or GOAL_PARTIAL status.";
      if (!process.env.VITEST) {
        try {
          const messages = this.conversation.getMessages();
          if (messages.length > 0) {
            const lastUserIdx = messages.map(m => m.role).lastIndexOf("user");
            const sessionMsgs = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages;
            this.writeToLogFile("INFO", "Generating execution summary for log...");
            finalSummary = await HistoryCompactor.summarizeMessages(this, sessionMsgs, signal);
            this.writeToLogFile("SUMMARY", finalSummary);
          }
        } catch (sumErr: any) {
          this.writeToLogFile("WARN", `Failed to generate execution summary for log: ${sumErr.message}`);
        }
      }

      if (isGoalMode && this.goalMode) {
        this.onEvent({
          type: "goal_done",
          goal: this.goalMode,
          summary: finalSummary,
        });
      }
    }
  }

  /**
   * Lightweight response path for high-confidence conversational messages.
   *
   * Bypasses the full agent loop (workspace discovery, tool loading, plan injection,
   * rate limiter acquire, concurrency limiter acquire) and calls streamText directly
   * with a minimal system prompt and current conversation history.
   *
   * Activated only when: category=conversation AND confidence=high AND tier=single|master.
   */
  private async runConversationFastPath(
    userInput: string | import("./conversation.js").MessageContent
  ): Promise<void> {
    const { FastPath } = await import("./agent/FastPath.js");
    await FastPath.runConversationFastPath(this, userInput);
  }

  private modelSupportsVision(modelName: string): boolean {
    return new MessageBuilder().modelSupportsVision(modelName, this);
  }

  private buildMessages(supportsNativeTools = true, dynamicContext?: string): CoreMessage[] {
    return new MessageBuilder().buildMessages(this, supportsNativeTools, dynamicContext);
  }



  async compactHistoryIfNeeded(signal?: AbortSignal, force: boolean = false, tokenBudget?: number, byteBudget?: number): Promise<void> {
    await this.ensureContextManager();
    const contextManager = this.conversation.getContextManager();

    if (contextManager) {
      await HistoryCompactor.contextManagerCompact(this, signal, force, tokenBudget, byteBudget);
      return;
    }

    await HistoryCompactor.legacyCompactHistory(this, signal, force, tokenBudget, byteBudget);
  }

  private async ensureContextManager(): Promise<void> {
    if (this.conversation.hasContextManager()) return;
    if (this.contextManagerInitFailed) return;

    try {
      await this.initContextManager();
    } catch (err) {
      this.contextManagerInitFailed = true;
      this.writeToLogFile("WARN", `ContextManager init failed permanently: ${(err as Error).message}`);
    }
  }

  private async delayWithCountdown(attempt: number, delayMs: number, signal?: AbortSignal): Promise<void> {
    const delaySec = Math.ceil(delayMs / 1000);
    for (let sec = delaySec; sec > 0; sec--) {
      if (signal?.aborted) {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      }
      this.onEvent({ type: "text", content: `\rRetrying in ${sec}s... ` });
      
      await new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
          return;
        }
        
        const timeout = setTimeout(() => {
          if (signal) {
            signal.removeEventListener("abort", onAbort);
          }
          resolve();
        }, 1000);
        
        const onAbort = () => {
          clearTimeout(timeout);
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        };
        
        if (signal) {
          signal.addEventListener("abort", onAbort);
        }
      });
    }
    this.onEvent({ type: "text", content: `\r\n` });
  }

  abort(): void {
    if (this.isRunning) {
      this.wasRunningBeforeAbort = true;
      setTimeout(() => {
        this.wasRunningBeforeAbort = false;
      }, 200);
    }
    // Clear any queued message so the agent does NOT auto-restart
    // after the abort (e.g. a pending plan approval that was queued
    // while the agent loop was still running).
    this.pendingMessagesQueue = [];
    this.abortController?.abort();
  }

  queueMessage(message: string | import("./conversation.js").MessageContent): void {
    this.pendingMessagesQueue.push(message);
  }

  async clearHistory(): Promise<void> {
    await HistoryManager.clearHistory(this);
  }


  public autoCheckpoint(label: string): void {
    const now = Date.now();
    if (now - this.lastAutoCheckpointAt < Agent.AUTO_CHECKPOINT_COOLDOWN_MS) return;
    this.lastAutoCheckpointAt = now;

    const sessionFilePath = this.getCurrentHistoryFilePath();
    const messages = this.conversation.getMessages();
    const name = `Auto: ${label} at ${new Date(now).toLocaleTimeString()}`;

    createCheckpoint(sessionFilePath, name, messages, this.planState, this.workingDirectory)
      .then((checkpoint) => {
        this.writeToLogFile("INFO", `Auto-checkpoint created: "${name}"`);
        this.onEvent({ type: "checkpoint_auto", name: checkpoint.name, id: checkpoint.id });
      })
      .catch((err: any) => {
        this.writeToLogFile("WARN", `Auto-checkpoint failed: ${err.message}`);
      });
  }

  public resetInternalState(): void {
    this.textLogBuffer = "";
    this.pendingMessagesQueue = [];
    this.lastSpeed = null;
    this.wasRunningBeforeAbort = false;
    this.isRunning = false;
    this.abortController = null;
    this.tasksJustArchived = false;
    this.archivedTaskCount = 0;
    this.lastAutoCheckpointAt = 0;
  }

  private async prepopulateRmemoryContext(): Promise<void> {
    await HistoryCompactor.prepopulateRmemoryContext(this);
  }


  getHistory(): Conversation {
    return this.conversation;
  }

  getContextManager() {
    return this.conversation.getContextManager();
  }

  isAgentRunning(): boolean {
    return this.isRunning;
  }
}