import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import { execa } from "execa";
import { captureGitSnapshot, getGitDiffSummary, type GitSnapshot } from "./agent/GitUtils.js";
import fs from "fs";
import crypto from "crypto";
import { getConfig, getContextWindowLimit, getGlobalConfigDir, ensureGlobalConfigDir, getModelInstanceForTier, getModelInstanceForString, loadAgentSkills, getSettings, getTierModel, getTierModelConfig, getPackageRootDir, getModelConnectionDetailsForTier, clearHistoryCache } from "./config.js";
import { GuidelineLoader } from "./agent/GuidelineLoader.js";
import { Conversation } from "./conversation.js";
import type { Tool, AgentTier, ViolationRecord } from "./tools/types.js";
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
import { updateProcessActivity, appendProcessLog } from "./tools/state.js";

import { PathResolver } from "./agent/PathResolver.js";
import { HistoryManager } from "./agent/HistoryManager.js";
import { RequestProcessor } from "./agent/RequestProcessor.js";
import { ContextBuilder } from "./agent/ContextBuilder.js";
import { isRetryableError as isRetryableErrorHelper, parsePayloadLimitBytes as parsePayloadLimitBytesHelper, answerQuestionAsMaster as answerQuestionAsMasterHelper } from "./agent/AgentUtils.js";
import { LoopIterationProcessor } from "./agent/LoopIterationProcessor.js";
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
  public sessionId: string = "";
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
  /** True when approvePlan() was explicitly called this session; prevents stale-state resets. */
  public _planApprovedExplicitly: boolean = false;
  public isSimpleTask: boolean = false;
  public simpleTaskApproved: boolean = false;
  /** Multi-category classification result from the request classifier */
  public currentClassification: import("./requestClassifier.js").ClassificationResult | null = null;
  public lastSpeed: number | null = null;
  public goalMode: string | null = null;
  public goalMaxIterations: number = 1000;
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
  /** Cached active tools to avoid repeated dynamic imports */
  private _activeToolsCache: { tools: Tool[]; cachedAt: number } | null = null;
  /** TTL for active tools cache */
  private static readonly ACTIVE_TOOLS_CACHE_TTL = 5_000;
  private skillContentCache: Map<string, string> = new Map();
  /** Keys of skills that were successfully preloaded into guidelinesText */
  private preloadedSkillKeys: Set<string> = new Set();
  public gitStartSnapshot: Record<string, { added: number; deleted: number }> | null = null;
  public advisor = new RealtimeAdvisor({
    warningThreshold: getSettings().advisorWarningThreshold ?? 3,
    pauseThreshold: getSettings().advisorPauseThreshold ?? 5,
    errorThreshold: getSettings().advisorErrorThreshold ?? 5,
    enableAdaptiveScaling: getSettings().advisorAdaptiveScaling ?? true,
    enablePatternMemory: getSettings().advisorPatternMemory ?? true,
  });

  public approvePlan(): void {
    // Always set APPROVED on explicit call. ContextBuilder.buildContext already
    // resets stale APPROVED states when no plan file exists on disk.
    this.planState = "APPROVED";
    this._planApprovedExplicitly = true;
  }

  public dispose(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    this.skillContentCache.clear();
    this.preloadedSkillKeys.clear();
  }



  public buildGuidelinesText(userQuery?: string): string {
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

  public markPreloadedSkillsInList(skillsPrompt: string): string {
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
        const desc = event.description || event.toolCall.name;
        this.writeToLogFile("TOOL_START", `Tool: ${event.toolCall.name}, Description: ${event.description}, Args: ${argsStr}`);
        updateProcessActivity({
          isAgentRunning: true,
          currentTool: `${event.toolCall.name}: ${desc}`,
          currentStatus: `Executing tool: ${event.toolCall.name}`,
        });
      } else if (event.type === "tool_end") {
        const success = !event.toolResult.isError;
        const resultStr = typeof event.toolResult.result === "string"
          ? event.toolResult.result
          : JSON.stringify(event.toolResult.result);
        const truncatedResult = resultStr.length > 500 ? resultStr.substring(0, 500) + "... (truncated)" : resultStr;
        this.writeToLogFile("TOOL_END", `Tool: ${event.toolResult.name}, Success: ${success}, Result: ${truncatedResult}`);
        updateProcessActivity({
          currentTool: undefined,
          currentStatus: "Thinking / Generating response...",
        });
      } else if (event.type === "error") {
        this.writeToLogFile("ERROR", event.message);
        updateProcessActivity({
          currentStatus: `Error: ${event.message}`,
        });
      } else if (event.type === "permission_required") {
        this.writeToLogFile("PERMISSION_REQUIRED", `Tool: ${event.toolCall.name}, Description: ${event.description}`);
        updateProcessActivity({
          currentStatus: `Waiting for permission: ${event.description}`,
        });
      } else if (event.type === "illegal_operation") {
        const v = event.violation;
        this.writeToLogFile("ILLEGAL_OPERATION", `[${v.severity}] ${v.reason} | tool:${v.toolName} | ${v.description}`);
      } else if (event.type === "token_usage") {
        let logMsg = `Prompt Tokens: ${event.promptTokens}, Completion Tokens: ${event.completionTokens}`;
        if (event.durationMs !== undefined) {
          logMsg += `, Duration: ${event.durationMs}ms`;
        }
        this.writeToLogFile("TOKEN_USAGE", logMsg);
        updateProcessActivity({
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
        });
      } else if (event.type === "goal_done") {
        this.writeToLogFile("GOAL_DONE", `Goal: ${event.goal}\nSummary: ${event.summary}`);
      } else if (event.type === "done") {
        this.writeToLogFile("DONE", "Agent execution iteration/loop done");
        updateProcessActivity({
          isAgentRunning: false,
          currentTool: undefined,
          currentStatus: "Idle",
        });
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
    await this.conversation.initContextManager({
      model: this.config.model,
      contextWindowLimit: modelLimit,
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
      appendProcessLog(`[${level}] ${message}`);
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

  /**
   * Verifies a real, non-trivial plan exists on disk.
   * Prevents the "plan approved" auto-nudge from looping endlessly when
   * planState is APPROVED but no actual plan file/content was ever written.
   */
  public hasRealPlanContent(): boolean {
    try {
      const planPath = this.getPlanFilePath();
      if (!planPath || !fs.existsSync(planPath)) return false;
      const content = fs.readFileSync(planPath, "utf-8").trim();
      return content.length > 40 && /(implementation|plan|task|feature|fix|refactor|phase|\n#{1,6}\s)/i.test(content);
    } catch {
      return false;
    }
  }


  public async getActiveTools(): Promise<Tool[]> {
    // Return cached tools if within TTL
    const now = Date.now();
    if (this._activeToolsCache && (now - this._activeToolsCache.cachedAt) < Agent.ACTIVE_TOOLS_CACHE_TTL) {
      return [...this._activeToolsCache.tools];
    }

    let tools: Tool[] = [];
    if (this.customTools) {
      tools = [...this.customTools];
    } else {
      const { masterToolset, superagentToolset, resolveSubagentToolset } = await import("./tools/toolsets.js");
      if (this.tier === "master") {
        tools = [...masterToolset];
        // The masterToolset is curated at source to contain orchestration
        // tools only (see toolsets.ts). Runtime guard against
        // prompt-injection calling non-orchestration tools is provided by
        // a tier check in the run() loop (see Agent.run).
      } else if (this.tier === "superagent" || this.tier === "single") {
        tools = [...superagentToolset];
      } else if (this.tier === "subagent") {
        const { subagentTypes } = await import("./tools/state.js");
        const subType = this.subagentType ? subagentTypes.get(this.subagentType) : undefined;
        tools = [
          ...resolveSubagentToolset(this.subagentType, {
            toolset: subType?.toolset,
            baseType: subType?.baseType,
            enableWriteTools: subType?.enableWriteTools,
          }),
        ];
      }
    }

    if (!(await isRmemoryActive())) {
      tools = tools.filter((t) => !t.name.startsWith("rmemory_"));
    }

    const { workspaceChainManager } = await import("./workspace/WorkspaceChainManager.js");
    const workspaceDir = this.worktreePath || this.workingDirectory;
    if (!workspaceChainManager.isChainActive(workspaceDir)) {
      tools = tools.filter((t) => t.name !== "manage_workspace_chain" && t.name !== "cross_workspace_exec");
    }

    const { browserControlHandler } = await import("./tools/browserMacroTools.js");
    // Removed isServerMode check so normal CLI can use control_browser_ tools.

    // Cache the resolved tools
    this._activeToolsCache = { tools: [...tools], cachedAt: now };
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

    const taskSummary = typeof userInput === "string" ? userInput : "[multimodal message]";
    const currentModelName = getTierModel(this.isMultiAgent ? "multi" : "single", this.tier);
    const taskFilePath = this.getTaskFilePath();
    const planFilePath = this.getPlanFilePath();

    // Ensure session task file exists immediately so MCP, dashboards, and background processes have live visibility
    try {
      if (this.tier === "master" || this.tier === "single" || this.tier === "superagent") {
        if (!fs.existsSync(taskFilePath) || fs.readFileSync(taskFilePath, "utf-8").trim() === "") {
          fs.mkdirSync(path.dirname(taskFilePath), { recursive: true });
          fs.writeFileSync(taskFilePath, `# Tasks\n\n- [/] ${taskSummary.trim()}\n`, "utf-8");
        }
      }
    } catch {}

    updateProcessActivity({
      isAgentRunning: true,
      currentTask: taskSummary.slice(0, 150),
      currentTaskStatus: "in_progress",
      currentStatus: "Thinking / Planning...",
      sessionId: this.sessionId,
      taskFilePath,
      planFilePath,
      workingDirectory: this.workingDirectory || process.cwd(),
      model: currentModelName,
    });

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
        const message = `Fatal error: ${formatError(err)}`;
        this.writeToLogFile("AGENT_ERROR", message);
        this.onEvent({ type: "text", content: `\n\n❌ [ERROR] ${message}\n` });
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

      try {
        if (this.tier === "master" || this.tier === "single" || this.tier === "superagent") {
          const tf = this.getTaskFilePath();
          if (fs.existsSync(tf)) {
            const content = fs.readFileSync(tf, "utf-8");
            const seedLine = `- [/] ${taskSummary.trim()}`;
            if (content.includes(seedLine)) {
              fs.writeFileSync(tf, content.replace(seedLine, `- [x] ${taskSummary.trim()}`), "utf-8");
            }
          }
        }
      } catch {}

      updateProcessActivity({
        isAgentRunning: false,
        currentTool: undefined,
        currentStatus: "Idle",
      });

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
    // Sync advisor thresholds/flags from live config so runtime changes take effect
    this.advisor.syncSettings(getSettings());
    const signal = this.abortController?.signal;
    const isGoalMode = !!this.goalMode;
    const defaultMax = getSettings().maxIterations === 0 ? Infinity : (getSettings().maxIterations || 500);
    const maxIterations = isGoalMode ? this.goalMaxIterations : defaultMax;
    const maxIterationsStr = maxIterations === Infinity ? "unlimited" : maxIterations.toString();
    let continueCount = 0;
    const maxContinues = isGoalMode ? 10 : 3;
    try {
      for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted) {
          const err = new Error("AbortError");
          err.name = "AbortError";
          throw err;
        }

        const { shouldBreak } = await LoopIterationProcessor.processIteration(this, i, maxIterations, signal);
        if (shouldBreak) {
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
            const sumSignal = AbortSignal.timeout(5000);
            HistoryCompactor.summarizeMessages(this, sessionMsgs, sumSignal)
              .then(summary => {
                this.writeToLogFile("SUMMARY", summary);
              })
              .catch(sumErr => {
                this.writeToLogFile("WARN", `Failed to generate execution summary for log: ${sumErr.message}`);
              });
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

  public modelSupportsVision(modelName: string): boolean {
    return new MessageBuilder().modelSupportsVision(modelName, this);
  }

  public buildMessages(supportsNativeTools = true): CoreMessage[] {
    return new MessageBuilder().buildMessages(this, supportsNativeTools);
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

  public async delayWithCountdown(attempt: number, delayMs: number, signal?: AbortSignal): Promise<void> {
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
    this.isRunning = false;
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
    this._activeToolsCache = null;
  }

  public async prepopulateRmemoryContext(): Promise<void> {
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