import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import { execa } from "execa";
import { renderTextToImageBase64, sliceTextIntoPages, minifyTextForImage } from "../utils/textToImage.js";
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
import { getTencentDBClient, getTencentDBSessionKey, isTencentdbActive } from "./tencentdbUtil.js";
import { AsyncLocalStorage } from "async_hooks";
import { allTasksCompleted, archiveCompletedTasks, getTaskHistoryPath } from "./taskChecklist.js";
import { createCheckpoint } from "./checkpoints.js";

export function checkPlanStructure(content: string): boolean {
  const hasTitle = /^#\s+.+/m.test(content);
  if (!hasTitle) return false;

  const hasProposedChanges = /##\s+.*(proposed\s+changes|changes|rencana\s+perubahan|perubahan)/i.test(content);
  const hasVerificationPlan = /##\s+.*(verification\s+plan|verification|rencana\s+verifikasi|verifikasi)/i.test(content);
  const hasAutomatedTests = /(##|###)\s+.*(automated\s+tests|tests|test\s+otomatis)/i.test(content);
  const hasManualVerification = /(##|###)\s+.*(manual\s+verification|manual\s+testing|verifikasi\s+manual)/i.test(content);
  
  const hasArchitecture = /##\s+.*(architecture|arsitektur|refactor|design|desain)/i.test(content);

  // check full template
  const isFull = hasProposedChanges && hasVerificationPlan && hasAutomatedTests && hasManualVerification;
  // check quick template
  const isQuick = hasProposedChanges;
  // check refactor template
  const isRefactor = hasProposedChanges && hasArchitecture;

  return isFull || isQuick || isRefactor;
}

export const agentLocalStorage = new AsyncLocalStorage<Agent>();

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "tool_start"; toolCall: ToolCall; description: string }
  | { type: "tool_end"; toolResult: ToolResult; description: string; toolCall?: ToolCall }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "goal_done"; goal: string; summary: string }
  | { type: "permission_required"; toolCall: ToolCall; description: string }
  | { type: "illegal_operation"; violation: ViolationRecord }
  | { type: "token_usage"; promptTokens: number; completionTokens: number; durationMs?: number }
  | { type: "checkpoint_auto"; name: string; id: string }
  | { type: "tool_progress"; toolCallId: string; message: string };

export type PermissionHandler = (
  toolCall: ToolCall,
  description: string
) => Promise<boolean | "session">;

export interface QuestionItem {
  question: string;
  options: string[];
  isMultiSelect?: boolean;
}

export type QuestionHandler = (
  question: string | QuestionItem[],
  options?: string[],
  isMultiSelect?: boolean,
  initialCheckedIndices?: number[]
) => Promise<string | string[]>;


export function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  
  let baseMessage = "";
  let extra = "";
  const obj = err as any;

  if (err instanceof Error) {
    baseMessage = err.message;
  } else if (typeof err === "object") {
    if (obj.message && typeof obj.message === "string") {
      baseMessage = obj.message;
    } else if (obj.error && typeof obj.error === "object" && obj.error.message && typeof obj.error.message === "string") {
      baseMessage = obj.error.message;
    }
  }

  if (baseMessage) {
    try {
      let status: number | undefined;
      let bodyText: string | undefined;
      let currentCause: any = obj.cause;
      
      let current = obj;
      while (current && typeof current === "object") {
        if (status === undefined) {
          const s = current.statusCode || current.status || (current.error && (current.error.statusCode || current.error.status));
          if (s) {
            status = Number(s);
          }
        }
        if (bodyText === undefined) {
          const b = current.text || current.responseBody || (current.error && (current.error.text || current.error.responseBody));
          if (typeof b === "string" && b.trim()) {
            bodyText = b;
          }
        }
        if (current.cause) {
          currentCause = current.cause;
          current = current.cause;
        } else if (current.error && typeof current.error === "object" && current.error !== current) {
          current = current.error;
        } else {
          break;
        }
      }

      if (status) {
        extra += ` (status: ${status})`;
      }
      
      if (bodyText && typeof bodyText === "string") {
        const trimmed = bodyText.trim();
        if (trimmed) {
          const snippet = trimmed.length > 150 ? trimmed.substring(0, 150) + "..." : trimmed;
          const cleanSnippet = snippet.replace(/\r?\n|\r/g, " ");
          extra += ` - response body snippet: "${cleanSnippet}"`;
        }
      }
      
      if (currentCause) {
        const causeMsg = currentCause instanceof Error ? currentCause.message : String(currentCause);
        if (causeMsg && causeMsg !== baseMessage) {
          extra += ` - cause: ${causeMsg}`;
        }
      }
    } catch {
      // Ignore extraction failures
    }
    return baseMessage + extra;
  }

  if (typeof err === "object") {
    try {
      const codePart = obj.code || obj.status || (obj.error && (obj.error.code || obj.error.status))
        ? ` (status/code: ${obj.code || obj.status || (obj.error && (obj.error.code || obj.error.status))})`
        : "";
      return JSON.stringify(err) + codePart;
    } catch {
      // Fallback if JSON.stringify fails
    }
  }

  return String(err);
}

function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  
  let msg = "";
  let statusCode: number | undefined;

  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.toLowerCase().includes("aborted") || err.message.toLowerCase().includes("abort")) return false;
    msg = err.message;
    statusCode = (err as any).statusCode || (err as any).status;
  } else if (typeof err === "object") {
    const obj = err as any;
    statusCode = obj.statusCode || obj.status || (obj.error && (obj.error.statusCode || obj.error.status));
    if (obj.message && typeof obj.message === "string") {
      msg = obj.message;
    } else if (obj.error && typeof obj.error === "object" && obj.error.message && typeof obj.error.message === "string") {
      msg = obj.error.message;
    } else {
      try {
        msg = JSON.stringify(obj);
      } catch {
        msg = String(err);
      }
    }
  } else {
    msg = String(err);
  }

  msg = msg.toLowerCase();
  
  if (statusCode === 401 || statusCode === 403 || statusCode === 400 || statusCode === 402) {
    return false;
  }

  if (
    msg.includes("api key") ||
    msg.includes("apikey") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("authentication") ||
    msg.includes("authorization") ||
    msg.includes("credentials") ||
    msg.includes("missing authentication header") ||
    msg.includes("credit required") ||
    msg.includes("no_credit") ||
    msg.includes("payment required") ||
    msg.includes("status 400") ||
    msg.includes("status: 400") ||
    msg.includes("invalid_request_error") ||
    msg.includes("empty response from model") ||
    msg.includes("tried to call unavailable tool") ||
    msg.includes("tried to call tool that is not available")
  ) {
    return false;
  }
  
  return true;
}

export function parsePayloadLimitBytes(msg: string): number | null {
  const normalized = msg.toLowerCase();
  // Try pattern: max/limit/exceeded 100kb / 100 kb / 1mb / 1048576 bytes
  const regex = /(?:max|limit|exceeded|exceeds|snippet:)\s*(?:is|to|of|:|=)?\s*["']?\s*(\d+(?:\.\d+)?)\s*(kb|mb|b|bytes|o)/i;
  const match = normalized.match(regex);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = match[2];
    if (unit.startsWith("kb")) {
      return value * 1024;
    }
    if (unit.startsWith("mb")) {
      return value * 1024 * 1024;
    }
    if (unit === "b" || unit.startsWith("byte")) {
      return value;
    }
  }

  // Try matching just a number in parenthesis/detail if it looks like bytes, e.g. "max: 1048576"
  const regexNum = /(?:max|limit|exceeded|exceeds|size|body)\s*[:=]?\s*["']?\s*(\d{5,12})\b/i;
  const matchNum = normalized.match(regexNum);
  if (matchNum) {
    return parseInt(matchNum[1], 10);
  }

  return null;
}



export class Agent {
  private static imageCache: Map<string, string[]> = new Map();

  private getCachedImages(text: string): string[] | null {
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    return Agent.imageCache.get(hash) || null;
  }

  private setCachedImages(text: string, images: string[]): void {
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (Agent.imageCache.size >= 500) {
      const oldest = Agent.imageCache.keys().next().value;
      if (oldest) Agent.imageCache.delete(oldest);
    }
    Agent.imageCache.set(hash, images);
  }

  private detectedPayloadLimitBytes?: number;
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
  private conversation: Conversation;
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

  /**
   * Build and cache the guidelines text (agents.md + mandatory preloaded skills).
   * Called once per Agent instance lifetime — subsequent calls return the cache.
   * Each SKILL.md is trimmed to MAX_SKILL_LINES lines to reduce token cost while
   * preserving the most important instructions at the top of each file.
   */
  private static readonly MAX_SKILL_LINES = 300;
  private static readonly MANDATORY_SKILLS: Array<{ key: string; label: string }> = [
    { key: "karpathy-guidelines",           label: "BEHAVIORAL CODING GUIDELINES (karpathy-guidelines)" },
    { key: "pragmatic-minimalism",          label: "PRAGMATIC MINIMALISM GUIDELINES (pragmatic-minimalism)" },
    { key: "superagent-planning",            label: "PLANNING AND TASK GUIDELINES (superagent-planning)" },
    { key: "writing-plans",                  label: "PLAN WRITING GUIDELINES (writing-plans)" },
    { key: "executing-plans",                label: "PLAN EXECUTION GUIDELINES (executing-plans)" },
    { key: "track-management",               label: "TRACK MANAGEMENT GUIDELINES (track-management)" },
    { key: "systematic-debugging",           label: "DEBUGGING GUIDELINES (systematic-debugging)" },
    { key: "verification-before-completion", label: "VERIFICATION GUIDELINES (verification-before-completion)" },
    { key: "subagent-driven-development",    label: "SUBAGENT DELEGATION GUIDELINES (subagent-driven-development)" },
  ];
  private static readonly MASTER_ONLY_SKILLS: Array<{ key: string; label: string }> = [
    { key: "master-agent-orchestration",     label: "MASTER AGENT ORCHESTRATION GUIDELINES (master-agent-orchestration)" },
  ];

  private static compressTelegraphic(text: string): string {
    // 1. Remove Markdown comments
    let cleaned = text.replace(/<!--[\s\S]*?-->/g, "");

    // 2. Remove verbose helper/filler phrasing commonly found in guidelines
    cleaned = cleaned.replace(/please\s+make\s+sure\s+to\s+/gi, "");
    cleaned = cleaned.replace(/please\s+ensure\s+that\s+you\s+/gi, "");
    cleaned = cleaned.replace(/you\s+should\s+always\s+/gi, "Always ");
    cleaned = cleaned.replace(/in\s+order\s+to\s+/gi, "To ");
    cleaned = cleaned.replace(/it\s+is\s+recommended\s+that\s+you\s+/gi, "Recommend: ");
    cleaned = cleaned.replace(/remember\s+to\s+/gi, "");
    cleaned = cleaned.replace(/it\s+is\s+mandatory\s+to\s+/gi, "Mandatory: ");
    cleaned = cleaned.replace(/note\s+that\s+/gi, "");
    cleaned = cleaned.replace(/do\s+not\s+forget\s+to\s+/gi, "Must ");

    // 3. Collapse multiple consecutive empty lines
    cleaned = cleaned.replace(/\n\s*\n\s*\n+/g, "\n\n");

    return cleaned;
  }

  /**
   * Trim a SKILL.md file's content to MAX_SKILL_LINES lines while always
   * preserving the YAML frontmatter (--- delimited block at the top, if any).
   * The line cap applies only to the body — critical metadata is never cut off.
   */
  private static trimSkillContent(raw: string, absolutePath: string): string {
    const minified = Agent.compressTelegraphic(raw);
    const lines = minified.split("\n");

    // Detect YAML frontmatter: file starts with "---" and has a closing "---"
    let frontmatterEnd = 0;
    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i]?.trim() === "---") {
          frontmatterEnd = i + 1; // include the closing ---
          break;
        }
      }
    }

    const frontmatter = lines.slice(0, frontmatterEnd);
    const body = lines.slice(frontmatterEnd);

    if (body.length <= Agent.MAX_SKILL_LINES) {
      return minified; // no trimming needed
    }

    const trimmedBody = body.slice(0, Agent.MAX_SKILL_LINES);
    return [
      ...frontmatter,
      ...trimmedBody,
      "",
      `... [truncated — full content at: ${absolutePath}]`,
    ].join("\n");
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
    context: { source: string; role?: string; task?: string; branch?: string; typeName?: string }
  ): Promise<string> {
    if (options.length === 0) return "";

    // Gather context from Master's plan + recent conversation
    let planContext = "";
    try {
      const planPath = this.getPlanFilePath();
      if (fs.existsSync(planPath)) {
        planContext = fs.readFileSync(planPath, "utf-8");
      }
    } catch {}

    let recentHistory = "";
    try {
      const msgs = this.conversation.getMessages();
      const recent = msgs.slice(-12);
      recentHistory = recent
        .map((m: any) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
        .join("\n");
    } catch {}

    const sourceLabel = context.source === "superagent"
      ? `Superagent (role: ${context.role || "?"}, branch: ${context.branch || "?"}, task: "${context.task || "?"}")`
      : `Subagent (role: ${context.role || "?"}, type: ${context.typeName || "?"})`;

    const optionsList = options.map((o, i) => `${i + 1}. ${o}`).join("\n");

    const prompt = `You are the Master Agent orchestrating a multi-agent development session.
A ${sourceLabel} has hit a decision point and is asking a question during task execution.
You must answer on behalf of the user based on your knowledge of the project, the implementation plan, and the overall task context.

QUESTION FROM THE AGENT:
${question}

AVAILABLE OPTIONS:
${optionsList}
${planContext ? `\n--- CURRENT IMPLEMENTATION PLAN ---\n${planContext.slice(0, 4000)}\n` : ""}${recentHistory ? `\n--- RECENT MASTER CONVERSATION CONTEXT ---\n${recentHistory.slice(0, 3000)}\n` : ""}
Pick the BEST option that aligns with the project goals, the implementation plan, and good engineering judgment.
Reply with ONLY the exact text of the chosen option — no numbering, no explanation, no markdown.
If none of the options are suitable, still pick the closest one.`;

    // Use rate limiter only — bypass concurrency limiter to avoid deadlock
    // when SUPERAGENT_MAX_CONCURRENCY=1 and Master's main loop is in flight.
    try {
      await rateLimiter.acquire(1);

      const result = await generateText({
        model: this.getModel(),
        prompt,
      });

      // Track token usage so Master's token counter stays accurate
      try {
        const { addMasterTokens } = await import("./tools/state.js");
        addMasterTokens(result.usage?.promptTokens || 0, result.usage?.completionTokens || 0);
      } catch {}

      const cleaned = result.text.trim().replace(/^["']|["']$/g, "");

      // Exact match
      const exact = options.find((o) => o === cleaned);
      if (exact) return exact;

      // Loose match: option text appears in response (case-insensitive)
      const lower = cleaned.toLowerCase();
      const loose = options.find((o) => lower.includes(o.toLowerCase()));
      if (loose) return loose;

      // Number prefix match (e.g. "1. Option A" or just "1")
      const numMatch = cleaned.match(/^(\d+)/);
      if (numMatch) {
        const idx = parseInt(numMatch[1], 10) - 1;
        if (idx >= 0 && idx < options.length) return options[idx];
      }

      // Fallback: first option
      return options[0];
    } catch {
      return options[0];
    }
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
    const historyPath = this.currentHistoryFilePath || this.resolveHistoryFilePath(false);
    return historyPath.replace(/\.json$/, "_implementation_plan.md");
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

    if (!(await isTencentdbActive())) {
      tools = tools.filter((t) => !t.name.startsWith("tdai_"));
    }
    return tools;
  }

  public getTaskFilePath(): string {
    const historyPath = this.currentHistoryFilePath || this.resolveHistoryFilePath(false);
    return historyPath.replace(/\.json$/, "_task.md");
  }

  public getWalkthroughFilePath(): string {
    const historyPath = this.currentHistoryFilePath || this.resolveHistoryFilePath(false);
    return historyPath.replace(/\.json$/, "_walkthrough.md");
  }

  public getTaskHistoryFilePath(): string {
    return getTaskHistoryPath(this.getTaskFilePath());
  }

  private resolveHistoryFilePath(autoResume: boolean | string): string {
    ensureGlobalConfigDir();
    const sanitizedPath = this.workingDirectory.replace(/[^a-zA-Z0-9]/g, "_");
    const mode = this.isMultiAgent ? "multi" : "single";
    let historyDir = path.join(getGlobalConfigDir(), "history", mode);

    if (this.tier === "subagent" || this.tier === "superagent") {
      const parentSessionPath = process.env.SUPERAGENT_SESSION_PATH;
      if (parentSessionPath) {
        const parentSessionDir = path.dirname(parentSessionPath);
        const resolvedParent = path.resolve(parentSessionDir);
        const resolvedGlobal = path.resolve(getGlobalConfigDir());
        if (resolvedParent.startsWith(resolvedGlobal)) {
          historyDir = path.join(parentSessionDir, this.tier === "subagent" ? "subagents" : "superagents");
        } else {
          historyDir = path.join(historyDir, this.tier === "subagent" ? "subagents" : "superagents");
        }
      } else {
        historyDir = path.join(historyDir, this.tier === "subagent" ? "subagents" : "superagents");
      }
    }

    if (typeof autoResume === "string" && autoResume.trim() !== "") {
      const val = autoResume.trim();
      // 1. Check if it's a direct path to a json file
      if (fs.existsSync(val) && val.endsWith(".json")) {
        return val;
      }
      // 2. Check if it's a folder in historyDir
      const possibleDir = path.join(historyDir, val);
      const possibleFile = path.join(possibleDir, `${val}.json`);
      if (fs.existsSync(possibleFile)) {
        return possibleFile;
      }
      // 3. Check if it's a folder name matching any suffix (e.g. timestamp or part of name)
      if (fs.existsSync(historyDir)) {
        const dirs = fs.readdirSync(historyDir);
        const match = dirs.find(d => d.toLowerCase() === val.toLowerCase() || d.toLowerCase().endsWith("_" + val.toLowerCase()));
        if (match) {
          const matchFile = path.join(historyDir, match, `${match}.json`);
          if (fs.existsSync(matchFile)) {
            return matchFile;
          }
        }
      }
    }

    if (autoResume) {
      try {
        if (fs.existsSync(historyDir)) {
          const dirs = fs.readdirSync(historyDir);
          const matchedDirs = dirs.filter(d => {
            const nameLower = d.toLowerCase();
            const cleanNameLower = nameLower.replace(/_\d+$/, "");
            return cleanNameLower === sanitizedPath.toLowerCase() || cleanNameLower.startsWith(sanitizedPath.toLowerCase() + "_");
          });

          if (matchedDirs.length > 0) {
            const sorted = matchedDirs.map(d => {
              const dirPath = path.join(historyDir, d);
              const filePath = path.join(dirPath, `${d}.json`);
              const match = d.match(/_(\d+)$/);
              let mtime = match ? parseInt(match[1], 10) : 0;
              if (mtime === 0) {
                try {
                  mtime = fs.statSync(filePath).mtime.getTime();
                } catch {
                  try {
                    mtime = fs.statSync(dirPath).mtime.getTime();
                  } catch {}
                }
              }
              return { filePath, mtime };
            }).sort((a, b) => b.mtime - a.mtime);

            // Iterate over candidates to find the most recent valid session
            for (const item of sorted) {
              try {
                const content = fs.readFileSync(item.filePath, "utf-8");
                const parsed = JSON.parse(content);
                if (parsed && parsed.workingDirectory) {
                  if (normalizeAndCheckSubpath(parsed.workingDirectory, this.workingDirectory)) {
                    return item.filePath;
                  }
                } else {
                  // Legacy fallback: check if cleanName is exactly the sanitized path of current workingDirectory
                  const cleanNameLower = path.basename(item.filePath, ".json").toLowerCase().replace(/_\d+$/, "");
                  if (cleanNameLower === sanitizedPath.toLowerCase()) {
                    return item.filePath;
                  }
                }
              } catch {
                // Ignore and try next candidate
              }
            }
          }
        }
      } catch {
        // Ignore and generate a new one
      }
    }

    const timestamp = Date.now();
    const sessionId = `${sanitizedPath}_${timestamp}`;
    const sessionDir = path.join(historyDir, sessionId);
    return path.join(sessionDir, `${sessionId}.json`);
  }

  public getCurrentHistoryFilePath(): string {
    if (!this.currentHistoryFilePath) {
      this.currentHistoryFilePath = this.resolveHistoryFilePath(false);
    }
    process.env.SUPERAGENT_SESSION_PATH = this.currentHistoryFilePath;
    return this.currentHistoryFilePath;
  }

  getConversationMessages(): Message[] {
    return this.conversation.getMessages();
  }

  async loadHistory(autoResume: boolean | string = false): Promise<void> {
    this.currentHistoryFilePath = this.resolveHistoryFilePath(autoResume);
    process.env.SUPERAGENT_SESSION_PATH = this.currentHistoryFilePath;
    await this.conversation.loadFromFile(this.currentHistoryFilePath);
    if (this.conversation.loadedPlanState) {
      this.planState = this.conversation.loadedPlanState;
    }
  }

  async loadHistoryFromPath(filePath: string): Promise<void> {
    this.currentHistoryFilePath = filePath;
    process.env.SUPERAGENT_SESSION_PATH = filePath;
    await this.conversation.loadFromFile(filePath);
    if (this.conversation.loadedPlanState) {
      this.planState = this.conversation.loadedPlanState;
    }
  }

  async saveHistory(): Promise<void> {
    if (!this.currentHistoryFilePath) {
      this.currentHistoryFilePath = this.resolveHistoryFilePath(false);
    }
    process.env.SUPERAGENT_SESSION_PATH = this.currentHistoryFilePath;

    // Incrementally sync new messages to TencentDB if enabled before saving to file,
    // so we can persist the updated lastCapturedTimestamp in a single write.
    try {
      await this.syncConversationToTencentDB();
    } catch (err: any) {
      this.writeToLogFile("WARN", `Failed to incrementally sync conversation to TencentDB: ${err.message}`);
    }

    await this.conversation.saveToFile(this.currentHistoryFilePath, this.planState, this.workingDirectory);
    clearHistoryCache();
  }

  saveHistorySync(): void {
    if (!this.currentHistoryFilePath) {
      this.currentHistoryFilePath = this.resolveHistoryFilePath(false);
    }
    process.env.SUPERAGENT_SESSION_PATH = this.currentHistoryFilePath;

    this.conversation.saveToFileSync(this.currentHistoryFilePath, this.planState, this.workingDirectory);
    clearHistoryCache();
  }

  private getModel() {
    return getModelInstanceForTier(this.tier, this.delegationDepth, this.subagentType, !this.isMultiAgent);
  }

  async sendMessage(userInput: string | import("./conversation.js").MessageContent): Promise<void> {
    if (this.isRunning) {
      // Queue the message instead of dropping it silently.
      // This handles the race condition where the user approves a plan
      // while the agent loop is still finishing its current iteration.
      const msgText = typeof userInput === "string" ? userInput : "[multimodal message]";
      this.pendingMessagesQueue.push(userInput);
      this.writeToLogFile("INFO", `Message queued (agent is running): "${msgText.substring(0, 80)}..."`);
      return;
    }

    const currentCwd = (this.tier === "superagent" && this.worktreePath)
      ? this.worktreePath
      : this.workingDirectory;
    this.gitStartSnapshot = await captureGitSnapshot(currentCwd);

    const isTestEnv = process.env.VITEST && process.env.SUPERAGENT_TEST_SIMPLE_TASK !== "true";
    if (!isTestEnv) {
      try {
        const settings = getSettings();
        if (settings.classifierEnabled !== false) {
          // Multi-category request classification for token optimization
          const { classifyRequest } = await import("./requestClassifier.js");
          const classifierModel = getModelInstanceForTier("subagent", 2, "classifier", !this.isMultiAgent);
          const classification = await classifyRequest(userInput, classifierModel, {
            confidenceThreshold: settings.classifierConfidenceThreshold ?? "high",
            customKeywords: settings.classifierKeywords as any,
            skipLLM: this.planState !== "IDLE",
          });
          this.currentClassification = classification;
          this.writeToLogFile("INFO", `Request classified: category=${classification.category}, confidence=${classification.confidence}, heuristicOnly=${classification.heuristicOnly}, tokens=${classification.classificationTokens}, reason=${classification.reason}`);

          // Track tokens for the classification call if LLM was used
          if (!classification.heuristicOnly && classification.classificationTokens > 0) {
            try {
              const { addMasterTokens } = await import("./tools/state.js");
              addMasterTokens(classification.classificationTokens, 0);
            } catch {}
          }

          // Map classification to planState and isSimpleTask using original categories
          if (this.planState === "IDLE") {
            const skipPlanningCategories = ["conversation", "question", "research"];
            if (skipPlanningCategories.includes(classification.category)) {
              this.isSimpleTask = true;
              this.planState = "APPROVED";
              this.simpleTaskApproved = true;
            } else if (classification.category === "complex_task") {
              // Check for complex task indicators or plan requests
              const userInputText = typeof userInput === "string" ? userInput : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");
              const lowerInput = userInputText.toLowerCase();
              const isPlanRequest = /plan|design|architecture/i.test(lowerInput);
              if (isPlanRequest) {
                this.isSimpleTask = false;
              } else {
                const isComplex = /refactor|rewrite|architecture|design|feature|migration|oauth|database|schema|multi-file/i.test(lowerInput) || lowerInput.split(/\s+/).length > 25;
                if (isComplex) {
                  this.isSimpleTask = false;
                } else {
                  this.isSimpleTask = true;
                  this.planState = "APPROVED";
                  this.simpleTaskApproved = true;
                }
              }
            } else if (classification.category === "simple_edit" || classification.category === "command" || classification.category === "debug") {
              this.isSimpleTask = true;
              this.planState = "APPROVED";
              this.simpleTaskApproved = true;
            }
          }
        } else {
          // Fallback to legacy simpleTask classification when classifier is disabled
          if (this.planState === "IDLE") {
            const model = this.getModel();
            const threshold = settings.simpleTaskFileThreshold ?? 3;
            const classificationPrompt = `You are a helper that classifies if a user request is a "simple task".
  A request is a "simple task" if it expects modification or creation of fewer than ${threshold} files and does NOT introduce any new architecture, major system changes, or complex orchestration.
  For example, simple refactorings, adding single simple functions, modifying specific existing logic, or fixing a simple bug are simple tasks.

  User request: "${userInput}"

  Reply with EXACTLY "yes" if it is a simple task, or "no" if it is not. Reply with nothing else.`;

            const response = await generateText({
              model,
              prompt: classificationPrompt,
            });

            try {
              const { addMasterTokens } = await import("./tools/state.js");
              addMasterTokens(response.usage?.promptTokens || 0, response.usage?.completionTokens || 0);
            } catch {}

            const classification = response.text.trim().toLowerCase();
            if (classification === "yes" || classification.includes("yes")) {
              this.isSimpleTask = true;
              this.planState = "APPROVED";

              const userInputText = typeof userInput === "string" ? userInput : (userInput as any[]).map((p: any) => p.type === "text" ? p.text : "").join(" ");
              const lowerInput = userInputText.toLowerCase();
              const words = lowerInput.split(/[^a-zA-Z0-9'']+/).filter(Boolean);
              const preApprovalWords = settings.simpleTaskKeywords || ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'];
              const hasPreApproval = preApprovalWords.some(word => {
                if (word.includes(' ')) {
                  return lowerInput.includes(word);
                }
                return words.some(w => w === word || (word.length >= 4 && w.startsWith(word)));
              });
              if (hasPreApproval) {
                this.simpleTaskApproved = true;
              }
            }
          }
        }
      } catch (err: any) {
        this.writeToLogFile("WARN", `Failed to classify user request: ${err.message}`);
      }
    }


    this.isRunning = true;
    this.abortController = new AbortController();

    this.writeToLogFile("INFO", `Agent execution started (tier: ${this.tier}, depth: ${this.delegationDepth}, isMultiAgent: ${this.isMultiAgent}, workingDirectory: ${this.workingDirectory}, worktreePath: ${this.worktreePath})`);
    this.writeToLogFile("USER", typeof userInput === "string" ? userInput : "[multimodal message]");

    this.conversation.addUserMessage(userInput);
    await this.compactHistoryIfNeeded();
    await this.saveHistory();

    // Auto-checkpoint on every user message (with cooldown)
    this.autoCheckpoint("User message");

    // ── Auto-archive completed tasks on follow-up messages ──────────────
    // When all tasks are done and the user sends a new message, archive
    // the completed tasks to _task_history.md and reset _task.md so new
    // tasks can be created for the follow-up request.
    this.tasksJustArchived = false;
    this.archivedTaskCount = 0;
    if (this.planState === "APPROVED") {
      try {
        const taskPath = this.getTaskFilePath();
        const allDone = await allTasksCompleted(taskPath);
        if (allDone) {
          const archived = await archiveCompletedTasks(taskPath);
          if (archived.length > 0) {
            this.tasksJustArchived = true;
            this.archivedTaskCount = archived.length;
            this.writeToLogFile("INFO", `Auto-archived ${archived.length} completed tasks to history. Ready for new task creation.`);
          }
        }
      } catch (err: any) {
        this.writeToLogFile("WARN", `Failed to auto-archive completed tasks: ${err.message}`);
      }
    }

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

      // If messages were queued while this run was in progress (e.g. plan approval),
      // auto-send the next one now instead of firing "done" and stopping.
      if (this.pendingMessagesQueue.length > 0) {
        const queued = this.pendingMessagesQueue.shift()!;
        const logText = typeof queued === "string" ? queued : "[multimodal message]";
        this.writeToLogFile("INFO", `Auto-sending queued message: "${logText.substring(0, 80)}..."`);
        // Fire a "text" event so the UI knows the agent is continuing
        this.onEvent({ type: "text", content: "\n[SYS] Resuming with queued approval message...\n" });
        // Recursively send — this sets isRunning=true and starts a new loop
        await this.sendMessage(queued);
      } else {
        this.onEvent({ type: "done" });
      }
    }
  }

  private async runAgentLoop(): Promise<void> {
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

        // Run workspace discovery and load/update cache if workspace files changed
        const classifierSkipWsDiscovery = this.currentClassification
          ? (await import("./requestClassifier.js")).shouldSkipWorkspaceDiscovery(this.currentClassification.category)
          : false;
        if (!this.disableWorkspaceDiscovery && this.tier !== "subagent" && !classifierSkipWsDiscovery) {
          const shouldScan = !this.workspaceCache || this.workspaceCacheNeedsUpdate;
          if (shouldScan) {
            try {
              const { discoverWorkspace } = await import("./workspaceDiscovery.js");
              const { isIdentical, cache } = await discoverWorkspace(this.workingDirectory);
              const wasFirstRun = !this.workspaceCache;
              this.workspaceCache = cache;
              this.workspaceCacheNeedsUpdate = false;
              if (wasFirstRun) {
                if (isIdentical) {
                  this.onEvent({
                    type: "text",
                    content: `\n[SYS] Workspace identical to previous session. Using cached context.\n`,
                  });
                } else {
                  this.onEvent({
                    type: "text",
                    content: `\n[SYS] Workspace scanned and cached.\n`,
                  });
                }
              } else if (!isIdentical) {
                this.onEvent({
                  type: "text",
                  content: `\n[SYS] Workspace changes detected. Updated cache.\n`,
                });
              }
            } catch (err: any) {
              this.writeToLogFile("WARN", `Workspace discovery failed: ${err.message}`);
            }
          }
        }

        // On first iteration, prepopulate the TencentDB Memory context if enabled
        if (i === 0) {
          try {
            await this.prepopulateTencentDBMemoryContext();
          } catch (err: any) {
            this.writeToLogFile("WARN", `Failed to prepopulate TencentDB Memory context: ${err.message}`);
          }
        }

        await this.compactHistoryIfNeeded(signal);
        // Check if the endpoint/model supports native tool calling
        let supportsNativeTools = true;
        const details = getModelConnectionDetailsForTier(this.tier, this.delegationDepth, this.subagentType, !this.isMultiAgent);
        if (getSettings().forcePromptBasedToolCalling) {
          supportsNativeTools = false;
        } else {
          const isTest = !!process.env.VITEST;
          if (!isTest && details.provider === "custom" && details.baseUrl) {
            try {
              const { probeToolCallSupport } = await import("../utils/promptBasedToolCalling.js");
              supportsNativeTools = await probeToolCallSupport(details.baseUrl, details.apiKey, details.modelName);
            } catch (err: any) {
              this.writeToLogFile("WARN", `Failed to probe tool call support: ${err.message}. Defaulting to native tools.`);
            }
          }
        }
        let messages = this.buildMessages(supportsNativeTools);
        // Use tier-specific toolset if provided, otherwise use the appropriate tier-default toolset dynamically
        let toolsToUse = await this.getActiveTools();

        const toolDefs = toolsToUse
          ? toolsToUse.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            }))
          : getToolDefinitions();

        // ── Classifier-based toolset filtering ──────────────────────────────
        // Reduce tool definitions based on the request category to save tokens.
        let filteredToolDefs = toolDefs;
        if (this.currentClassification) {
          try {
            const { getToolsetForCategory } = await import("./requestClassifier.js");
            const filteredTools = getToolsetForCategory(this.currentClassification.category, toolsToUse || []);
            if (filteredTools.length !== (toolsToUse?.length ?? toolDefs.length)) {
              filteredToolDefs = filteredTools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              }));
              if (i === 0) {
                this.writeToLogFile("INFO", `Classifier reduced toolset: ${toolDefs.length} -> ${filteredToolDefs.length} tools for category '${this.currentClassification.category}'`);
              }
            }
          } catch {
            // Non-critical: fall back to full toolset
          }
        }

        // Helper to get file existence status label
        const fileStatus = (filePath: string): string =>
          fs.existsSync(filePath) ? "[EXISTS]" : "[NOT YET CREATED]";

        let planStateNotice = "";
        if (this.tier === "master" || this.tier === "single") {
          const planPath = this.getPlanFilePath();
          const taskPath = this.getTaskFilePath();
          const taskHistoryPath = this.getTaskHistoryFilePath();
          const walkthroughPath = this.getWalkthroughFilePath();
          planStateNotice = `

PLANNING, TASKS & VERIFICATION FILES FOR THIS SESSION:
- Implementation Plan File: ${planPath} ${fileStatus(planPath)}
- Task Tracking File: ${taskPath} ${fileStatus(taskPath)}
- Task History File: ${taskHistoryPath} ${fileStatus(taskHistoryPath)}
- Verification/Walkthrough File: ${walkthroughPath} ${fileStatus(walkthroughPath)}

CRITICAL RULES FOR PLANNING:
1. You MUST use the 'manage_plan' tool (action: 'create', 'edit', or 'sync') to create, edit, update, or synchronize the Implementation Plan and tasks.
2. You MUST use the 'manage_tasks' tool to manage checklist tasks:
   - 'add' (single task) or 'add_bulk' with 'texts' array (multiple tasks at once).
   - 'update' (single) or 'update_bulk' with 'indices' array (multiple tasks at once) to change task status.
   - 'remove' (single) or 'remove_bulk' with 'indices' array to delete tasks.
   - 'list' to inspect current tasks.
3. DO NOT use 'write_to_file', 'replace_file_content', 'multi_replace_file_content', or 'edit' to create, modify, or update the Implementation Plan File or the Task Tracking File directly. Doing so is strictly forbidden.
4. For the Verification/Walkthrough File, you may use 'write_to_file' directly.
5. Do NOT write or create plan or task files in the local workspace directory.
6. Whenever you reference these files, always use their absolute paths or format them as absolute file:/// links.`;
        } else if (this.tier === "superagent") {
          const planPath = this.getPlanFilePath();
          const taskPath = this.getTaskFilePath();
          const taskHistoryPath = this.getTaskHistoryFilePath();
          const walkthroughPath = this.getWalkthroughFilePath();
          planStateNotice = `

PLANNING, TASKS & VERIFICATION FILES FOR THIS SESSION:
- Implementation Plan File: ${planPath} ${fileStatus(planPath)}
- Task Tracking File: ${taskPath} ${fileStatus(taskPath)}
- Task History File: ${taskHistoryPath} ${fileStatus(taskHistoryPath)}
- Verification/Walkthrough File: ${walkthroughPath} ${fileStatus(walkthroughPath)}

CRITICAL RULES FOR PLANNING:
1. You MUST use the 'manage_tasks' tool to manage checklist tasks:
   - 'add' (single task) or 'add_bulk' with 'texts' array (multiple tasks at once).
   - 'update' (single) or 'update_bulk' with 'indices' array (multiple tasks at once) to change task status.
   - 'remove' (single) or 'remove_bulk' with 'indices' array to delete tasks.
   - 'list' to inspect current tasks.
2. DO NOT attempt to directly modify the Implementation Plan File or Task Tracking File using 'write_to_file', 'replace_file_content', or other file writing tools. Direct modification of these files is strictly blocked by the system's security boundaries.
3. For the Verification/Walkthrough File, you may use 'write_to_file' directly.
4. Do NOT write or create plan or task files in the local workspace directory.
5. Whenever you reference these files, always use their absolute paths or format them as absolute file:/// links.`;
        }

        let planStateAddendum = "";
        if (this.planState === "PLANNING_PENDING") {
          planStateAddendum = `\n\n⚠️ IMPORTANT PLAN STATE NOTICE:
An implementation plan has been written to '${this.getPlanFilePath()}' and is currently pending user approval.
You are temporarily in a READ-ONLY mode.
- DO NOT attempt to write/edit/modify any codebase files.
- DO NOT run terminal commands that modify files, add packages, or check out git branches.
- Focus on explaining your proposed plan to the user, answering any questions, or waiting for them to approve via the interactive approval wizard.`;
        } else if (this.planState === "APPROVED") {
          planStateAddendum = `\n\n✓ PLAN STATE NOTICE:
The user has APPROVED your implementation plan. You are now fully authorized to modify codebase files and run commands to execute the plan.`;
        }

        // ── Follow-up task creation hint ──────────────────────────────────
        // When tasks were just archived (all were completed, user sent new message),
        // tell the AI to create new tasks for the follow-up request.
        let followUpTaskAddendum = "";
        if (this.tasksJustArchived && i === 0) {
          followUpTaskAddendum = `\n\n🔄 TASK CHECKLIST RESET NOTICE:
All ${this.archivedTaskCount} previous tasks were completed and have been archived to the task history file.
The active task list has been cleared and is ready for new tasks.
You SHOULD use the 'manage_tasks' tool (action: 'add' or 'add_bulk') or 'manage_plan' tool (action: 'create') to create fresh tasks for the user's new request.
Use 'add_bulk' with a 'texts' array to add multiple tasks in a single call (more efficient than repeated 'add' calls).
This ensures the ACTIVE TASK CHECKLIST stays up-to-date with the current work.`;
          // Reset the flag after injecting on first iteration only
          this.tasksJustArchived = false;
        }

        const currentStep = i + 1;
        const workspacePath = this.workingDirectory || process.cwd();
        const runningProcesses = Array.from(backgroundTasks.entries())
          .filter(([_, t]) => !t.hasExited && isTaskInWorkspace(t.cwd, workspacePath))
          .map(([id, t]) => `- Process ID: ${id}, Command: "${t.command}"`)
          .join("\n");
        const processNotice = runningProcesses
          ? `\n\n⚙️ RUNNING BACKGROUND/TERMINAL PROCESSES:\nYou are aware that the following background/terminal processes are currently running in the environment:\n${runningProcesses}`
          : "";

        // ── Inject pinned knowledge from global store (persistently to keep prompt cache hot) ──
        let pinnedKnowledgeNotice = "";
        try {
          const { getAllKnowledge, formatKnowledgeForPrompt } = await import("./pinnedKnowledge.js");
          const knowledgeEntries = getAllKnowledge({ limit: 10 });
          if (knowledgeEntries.length > 0) {
            pinnedKnowledgeNotice = "\n\n" + formatKnowledgeForPrompt(knowledgeEntries, 8, 1500);
          }
        } catch { /* non-critical */ }

        // ── Single-mode subagent directive ──────────────────────────────────
        const singleModeSubagentDirective = this.tier === "single" ? `

SUBAGENT WORKFLOW — GUIDELINES FOR SINGLE MODE:
You operate in single-agent mode. You should leverage subagents when tasks are complex, independent, or can be run in parallel.
For small, simple, or direct operations (e.g. reading a single file, running a quick build or test command, or editing a specific code block), you should perform them directly rather than spawning subagents. This minimizes process spawning and context-swapping overhead.

SUBAGENT RULES:
1. RESEARCH tasks (exploring codebase, reading docs, searching web) → Spawn a 'researcher' subagent for broad context gathering or when reading multiple files. You may perform quick direct lookups.
2. IMPLEMENTATION tasks (writing code, editing files) → Spawn a 'coder' subagent for multi-file changes or larger features. You may perform small or simple inline modifications.
3. REVIEW tasks (checking correctness, testing, validating) → Spawn a 'reviewer' subagent for verifying large features. For simple verification, run commands directly.
4. COMPLEX requests → Break into parallel subtasks and spawn multiple subagents concurrently.

SUBAGENT DISPATCH PATTERN (follow this when delegating):
  Step 1 — Analyze: understand what the user wants.
  Step 2 — Plan: identify independent subtasks (and which skills are relevant).
  Step 3 — Spawn: invoke subagents for each subtask (parallel if independent).
  Step 4 — Integrate: collect results, synthesize, respond to user.

WHEN YOU SHOULD DELEGATE TO A SUBAGENT (non-exhaustive):
- Any codebase investigation spanning multiple folders or components
- Multi-file editing or complex feature implementation
- Large-scale refactoring or major architectural changes
- Web search or documentation lookup that requires extensive research

SKILL USAGE — MANDATORY:
You have access to INSTALLED AGENT SKILLS listed above. You MUST use them.
BEFORE starting any task, identify which skill(s) are relevant and load them using the use_skill tool.
Skill categories to always check:
- Debugging/investigation → 'systematic-debugging', 'root-cause-tracing', 'diagnosing-bugs'
- New feature/development → 'writing-plans', 'subagent-driven-development', 'test-driven-development-tdd'
- Code review → 'requesting-code-review', 'code-review-reception'
- Finishing work → 'finishing-a-development-branch', 'verification-before-completion'
- Research/exploration → 'dispatching-parallel-agents'
DO NOT skip skill reading. Instruct your subagents to also read and follow the relevant SKILL.md.

BULK READ — MANDATORY:
When you need to read or analyze multiple files, ALWAYS batch them into a single tool call using the 'filePaths' array — NEVER read files one at a time in sequential calls.
- Identify ALL files needed upfront, then read them all in one call before processing.
- If reading related files (e.g. types, imports, tests, configs), include them all in the same batch.
- This applies to you and all subagents you spawn.

FAST ANALYSIS — MANDATORY:
To reduce latency, prevent timeout issues, and save tokens:
1. PINPOINT FIRST: ALWAYS use 'grep' or 'ripgrep' search tools to locate exact files/lines containing target symbols (e.g. methods, classes, variables) before reading files. Do NOT use recursive directory listings or read large files blindly.
2. TARGETED READING: If a file is large (>200 lines), only view/read the specific line range (using StartLine/EndLine parameters) containing the code you actually need to examine.
3. EXCLUDE GENERIC DIRECTORIES: Filter out dependency/build folders ('node_modules', 'dist', 'build', '.git', etc.) in glob/search path arguments.


CONTEXT_ANCHOR — ANTI-DRIFT PROTOCOL:
Before each action, verify:
1. Am I still working toward the PRIMARY OBJECTIVE?
2. Am I within declared boundaries / workspace limits?
3. Will this action move closer to success/acceptance criteria?

POST-CHANGE VERIFICATION — MANDATORY AFTER ANY CODE MODIFICATION:
Whenever you (or any subagent) modify source files, you MUST run verification before responding to the user:
1. BUILD: Run the project's build command (e.g. 'npm run build', 'cargo build', 'go build', 'mvn compile'). If it fails, fix all compile errors before proceeding.
2. TEST: Run the project's test suite (e.g. 'npm test', 'cargo test', 'pytest', 'go test ./...'). If tests fail, diagnose and fix them. Do NOT skip this step.
3. CONCERN_TRACKS: Evaluate changes against all 5 tracks: Correctness (logic/tests), Resilience (failure modes), Consistency (patterns/naming), Impact-Radius (trace consumers), Reversibility.
4. if verification_failed: fix errors → re-run build + test → repeat until both pass.
5. ONLY respond to the user AFTER build and test both pass.

SELF-VERIFICATION & CRITIC — MANDATORY BEFORE RESPONDING TO USER:
After all subagents finish, you MUST perform this verification loop before considering the task done:
1. VALIDATE OUTPUTS: Review each subagent's report. Check that build passed, tests passed, and all task requirements are met.
2. CRITIC: Actively challenge the results. Ask yourself:
   - Did the coder subagent actually run the build and tests? If not, spawn a reviewer to verify.
   - Are there edge cases that were not addressed?
   - Does the implementation actually solve the user's original request (not just a surface interpretation)?
   - Are there any TODOs, placeholders, or incomplete parts?
3. SELF-INTERROGATION: Ask yourself: "What am I assuming that might be wrong?", "What is the simplest thing that could break this?", "If reviewing this from someone else, what would I flag?", "What did I NOT check?", and "Is there a simpler approach?".
4. IF GAPS FOUND → spawn a fix subagent (coder or reviewer) to address them. Do NOT report completion with known gaps.
5. ONLY report completion when you have concrete evidence (build pass, test pass, acceptance criteria met).` : "";

        let activeSystemPrompt = baseSystemPrompt;
        if (this.workspaceCache) {
          try {
            const { injectWorkspaceOverview } = await import("./workspaceDiscovery.js");
            activeSystemPrompt = injectWorkspaceOverview(baseSystemPrompt, this.workspaceCache);
          } catch {}
        }

        if (!(await isTencentdbActive())) {
          activeSystemPrompt = activeSystemPrompt
            .replace(/'save_shared_memory' or 'tdai_memory_save'/g, "'save_shared_memory'")
            .replace(/or 'tdai_memory_save'/g, "")
            .replace(/, 'tdai_memory_save'/g, "")
            .replace(/tdai_[a-zA-Z0-9_]+/g, "");
        }

        let devHookNotice = "";
        try {
          const { getActiveDevHookGlobal } = await import("./tools/state.js");
          const activeDevHook = getActiveDevHookGlobal();
          if (activeDevHook) {
            devHookNotice = `\n\n🛠️ ACTIVE INTERNAL HOOK DEVELOPMENT FOCUS:
- You are currently focusing on developing the "${activeDevHook}" internal hook.
- CRITICAL: Your active working directory (CWD) is ALREADY set to the hook's folder: "internal-hooks/${activeDevHook}/".
- All files in the WORKSPACE FILES LIST (like hook.json, index.js, package.json, README.md, CHANGELOG.md) are located directly inside this hook folder.
- You MUST access, read, and modify these files using their direct relative names (e.g., "index.js", "hook.json", "package.json") WITHOUT any "internal-hooks/${activeDevHook}/" prefix.
- DO NOT prefix paths with "internal-hooks/${activeDevHook}/" because doing so will resolve to incorrect nested paths.
- Your primary objective is to implement, refine, or test this specific hook.
- If you need to access files in the parent project, prefix them with "../../" to reference them relative to the project root.
- You can test this hook's execution and verify its behavior locally by calling appropriate terminal commands or using "/ih dev ${activeDevHook}" as reference.`;
          }
        } catch {}

        let sharedMemoryNotice = "";
        try {
          const { getRootConfigDir } = await import("./config/paths.js");
          const sharedMemPath = path.join(getRootConfigDir(), "shared-memory.json");
          if (fs.existsSync(sharedMemPath)) {
            const raw = fs.readFileSync(sharedMemPath, "utf-8");
            const memories = JSON.parse(raw);
            if (Array.isArray(memories) && memories.length > 0) {
              const currentWorkspace = path.resolve(process.cwd());
              
              const globalMemories = memories
                .filter((m: any) => m.scope === "global")
                .slice(-10);

              const projectMemories = memories
                .filter((m: any) => {
                  if (m.scope === "global") return false;
                  if (!m.projectPath) return true; // fallback for un-scoped legacy items
                  return path.resolve(m.projectPath) === currentWorkspace;
                })
                .slice(-15);

              const sections: string[] = [];
              if (globalMemories.length > 0) {
                const lines = globalMemories.map((m: any) => `- [${m.source}] ${m.key}: ${m.value}`).join("\n");
                sections.push(`### GLOBAL AGENT MEMORIES:\n${lines}`);
              }
              if (projectMemories.length > 0) {
                const lines = projectMemories.map((m: any) => `- [${m.source}] ${m.key}: ${m.value}`).join("\n");
                sections.push(`### PROJECT AGENT MEMORIES (this workspace):\n${lines}`);
              }

              if (sections.length > 0) {
                sharedMemoryNotice = `\n\n${sections.join("\n\n")}`;
              }
            }
          }
        } catch {}

        // Build static system prompt (cacheable)
        // Workspace boundary constraint injected into every system prompt iteration
        const workspaceDir = this.worktreePath || this.workingDirectory;
        const workspaceBoundaryNotice = workspaceDir
          ? `

# WORKSPACE BOUNDARY — CRITICAL
- Workspace root: "${workspaceDir}"
- ALL file read/write operations MUST target paths inside this directory.
- NEVER write files to any path outside the workspace root.
- Do NOT use absolute paths discovered from bash command output (e.g., ls, find, pwd) as file write targets — always derive paths relative to the workspace root.
- If a shell command reveals a path on a different drive or directory than the workspace, DO NOT write files there.`
          : "";

        const hasShell = filteredToolDefs.some(t => t.name === "run_command" || t.name === "bash" || t.name === "run_background_process");
        const hasWrite = filteredToolDefs.some(t => t.name === "write_to_file" || t.name === "edit" || t.name === "replace_file_content" || t.name === "multi_replace_file_content" || t.name === "write" || t.name === "apply_patch");
        const hasNetwork = filteredToolDefs.some(t => t.name === "web_search" || t.name === "fetch_url");
        const hasSubagents = filteredToolDefs.some(t => t.name === "invoke_subagent" || t.name === "invoke_superagent");

        let verificationStatus = "blocked";
        if (hasShell) {
          verificationStatus = "runtime";
        } else if (hasWrite) {
          verificationStatus = "static-only";
        }

        let activeShellType = "unix-default";
        let shellSep = "&&";
        if (process.platform === "win32") {
          try {
            const { resolveWindowsShell } = await import("./tools/helpers.js");
            const shellInfo = resolveWindowsShell();
            activeShellType = shellInfo.isBash ? "git-bash" : "powershell";
            shellSep = shellInfo.isBash ? "&&" : ";";
          } catch {
            activeShellType = "powershell";
            shellSep = ";";
          }
        }

        const runtimeCapabilitiesText = `
# RUNTIME CAPABILITIES (do NOT assume or hardcode, reference these exactly)
- Shell: ${hasShell ? "enabled" : "disabled"}
- Write: ${hasWrite ? "enabled" : "disabled"}
- Network: ${hasNetwork ? "enabled" : "disabled"}
- Subagents: ${hasSubagents ? "enabled" : "disabled"}
- Verification: ${verificationStatus}
- Windows Shell Platform: ${activeShellType}
- Command Separator Syntax: ${shellSep}
`;

        const category = this.currentClassification?.category || "complex_task";
        const lastUserMessage = messages.slice().reverse().find(m => m.role === "user");
        const userInputText = lastUserMessage ? (typeof lastUserMessage.content === "string" ? lastUserMessage.content : "") : "";
        const lowerInput = userInputText.toLowerCase();

        let activeMode = "implement"; // default
        if (category === "conversation" || category === "question") {
          activeMode = "ask";
        } else if (category === "research") {
          activeMode = "research";
        } else if (category === "debug") {
          activeMode = "debug";
        } else if (category === "complex_task") {
          if (/plan|design|architecture/i.test(lowerInput)) {
            activeMode = "plan";
          } else {
            activeMode = "implement";
          }
        } else if (category === "simple_edit" || category === "command") {
          activeMode = "implement";
        }

        // Check for review intent explicitly
        if (/review|audit|diff\b/i.test(lowerInput)) {
          activeMode = "review";
        }

        const activeModeNotice = `
# CURRENT ACTIVE INTENT MODE: '${activeMode}'
Follow these instructions for '${activeMode}' mode:
${activeMode === "ask" ? `- You are in lightweight Q&A/concept explanation mode. Do NOT create any plan file or task list file. Do NOT spawn subagents. Do NOT call get_skills() or use_skill(). Do NOT run build, test, lint, or typecheck commands. Respond immediately and concisely.` : ""}
${activeMode === "research" ? `- You are in read-only research/exploration mode. Do NOT modify any files. Do NOT run build, test, lint, or typecheck commands. Set final status to static-only.` : ""}
${activeMode === "plan" ? `- Propose an implementation plan using 'manage_plan'. Do NOT edit source files before user approval. Minta approval secara eksplisit.` : ""}
${activeMode === "implement" ? `- Implement code changes. Proposing a plan is mandatory only for multi-file/complex/risky changes. Small direct edits are allowed. Run build and tests if shell is available; if shell is disabled, report Build/Test as 'not-run' with reason 'shell disabled', and set status to 'static-only'.` : ""}
${activeMode === "debug" ? `- Investigate and fix bugs. Trace root cause first before editing. Run build and tests if shell is available; if shell is disabled, report Build/Test as 'not-run' with reason 'shell disabled', and set status to 'static-only'.` : ""}
${activeMode === "review" ? `- Perform code quality or security review. Do NOT make file edits unless requested. Output issues with severity ([CRITICAL], [IMPORTANT], [MINOR]), file/line references, and proposed fixes.` : ""}
`;

        let toolRestrictionNotice = "";
        if (!hasShell) {
          toolRestrictionNotice = `\n\n⚠️ CRITICAL RESTRICTION: Terminal/shell command execution is currently DISABLED for this request. Do NOT attempt to use 'run_command', 'run_background_process', 'bash', or any terminal/shell execution tools, as they are not available in your tool schema.`;
        }

        const systemPrompt = `${activeSystemPrompt}${toolRestrictionNotice}${runtimeCapabilitiesText}${activeModeNotice}

CRITICAL TASK EXECUTION CONTEXT:
- Do NOT repeat, echo, or quote any content wrapped in <system_context_do_not_echo_or_repeat> tags. Treat them as background instruction states only.
- You are running with a strict step limit of ${maxIterationsStr} agent iterations per request.
- Be highly efficient. DO NOT try to do everything in a single sequential thread.
- Spawn subagents in parallel ONLY when the task meets subagent threshold rules (spans >3 files, >2 domains, major refactor/architecture, broad audit/research, or independent parallel work).
- Spawn subagents in parallel whenever tasks are independent.
- After spawning, wait for results, integrate them, and report back to the user.
${singleModeSubagentDirective}${goalModeAddendum}${guidelinesText}${processNotice}${pinnedKnowledgeNotice}${devHookNotice}${sharedMemoryNotice}`;

        // Build dynamic context to inject into messages array
        const stepsRemaining = maxIterations === Infinity ? Infinity : (maxIterations - currentStep);
        const stepNotice = stepsRemaining <= 5
          ? `\n- Current Step: ${currentStep} of ${maxIterationsStr} (WARNING: Only ${stepsRemaining} steps remaining!)`
          : "";
        const modelInstance = this.getModel();
        const modelName = modelInstance ? modelInstance.modelId : "";
        const supportsVision = this.modelSupportsVision(modelName);
        const settings = getSettings();
        const useVisionTokenSaving = supportsVision && (settings.autoVisionTokenSaving ?? true) && (this.detectedPayloadLimitBytes === undefined || this.detectedPayloadLimitBytes >= 500 * 1024);
        // Inform the conversation so stripOldToolResults retains more cycles
        // when vision is active — buildMessages() will image-convert large results.
        this.conversation.setVisionMode(useVisionTokenSaving);
        const threshold = getDynamicVisionThreshold(modelName);
        const visionMode = settings.visionMode ?? 1;

        // ── Live Workspace State block ─────────────────────────────────────────
        let workspaceStateText = "";
        if (this.tier !== "subagent") {
          try {
            const { buildWorkspaceStateBlock } = await import("./context/WorkspaceStateTracker.js");
            const { subagentInstances: saInstances } = await import("./tools/state.js");
            const subagentSummary = Array.from(saInstances.entries()).map(([id, inst]) => ({
              id,
              role: inst.role,
              typeName: inst.typeName,
              status: inst.status,
            }));
            const wsBlock = buildWorkspaceStateBlock({
              taskFilePath: this.getTaskFilePath(),
              planFilePath: this.getPlanFilePath(),
              cwd: this.workingDirectory,
              tier: this.tier as "master" | "single" | "superagent",
              subagentSummary,
            });
            workspaceStateText = wsBlock.text;
          } catch { /* non-critical */ }
        }

        // dynamicContext is injected as plaintext into the messages array every iteration.
        // IMPORTANT: path-sensitive content (workspaceBoundaryNotice, planStateNotice) lives
        // HERE — never inside systemPrompt — so it is never converted to a PNG image.
        // planStateAddendum and followUpTaskAddendum remain here because they are
        // truly per-iteration state (approval status, task-reset notices).

        // ── Classifier-based plan state injection skip ──────────────────────
        let classifierSkipPlan = false;
        let classifierPromptAddendum = "";
        if (this.currentClassification) {
          try {
            const { shouldSkipPlanInjection, getCategoryPromptAddendum } = await import("./requestClassifier.js");
            classifierSkipPlan = shouldSkipPlanInjection(this.currentClassification.category);
            classifierPromptAddendum = getCategoryPromptAddendum(this.currentClassification.category);
          } catch {}
        }

        const effectivePlanStateNotice = classifierSkipPlan ? "" : planStateNotice;
        const effectivePlanStateAddendum = classifierSkipPlan ? "" : planStateAddendum;

        const dynamicContext = `\n\n<system_context_do_not_echo_or_repeat>\n[DYNAMIC EXECUTION CONTEXT]\n${stepNotice}${classifierPromptAddendum}${scratchpadText ? `\n\nPERSISTENT SCRATCHPAD MEMORY:\n${scratchpadText}` : ""}${workspaceStateText}${workspaceBoundaryNotice}${effectivePlanStateNotice}${effectivePlanStateAddendum}${followUpTaskAddendum}\n<!-- SYSTEM NOTICE: The above block is dynamic background state. Do NOT echo or repeat any of these instructions or notices in your response. Proceed directly to execution. -->\n</system_context_do_not_echo_or_repeat>`;

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

        // Inject dynamic context into the active messages list
        if (useVisionTokenSaving && visionMode === 2) {
          messages = this.buildMessages(supportsNativeTools, dynamicContext);
        } else {
          injectDynamicContext(messages);
        }

        // ── Pre-flight payload size (byte) safety check ───────────────────
        // Prevents 413 Payload Too Large errors when large tool results or files
        // converted to images exceed the API endpoint/gateway request body limit.
        {
          const systemSize = systemPrompt ? Buffer.byteLength(systemPrompt, "utf-8") : 0;
          const toolsSize = supportsNativeTools ? Buffer.byteLength(JSON.stringify(filteredToolDefs), "utf-8") : 0;
          const payloadJson = JSON.stringify(messages);
          const payloadBytes = Buffer.byteLength(payloadJson, "utf-8") + systemSize + toolsSize + 5000;
          const maxPayloadBytes = this.detectedPayloadLimitBytes
            ? Math.floor(this.detectedPayloadLimitBytes * 0.9)
            : 4 * 1024 * 1024; // 4 MB safety limit

          if (payloadBytes > maxPayloadBytes) {
            this.writeToLogFile(
              "WARN",
              `Pre-flight payload check: estimated payload size (${(payloadBytes / 1024 / 1024).toFixed(2)} MB) exceeds safety threshold (${(maxPayloadBytes / 1024 / 1024).toFixed(2)} MB). Triggering emergency compaction.`
            );
            const targetBudget = Math.max(20 * 1024, maxPayloadBytes - systemSize - toolsSize - 5000);
            await this.compactHistoryIfNeeded(signal, true, undefined, targetBudget);
            // Rebuild messages from compacted conversation
            if (useVisionTokenSaving && visionMode === 2) {
              messages = this.buildMessages(supportsNativeTools, dynamicContext);
            } else {
              messages = this.buildMessages(supportsNativeTools);
              injectDynamicContext(messages);
            }
          }
        }

        // ── Pre-flight context window safety check ──────────────────────────
        // Prevents 400 errors when total request (system + messages + tool schemas)
        // exceeds the model's context window limit. This catches edge cases where
        // token estimation differs from the provider's actual counting.
        {
          const modelLimit = getContextWindowLimit(this.config.model);
          const isAnthropic = this.config.provider === "anthropic" || (typeof this.config.provider === "string" && this.config.provider.includes("anthropic"));
          // Conservative safety margin: 85% of model limit for Anthropic/Claude (which matches cl100k_base tokenizer),
          // 70% for other providers to leave headroom for tokenizer differences (e.g. DeepSeek).
          const safetyMax = Math.floor(modelLimit * (isAnthropic ? 0.85 : 0.70));
          
          let estSysTokens = 0;
          let estMsgTokens = 0;
          let estTotal = 0;

          const ctxMgr = this.conversation.getContextManager();
          if (ctxMgr) {
            const tracker = ctxMgr.getTokenTracker();
            const breakdown = tracker.getBreakdown(this.conversation.getMessages(), systemPrompt);
            const dynamicContextTokens = tracker.estimateTokens({
              role: "user",
              content: dynamicContext,
              timestamp: Date.now(),
            });
            estTotal = breakdown.total + dynamicContextTokens;
            estSysTokens = breakdown.systemPrompt;
            estMsgTokens = estTotal - estSysTokens;
          } else {
            // Fallback: estimate system prompt tokens (conservative ~3 chars/token for code-heavy text)
            estSysTokens = Math.ceil(systemPrompt.length / 3);
            estMsgTokens = this.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
            estTotal = estMsgTokens + estSysTokens;
          }

          if (estTotal > safetyMax) {
            const overshootPct = Math.round((estTotal / modelLimit) * 100);
            this.writeToLogFile("WARN", `Pre-flight context check: estimated ~${estTotal.toLocaleString()} total tokens (${overshootPct}% of ${modelLimit.toLocaleString()} limit). Compact threshold: ${safetyMax.toLocaleString()}. Triggering emergency compaction.`);
            const dynamicContextTokens = ctxMgr ? ctxMgr.getTokenTracker().estimateTokens({
              role: "user",
              content: dynamicContext,
              timestamp: Date.now(),
            }) : Math.ceil(dynamicContext.length / 3);
            const targetHistoryBudget = Math.max(1000, safetyMax - estSysTokens - dynamicContextTokens);
            await this.compactHistoryIfNeeded(signal, false, targetHistoryBudget);
            // Rebuild messages from compacted conversation
            if (useVisionTokenSaving && visionMode === 2) {
              messages = this.buildMessages(supportsNativeTools, dynamicContext);
            } else {
              messages = this.buildMessages(supportsNativeTools);
              injectDynamicContext(messages);
            }
            const afterEstMsgTokens = this.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
            const afterEstTotal = afterEstMsgTokens + estSysTokens;
            this.writeToLogFile("INFO", `Post-compaction estimated total: ~${afterEstTotal.toLocaleString()} tokens.`);
            // If still over safety limit after compaction, log a critical warning
            if (afterEstTotal > safetyMax) {
              this.writeToLogFile("ERROR", `Post-compaction total ${afterEstTotal.toLocaleString()} still exceeds safety limit ${safetyMax.toLocaleString()}. Proceeding with risk of provider rejection.`);
            }
          }
        }

        let finalSystemPrompt = systemPrompt;
        if (!supportsNativeTools) {
          try {
            const { buildToolsSystemPromptBlock } = await import("../utils/promptBasedToolCalling.js");
            const toolDefsForPrompt = filteredToolDefs.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.input_schema as any,
            }));
            finalSystemPrompt += buildToolsSystemPromptBlock(toolDefsForPrompt);
            this.writeToLogFile("INFO", `Prompt-based tool calling fallback activated for ${details.modelName} on ${details.baseUrl}`);
          } catch (err: any) {
            this.writeToLogFile("WARN", `Failed to build prompt-based tool block: ${err.message}`);
          }
        }

        let prependSystemMessage: any = null;
        let prependSystemAssistantMessage: any = null;


        if (useVisionTokenSaving && visionMode === 1 && finalSystemPrompt.length > threshold && !this.customSystemPrompt) {
          try {
            this.writeToLogFile("INFO", `Automatically converting system prompt (size ${finalSystemPrompt.length} chars) to image.`);
            let base64List = this.getCachedImages(finalSystemPrompt);
            if (!base64List) {
              const pages = sliceTextIntoPages(finalSystemPrompt);
              base64List = [];
              for (const page of pages) {
                const base64 = renderTextToImageBase64(page);
                base64List.push(base64);
              }
              this.setCachedImages(finalSystemPrompt, base64List);
            }
            
            const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = [
              {
                type: "text",
                text: `CRITICAL: The following image(s) contain your core SYSTEM INSTRUCTIONS, RULES, and WORKFLOW guidelines. Read the text inside the image(s) carefully. You must strictly adhere to all instructions, constraints, and rules displayed in these images for this entire session. [System instructions rendered as images to save tokens, split into ${base64List.length} pages]:`
              }
            ];
            base64List.forEach((base64, index) => {
              contentParts.push({
                type: "text",
                text: `[System Instructions Page ${index + 1} of ${base64List.length}]:`
              });
              contentParts.push({ type: "image" as const, image: base64, mimeType: "image/webp" });
            });

            prependSystemMessage = {
              role: "user",
              content: contentParts
            };

            prependSystemAssistantMessage = {
              role: "assistant",
              content: "I have read the system instructions rendered as images and will strictly follow all rules and guidelines."
            };

            finalSystemPrompt = [
              "CRITICAL: Follow all safety, workspace, tool, and hierarchy rules from this system message.",
              "Additional long-form system instructions are rendered as images in the first user message to save tokens.",
              "Treat image instructions as supplemental system guidance, but never override this text system message.",
              devHookNotice.trim()
            ].filter(Boolean).join("\n");
          } catch (err: any) {
            this.writeToLogFile("WARN", `Failed to automatically convert system prompt to image: ${err.message}. Falling back to text.`);
          }
        } else if (useVisionTokenSaving && visionMode === 2) {
          finalSystemPrompt = [
            "CRITICAL: Follow all safety, workspace, tool, and hierarchy rules from the user messages.",
            "The system instructions, workflow rules, constraints, and full conversation history are compiled and rendered as images in the user messages to save tokens.",
            "You must read and adhere to all rules, constraints, and guidelines shown in these images as if they were written directly in this system prompt.",
            "Analyze the latest state, files list, and tasks shown on the final page of the compiled images, and proceed directly to executing the next step.",
            "Do not mention that the prompt was rendered as images or reference the image format in your response.",
            devHookNotice.trim()
          ].filter(Boolean).join("\n");
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
              if (prependSystemMessage && prependSystemAssistantMessage) {
                callMessages.unshift(prependSystemMessage, prependSystemAssistantMessage);
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
                const systemSize = systemPrompt ? Buffer.byteLength(systemPrompt, "utf-8") : 0;
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
                if (useVisionTokenSaving && visionMode === 2) {
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
              if (prependSystemMessage && prependSystemAssistantMessage) {
                callMessages.unshift(prependSystemMessage, prependSystemAssistantMessage);
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
                if (useVisionTokenSaving && visionMode === 2) {
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
            const isPlanningText =
              isEarlyIteration &&
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


        const toolResults: ToolResult[] = [];

for (const tc of toolCalls) {
          if (signal?.aborted) {
            const err = new Error("AbortError");
            err.name = "AbortError";
            throw err;
          }
          const description = getToolDescription(tc);
          this.onEvent({ type: "tool_start", toolCall: tc, description });

          if (tc.name === "ask_question") {
            if (Array.isArray(tc.args.questions) && tc.args.questions.length > 0) {
              const normalizedQuestions: QuestionItem[] = tc.args.questions.map((q: any) => {
                const qObj = q as Record<string, any>;
                const qOpts = Array.isArray(qObj.options) ? qObj.options.map((o: any) => {
                  if (typeof o === "string") return o;
                  if (o && typeof o === "object") {
                    const label = o["label"] ?? o["name"] ?? o["command"] ?? o["title"] ?? o["value"];
                    if (label !== undefined) return String(label);
                    return JSON.stringify(o);
                  }
                  return String(o);
                }) : [];
                return {
                  question: String(qObj.question || ""),
                  options: qOpts,
                  isMultiSelect: !!(qObj.is_multi_select ?? qObj.isMultiSelect),
                };
              });

              if (normalizedQuestions.length === 1) {
                try {
                  const q = normalizedQuestions[0];
                  const selected = await this.onQuestion(q.question, q.options, q.isMultiSelect);
                  const toolResult: ToolResult = {
                    toolCallId: tc.id,
                    name: tc.name,
                    result: `User selected option: "${selected}"`,
                  };
                  toolResults.push(toolResult);
                  this.onEvent({ type: "tool_end", toolResult, description });
                  continue;
                } catch (err: any) {
                  const toolResult: ToolResult = {
                    toolCallId: tc.id,
                    name: tc.name,
                    result: `Error getting user answer: ${err.message}`,
                    isError: true,
                  };
                  toolResults.push(toolResult);
                  this.onEvent({ type: "tool_end", toolResult, description });
                  continue;
                }
              }

              try {
                const selected = await this.onQuestion(normalizedQuestions);
                const toolResult: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: `User selected options: ${JSON.stringify(selected)}`,
                };
                toolResults.push(toolResult);
                this.onEvent({ type: "tool_end", toolResult, description });
                continue;
              } catch (err: any) {
                const toolResult: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: `Error getting user answers: ${err.message}`,
                  isError: true,
                };
                toolResults.push(toolResult);
                this.onEvent({ type: "tool_end", toolResult, description });
                continue;
              }
            }

            let question = tc.args.question as string || "";
            let rawOptionsVal = tc.args.options;
            let isMultiSelect = tc.args.isMultiSelect as boolean | undefined;

            const rawOptions = Array.isArray(rawOptionsVal)
              ? rawOptionsVal
              : (rawOptionsVal !== undefined && rawOptionsVal !== null ? [rawOptionsVal] : []);
            const options: string[] = rawOptions.map((o) => {
              if (typeof o === "string") return o;
              if (o && typeof o === "object") {
                const obj = o as Record<string, unknown>;
                const label = obj["label"] ?? obj["name"] ?? obj["command"] ?? obj["title"] ?? obj["value"];
                if (label !== undefined) return String(label);
                return JSON.stringify(o);
              }
              return String(o);
            });
            try {
              const selected = await this.onQuestion(question, options, isMultiSelect);
              const toolResult: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `User selected option: "${selected}"`,
              };
              toolResults.push(toolResult);
              this.onEvent({ type: "tool_end", toolResult, description });
              continue;
            } catch (err: any) {
              const toolResult: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `Error getting user answer: ${err.message}`,
                isError: true,
              };
              toolResults.push(toolResult);
              this.onEvent({ type: "tool_end", toolResult, description });
              continue;
            }
          }

          if (tc.name === "invoke_superagent" || tc.name === "merge_superagents") {
            if (this.planState !== "APPROVED") {
              let msg = "";
              if (this.planState === "PLANNING_PENDING") {
                msg = `Error: Spawning or merging Superagents is blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before starting execution.`;
              } else {
                msg = `Error: Spawning or merging Superagents is blocked. You must first write an implementation plan to '${this.getPlanFilePath()}' and have the user approve it before you can invoke any Superagents.`;
              }
              const blocked: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: msg,
                isError: true,
              };
              toolResults.push(blocked);
              this.onEvent({ type: "tool_end", toolResult: blocked, description });
              continue;
            }

            const taskFilePath = this.getTaskFilePath();
            if (!fs.existsSync(taskFilePath)) {
              // ── Auto-create _task.md instead of blocking ─────────────────
              // Missing task file should NEVER prevent spawning. Create from plan
              // content if available, or a minimal placeholder.
              let taskContent = "# Tasks\n\n- [ ] Execute implementation plan\n";
              try {
                const planPath = this.getPlanFilePath();
                if (fs.existsSync(planPath)) {
                  const planContent = fs.readFileSync(planPath, "utf-8");
                  const taskLines: string[] = [];
                  for (const line of planContent.split(/\r?\n/)) {
                    const match = line.match(/^\s*-\s*`?\[([xX/ ])\]`?\s*(.*)$/);
                    if (match) {
                      taskLines.push(`- [${match[1]}] ${match[2].trim()}`);
                    }
                  }
                  if (taskLines.length > 0) {
                    taskContent = taskLines.join("\n") + "\n";
                  }
                }
              } catch {
                // Fallback: use minimal placeholder
              }

              try {
                fs.mkdirSync(path.dirname(taskFilePath), { recursive: true });
                fs.writeFileSync(taskFilePath, taskContent, "utf-8");
                this.writeToLogFile("INFO", `Auto-created missing task file at ${taskFilePath} — proceeding with spawn/merge.`);
              } catch (createErr: any) {
                // If even auto-create fails, warn but don't block
                this.writeToLogFile("WARN", `Failed to auto-create task file: ${createErr.message} — proceeding anyway.`);
              }
            }
          }

          if (MODIFYING_TOOLS.includes(tc.name)) {
            const filePath = tc.args.filePath as string || tc.args.file_path as string || tc.args.TargetFile as string || "";
            const planFilePath = this.getPlanFilePath();
            const taskFilePath = this.getTaskFilePath();
            const walkthroughFilePath = this.getWalkthroughFilePath();
            const isPlanFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(planFilePath).toLowerCase();
            const isTaskFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(taskFilePath).toLowerCase();
            const isWalkthroughFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(walkthroughFilePath).toLowerCase();

            if (this.isSimpleTask && !this.simpleTaskApproved && !isPlanFile && !isTaskFile && !isWalkthroughFile) {
              const filename = path.basename(filePath);
              try {
                const selected = await this.onQuestion(
                  `Agent is about to modify ${filename}. Proceed with modifications?`,
                  ["Yes", "No"]
                );
                if (selected === "Yes") {
                  this.simpleTaskApproved = true;
                } else {
                  const blocked: ToolResult = {
                    toolCallId: tc.id,
                    name: tc.name,
                    result: `Error: User rejected modification of ${filename}.`,
                    isError: true,
                  };
                  toolResults.push(blocked);
                  this.onEvent({ type: "tool_end", toolResult: blocked, description });
                  continue;
                }
              } catch (err: any) {
                const blocked: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: `Error: Modification confirmation failed: ${err.message}`,
                  isError: true,
                };
                toolResults.push(blocked);
                this.onEvent({ type: "tool_end", toolResult: blocked, description });
                continue;
              }
            }

            if (this.tier === "master" && !isPlanFile && !isTaskFile && !isWalkthroughFile) {
              if (this.isSimpleTask) {
                // Bypass the Master Agent direct file modification block
              } else {
                const blocked: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: "Error: The Master Agent is restricted from directly modifying source code files in the codebase. You must delegate all code modifications to Superagents by invoking them.",
                  isError: true,
                };
                try {
                  const { appendToolsErrorLog } = await import("./tools/state.js");
                  appendToolsErrorLog(this.tier, this.delegationDepth, tc.name, blocked.result, { filePath, reason: "master_direct_modify_blocked" });
                } catch {}
                this.emitViolation("master_direct_modify_blocked", tc.name, "Master Agent attempted to directly modify source code files. Must delegate to Superagents.", "critical", { filePath });
                toolResults.push(blocked);
                this.onEvent({ type: "tool_end", toolResult: blocked, description });
                continue;
              }
            }

            if (isPlanFile) {
              let planContent = "";
              if (tc.name === "write" || tc.name === "write_to_file") {
                planContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
              } else if (tc.name === "replace_file_content") {
                const target = tc.args.TargetContent as string || "";
                const replacement = tc.args.ReplacementContent as string || "";
                const existing = fs.existsSync(planFilePath) ? fs.readFileSync(planFilePath, "utf8") : "";
                planContent = existing.replace(target, replacement);
              } else if (tc.name === "multi_replace_file_content") {
                let existing = fs.existsSync(planFilePath) ? fs.readFileSync(planFilePath, "utf8") : "";
                const chunksVal = tc.args.ReplacementChunks;
                const chunks = Array.isArray(chunksVal)
                  ? chunksVal
                  : (chunksVal !== undefined && chunksVal !== null ? [chunksVal] : []);
                for (const chunk of chunks) {
                  const target = chunk.TargetContent as string || "";
                  const replacement = chunk.ReplacementContent as string || "";
                  existing = existing.replace(target, replacement);
                }
                planContent = existing;
              } else {
                planContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
              }

              if (this.tier === "master") {
                const hasSuperagentOrDelegate = /superagent|spawning|delegate|worktree/i.test(planContent);
                if (!hasSuperagentOrDelegate) {
                  // Auto-inject delegation context instead of rejecting
                  planContent = planContent + "\n\n> **Note**: This plan will be executed by spawning Superagents in isolated git worktrees for parallel feature development.";
                  // Update tool call args with enhanced content
                  if (tc.args.planContent !== undefined) {
                    tc.args.planContent = planContent;
                  } else if (tc.args.content !== undefined) {
                    tc.args.content = planContent;
                  }
                  console.log("[INFO] Auto-injected delegation context into implementation plan");
                }
              }

              if (this.goalMode) {
                this.planState = "APPROVED";
                this.onEvent({ type: "text", content: "\n[SYS] Goal Mode active: Auto-approving implementation plan for autonomous execution.\n" });
              } else if (this.planState !== "APPROVED") {
                this.planState = "PLANNING_PENDING";
              }
            }

            if (isTaskFile) {
              let taskContent = "";
              if (tc.name === "write" || tc.name === "write_to_file") {
                taskContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
              } else if (tc.name === "replace_file_content") {
                const target = tc.args.TargetContent as string || "";
                const replacement = tc.args.ReplacementContent as string || "";
                const existing = fs.existsSync(taskFilePath) ? fs.readFileSync(taskFilePath, "utf8") : "";
                taskContent = existing.replace(target, replacement);
              } else if (tc.name === "multi_replace_file_content") {
                let existing = fs.existsSync(taskFilePath) ? fs.readFileSync(taskFilePath, "utf8") : "";
                const chunksVal = tc.args.ReplacementChunks;
                const chunks = Array.isArray(chunksVal)
                  ? chunksVal
                  : (chunksVal !== undefined && chunksVal !== null ? [chunksVal] : []);
                for (const chunk of chunks) {
                  const target = chunk.TargetContent as string || "";
                  const replacement = chunk.ReplacementContent as string || "";
                  existing = existing.replace(target, replacement);
                }
                taskContent = existing;
              } else {
                taskContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
              }

              if (this.tier === "master") {
                // Auto-inject missing Master Agent tasks instead of blocking
                const lines = taskContent.split(/\r?\n/);
                const taskLines: string[] = [];
                const otherLines: string[] = [];

                for (const line of lines) {
                  if (/^\s*-\s*`?\[([xX/ ])\]`?\s*/.test(line)) {
                    taskLines.push(line);
                  } else {
                    otherLines.push(line);
                  }
                }

                const combinedTaskText = taskLines.join("\n").toLowerCase();
                const hasSpawn = /spawn|invoke|create.*superagent|start.*superagent/i.test(combinedTaskText);
                const hasMonitor = /monitor|await|wait|track|check.*status/i.test(combinedTaskText);
                const hasMerge = /merge|combine|integrate.*superagent/i.test(combinedTaskText);

                const injectedTasks: string[] = [];
                if (!hasSpawn) {
                  injectedTasks.push("- [ ] Spawn Superagents for parallel task execution");
                }
                if (!hasMonitor) {
                  injectedTasks.push("- [ ] Monitor Superagent progress and await completion");
                }
                if (!hasMerge) {
                  injectedTasks.push("- [ ] Merge Superagent branches into main codebase");
                }

                if (injectedTasks.length > 0) {
                  // Find the last task line and append after it
                  const lastTaskIndex = lines.length - 1 - [...lines].reverse().findIndex(l => /^\s*-\s*`?\[([xX/ ])\]`?\s*/.test(l));
                  lines.splice(lastTaskIndex + 1, 0, ...injectedTasks);
                  taskContent = lines.join("\n");
                  // Update the tool call args so the actual write uses the injected content
                  if (tc.args.content !== undefined) {
                    tc.args.content = taskContent;
                  } else if (tc.args.codeContent !== undefined) {
                    tc.args.codeContent = taskContent;
                  } else if (tc.args.CodeContent !== undefined) {
                    tc.args.CodeContent = taskContent;
                  }
                  console.log(`[INFO] Auto-injected ${injectedTasks.length} missing Master Agent task(s) into task file`);
                }
              }
            }

            if (!isPlanFile && this.planState === "PLANNING_PENDING") {
              const blocked: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: "Error: File modification blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before modifying any codebase files.",
                isError: true,
              };
              try {
                const { appendToolsErrorLog } = await import("./tools/state.js");
                appendToolsErrorLog(this.tier, this.delegationDepth, tc.name, blocked.result, { filePath, reason: "planning_pending" });
              } catch {}
              this.emitViolation("planning_pending", tc.name, "File modification blocked while plan is pending approval.", "warning", { filePath });
              toolResults.push(blocked);
              this.onEvent({ type: "tool_end", toolResult: blocked, description });
              continue;
            }
          }

          if (
            tc.name === "bash" || tc.name === "run_command" || tc.name === "run_background_process"
          ) {
            if (this.planState === "PLANNING_PENDING") {
              const cmd = (tc.args.command as string || "").trim();
              const isModifyingCommand = /([>\u226B\u00BB]|\b(rm|rmdir|mkdir|cp|mv|touch|git\s+(checkout|apply|reset|clean|merge|rebase|commit|add|push|pull)|npm\s+(install|i|uninstall|update|add)|yarn\s+(add|remove|upgrade|install)|pnpm\s+(add|remove|update|install|i))\b)/i.test(cmd);
              if (isModifyingCommand) {
                const blocked: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: `Error: Terminal command blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before running commands that modify the codebase or repository state. Command blocked: "${cmd}"`,
                  isError: true,
                };
                try {
                  const { appendToolsErrorLog } = await import("./tools/state.js");
                  appendToolsErrorLog(this.tier, this.delegationDepth, tc.name, blocked.result, { command: cmd, reason: "planning_pending_command" });
                } catch {}
                this.emitViolation("planning_pending_command", tc.name, `Modifying terminal command blocked while plan is pending approval: "${cmd}"`, "warning", { command: cmd });
                toolResults.push(blocked);
                this.onEvent({ type: "tool_end", toolResult: blocked, description });
                continue;
              }
            }

            if (isDangerousCommand(tc.args.command as string) && !this.allowSessionDangerous) {
              const approved = await this.onPermission(tc, description);
              if (approved === "session") {
                this.allowSessionDangerous = true;
              } else if (!approved) {
                const denied: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: "User denied permission for this command.",
                  isError: true,
                };
                try {
                  const { appendToolsErrorLog } = await import("./tools/state.js");
                  appendToolsErrorLog(this.tier, this.delegationDepth, tc.name, denied.result, { command: tc.args.command as string, reason: "user_permission_denied" });
                } catch {}
                this.emitViolation("user_permission_denied", tc.name, `Dangerous command denied by user/permission handler: "${tc.args.command as string}"`, "critical", { command: tc.args.command as string });
                toolResults.push(denied);
                this.onEvent({ type: "tool_end", toolResult: denied, description });
                continue;
              }
            }
          }

          // Out-of-bounds file or command access check for all agent tiers
          const effectiveWorkspace = this.worktreePath || this.workingDirectory;
          const isModelCfg = isModelConfigAccess(tc, effectiveWorkspace);
          const isEnvFile = !isModelCfg && isSensitiveEnvFileAccess(tc);
          // model-config.json always requires per-access permission (never bypassed by session flag)
          // .env* files require permission unless user already granted session access for env files
          // File write tools (write_to_file, replace_file_content, etc.) are NEVER granted
          // session-wide bypass — every out-of-bounds file write requires explicit approval.
          const isFileWriteTool = MODIFYING_TOOLS.includes(tc.name);
          const needsPermission = isModelCfg
            ? true
            : isEnvFile
            ? !this.allowSessionEnvAccess
            : isToolCallOutOfBounds(tc, effectiveWorkspace) &&
              (isFileWriteTool ? !this.allowSessionFileWriteOutOfBounds : !this.allowSessionOutOfBounds);
          if (needsPermission) {
            let details = "";
            if (tc.args) {
              const cmd = (tc.args.command ?? tc.args.cmd) as string | undefined;
              const targetPath = (tc.args.filePath ?? tc.args.file_path ?? tc.args.TargetFile ?? tc.args.path ?? tc.args.DirectoryPath ?? tc.args.SearchPath ?? tc.args.AbsolutePath) as string | undefined;
              const cwd = tc.args.cwd as string | undefined;
              const detailsParts: string[] = [];
              if (cmd) detailsParts.push(`Command: "${cmd}"`);
              if (targetPath) detailsParts.push(`Target Path: "${targetPath}"`);
              if (cwd) detailsParts.push(`CWD: "${cwd}"`);
              if (detailsParts.length > 0) {
                details = `\n  Details:\n    - ${detailsParts.join("\n    - ")}`;
              }
            }

            const permMessage = isModelCfg
              ? `⚠️  Protected file access detected: model-config.json contains your API keys and model presets. Tool "${tc.name}" is attempting to access this file. This requires your explicit permission.`
              : isEnvFile
              ? `⚠️  Sensitive file access detected: Tool "${tc.name}" is attempting to access a .env file which may contain API keys, database credentials, or other secrets. This requires your explicit permission.`
              : isFileWriteTool
              ? `⚠️  Out-of-bounds FILE WRITE detected: Tool "${tc.name}" is attempting to write a file OUTSIDE the workspace directory.${details}\n\n  ⚠️  WARNING: "Allow for This Session" for file writes grants permanent bypass for all future out-of-bounds writes this session.`
              : `Out-of-bounds access detected for tool: ${tc.name}. Requires permission to access files/directories/processes outside the workspace.${details}`;
            const approved = await this.onPermission(
              tc,
              permMessage
            );
            // model-config.json: "Allow for This Session" is not meaningful — treat it as a one-time allow
            // File write tools: "Allow for This Session" sets allowSessionFileWriteOutOfBounds (separate from shell bypass)
            if (!isModelCfg && !isEnvFile && isFileWriteTool && approved === "session") {
              this.allowSessionFileWriteOutOfBounds = true;
            } else if (!isModelCfg && !isEnvFile && !isFileWriteTool && approved === "session") {
              this.allowSessionOutOfBounds = true;
            } else if (!isModelCfg && isEnvFile && approved === "session") {
              this.allowSessionEnvAccess = true;
            } else if (!approved) {
              const blocked: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `Error: Access denied. Permission denied to access files/directories/processes outside the workspace directory: ${effectiveWorkspace}`,
                isError: true,
              };
              try {
                const { appendToolsErrorLog } = await import("./tools/state.js");
                appendToolsErrorLog(this.tier, this.delegationDepth, tc.name, blocked.result, { workspace: effectiveWorkspace, reason: "out_of_bounds_denied" });
              } catch {}
              this.emitViolation("out_of_bounds_denied", tc.name, `Access outside workspace denied by user/permission handler.`, "critical", { workspace: effectiveWorkspace });
              toolResults.push(blocked);
              this.onEvent({ type: "tool_end", toolResult: blocked, description });
              continue;
            }
          }

          // Use worktreePath as CWD for superagents, otherwise use configured workingDirectory
          const effectiveCwd = (this.tier === "superagent" && this.worktreePath)
            ? this.worktreePath
            : this.workingDirectory;

          // Auto-checkpoint before destructive operations (with cooldown)
          if (MODIFYING_TOOLS.includes(tc.name)) {
            this.autoCheckpoint(`Pre-${tc.name}`);
          }

          const toolResult = await executeToolCall(
            tc,
            effectiveCwd,
            signal
          );
          if (signal?.aborted) {
            const err = new Error("AbortError");
            err.name = "AbortError";
            throw err;
          }
          toolResults.push(toolResult);
          this.onEvent({ type: "tool_end", toolResult, description, toolCall: tc });
        }

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
            finalSummary = await this.summarizeMessages(sessionMsgs, signal);
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

  private modelSupportsVision(modelName: string): boolean {
    if (!modelName) return false;

    // Check configuration first
    try {
      const mode = (this.isMultiAgent && !process.env.SINGLE_AGENT_MODE) ? "multi" : "single";
      const tierConfig = getTierModelConfig(mode, this.subagentType || this.tier);
      if (tierConfig && tierConfig.supportsVision !== undefined) {
        return tierConfig.supportsVision;
      }
    } catch (e) {
      // Fallback to name check
    }

    const name = modelName.toLowerCase();
    
    // Known vision-supporting models
    if (name.includes("claude-3")) return true;
    if (name.includes("gpt-4o")) return true;
    if (name.includes("gpt-4-vision")) return true;
    if (name.includes("gemini")) return true;
    if (name.includes("gemma-3")) return true;
    if (name.includes("vision")) return true;
    
    return false;
  }

  private buildMessages(supportsNativeTools = true, dynamicContext?: string): CoreMessage[] {
    const coreMessages: CoreMessage[] = [];

    let modelName = "";
    let supportsVision = true;
    try {
      const mode = (this.isMultiAgent && !process.env.SINGLE_AGENT_MODE) ? "multi" : "single";
      modelName = getTierModel(mode, this.subagentType || this.tier);
      supportsVision = this.modelSupportsVision(modelName);
    } catch (e) {
      // Default to true to keep original behavior if model config loading/resolution fails
    }

    const settings = getSettings();
    const useVisionTokenSaving = supportsVision && (settings.autoVisionTokenSaving ?? true) && (this.detectedPayloadLimitBytes === undefined || this.detectedPayloadLimitBytes >= 500 * 1024);
    const threshold = getDynamicVisionThreshold(modelName);
    const visionMode = settings.visionMode ?? 1;

    if (useVisionTokenSaving && visionMode === 2) {
      // MODE 2: Compile all messages into a single text block, clean up, render to images, and append.
      let compiledText = "";
      for (const m of this.conversation.getMessages()) {
        if (m.role === "system") continue;
        if (m.role === "user") {
          const rawContent = typeof m.content === "string" ? m.content : contentToString(m.content);
          compiledText += `\n=== USER MESSAGE ===\n${rawContent}\n`;
        } else if (m.role === "assistant") {
          const rawContent = typeof m.content === "string" ? m.content : contentToString(m.content);
          compiledText += `\n=== ASSISTANT MESSAGE ===\n${rawContent}\n`;
          if (m.toolCalls && m.toolCalls.length > 0) {
            compiledText += `\n[Tool Calls]:\n` + m.toolCalls.map(tc => `- Call ID: ${tc.id}, Tool: ${tc.name}, Args: ${JSON.stringify(tc.args)}`).join("\n") + "\n";
          }
        } else if (m.role === "tool") {
          const results = m.toolResults || [];
          for (const tr of results) {
            const resStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
            compiledText += `\n=== TOOL RESULT: ${tr.name} (ID: ${tr.toolCallId}) ===\n${resStr}\n`;
          }
        }
      }

      // Include system prompt at top of compiled text in Mode 2
      const systemPrompt = this.config.systemPrompt || "";
      if (systemPrompt) {
        compiledText = `=== SYSTEM INSTRUCTIONS ===\n${systemPrompt}\n\n` + compiledText;
      }

      // Append dynamic execution context at the end of compiled text in Mode 2
      if (dynamicContext) {
        compiledText += `\n=== DYNAMIC EXECUTION CONTEXT ===\n${dynamicContext}\n`;
      }

      const cleanText = minifyTextForImage(compiledText);
      try {
        let base64List = this.getCachedImages(cleanText);
        if (!base64List) {
          const pages = sliceTextIntoPages(cleanText);
          base64List = [];
          for (const page of pages) {
            const base64 = renderTextToImageBase64(page);
            base64List.push(base64);
          }
          this.setCachedImages(cleanText, base64List);
        }

        const isAnthropic = modelName.toLowerCase().includes("anthropic");
        const maxModelImages = isAnthropic ? 20 : 100;
        const limitedBase64List = base64List.slice(0, maxModelImages);
        const limitedPages = limitedBase64List.length;

        const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = [
          {
            type: "text",
            text: `CRITICAL: The following image(s) contain the full compiled conversation history, system instructions, and dynamic execution context. Read the text inside the image(s) carefully to see all prior messages, inputs, and results. Proceed directly to the next step based on the latest state shown. [Prompt compiled & rendered as images to save tokens, split into ${limitedPages} pages]:`
          }
        ];
        limitedBase64List.forEach((base64, index) => {
          contentParts.push({
            type: "text",
            text: `[Compiled Prompt Page ${index + 1} of ${limitedPages}]:`
          });
          contentParts.push({ type: "image", image: base64, mimeType: "image/webp" });
        });

        coreMessages.push({
          role: "user",
          content: contentParts as any,
        });
      } catch (err: any) {
        this.writeToLogFile("WARN", `Failed to compile prompt to image: ${err.message}. Falling back to text.`);
        this.buildMode1Messages(coreMessages, threshold, useVisionTokenSaving, supportsVision, supportsNativeTools, modelName);
      }
    } else {
      this.buildMode1Messages(coreMessages, threshold, useVisionTokenSaving, supportsVision, supportsNativeTools, modelName);
    }

    // Cleanup / post-process to add cache annotations
    this.addCacheControlToMessages(coreMessages);

    return coreMessages;
  }

  private addCacheControlToMessages(coreMessages: CoreMessage[]): void {
    try {
      const modelInstance = this.getModel();
      const isTest = !!process.env.VITEST;
      const isAnthropic = (!isTest || process.env.TEST_PROMPT_CACHING === "true") && modelInstance && (modelInstance.provider === "anthropic" || (typeof modelInstance.provider === "string" && modelInstance.provider.includes("anthropic")));
      if (isAnthropic && coreMessages.length > 0) {
        let markedCount = 0;
        for (let i = coreMessages.length - 1; i >= 0; i--) {
          if (coreMessages[i].role === "user") {
            const msg = coreMessages[i];
            if (typeof msg.content === "string") {
              msg.content = [
                {
                  type: "text",
                  text: msg.content,
                  experimental_providerMetadata: {
                    anthropic: { cacheControl: { type: "ephemeral" } },
                  },
                },
              ];
              markedCount++;
            } else if (Array.isArray(msg.content)) {
              for (let j = msg.content.length - 1; j >= 0; j--) {
                if (msg.content[j].type === "text") {
                  msg.content[j] = {
                    ...msg.content[j],
                    experimental_providerMetadata: {
                      anthropic: { cacheControl: { type: "ephemeral" } },
                    },
                  };
                  markedCount++;
                  break;
                }
              }
            }
            if (markedCount >= 3) {
              break;
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors in injecting cache metadata to ensure robust fallback
    }
  }

  private buildMode1Messages(
    coreMessages: CoreMessage[],
    threshold: number,
    useVisionTokenSaving: boolean,
    supportsVision: boolean,
    supportsNativeTools: boolean,
    modelName: string
  ): void {
    for (const m of this.conversation.getMessages()) {
      if (m.role === "system") continue;

      if (m.role === "user") {
        let sdkContent: string | Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = "";
        const rawContent = typeof m.content === "string" ? m.content : contentToString(m.content);
        const isMemoryContext = rawContent.startsWith("[TencentDB Agent Memory Context]:");

        if (useVisionTokenSaving && (rawContent.length > threshold || isMemoryContext)) {
          try {
            let base64List = this.getCachedImages(rawContent);
            if (!base64List) {
              const pages = sliceTextIntoPages(rawContent);
              base64List = [];
              for (const page of pages) {
                const base64 = renderTextToImageBase64(page);
                base64List.push(base64);
              }
              this.setCachedImages(rawContent, base64List);
            }
            const totalPages = base64List.length;
            const headerText = isMemoryContext
              ? `CRITICAL CONTEXT: The following image(s) contain the persistent TencentDB Agent Memory Context (system state and facts). Read the text in the image(s) to understand the background state. [TencentDB Agent Memory Context rendered as images to save tokens, split into ${totalPages} pages]:`
              : `CRITICAL USER INPUT: The following image(s) contain the text content of the user message. Read the text in the image(s) carefully to understand the user's request and instructions. [Content of user message rendered as images to save tokens, split into ${totalPages} pages]:`;
            const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = [
              { type: "text", text: headerText }
            ];
            base64List.forEach((base64, index) => {
              const pageLabel = isMemoryContext
                ? `[TencentDB Agent Memory Context Page ${index + 1} of ${totalPages}]:`
                : `[User Message Page ${index + 1} of ${totalPages}]:`;
              contentParts.push({ type: "text", text: pageLabel });
              contentParts.push({ type: "image", image: base64, mimeType: "image/webp" });
            });
            sdkContent = contentParts;
          } catch (err: any) {
            this.writeToLogFile("WARN", `Failed to automatically convert user message to image: ${err.message}. Falling back to text.`);
            sdkContent = typeof m.content === "string"
              ? m.content
              : (m.content as any[]).map((p: any) => {
                  if (p.type === "image") {
                    if (supportsVision) {
                      return { type: "image" as const, image: p.image, mimeType: p.mimeType };
                    }
                    return {
                      type: "text" as const,
                      text: `[Image: (${p.mimeType || "unknown type"}) - not sent because the active model (${modelName || "unknown"}) does not support vision/images. Base64 Data: data:${p.mimeType || "image/webp"};base64,${p.image}]`
                    };
                  }
                  return { type: "text" as const, text: p.text };
                });
          }
        } else {
          sdkContent = typeof m.content === "string"
            ? m.content
            : (m.content as any[]).map((p: any) => {
                if (p.type === "image") {
                  if (supportsVision) {
                    return { type: "image" as const, image: p.image, mimeType: p.mimeType };
                  }
                  return {
                    type: "text" as const,
                    text: `[Image: (${p.mimeType || "unknown type"}) - not sent because the active model (${modelName || "unknown"}) does not support vision/images. Base64 Data: data:${p.mimeType || "image/webp"};base64,${p.image}]`
                  };
                }
                return { type: "text" as const, text: p.text };
              });
        }

        coreMessages.push({
          role: "user",
          content: sdkContent as any,
        });
      } else if (m.role === "assistant") {
        const hasToolCalls = m.toolCalls && m.toolCalls.length > 0;
        if (hasToolCalls && supportsNativeTools) {
          const contentParts: Array<
            | { type: "text"; text: string }
            | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
          > = [];

          if (m.content) {
            contentParts.push({ type: "text", text: contentToString(m.content) });
          }

          for (const tc of m.toolCalls!) {
            contentParts.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.name,
              args: tc.args,
            });
          }

          coreMessages.push({
            role: "assistant",
            content: contentParts,
          });
        } else if (hasToolCalls) {
          // Reconstruct XML tool calls for prompt-based tool calling
          let text = contentToString(m.content);
          text += "\n<tool_calls>\n" + m.toolCalls!.map(tc => `<tool_call>\n${JSON.stringify({ name: tc.name, arguments: tc.args })}\n</tool_call>`).join("\n") + "\n</tool_calls>";
          coreMessages.push({
            role: "assistant",
            content: text,
          });
        } else {
          coreMessages.push({
            role: "assistant",
            content: contentToString(m.content),
          });
        }
      } else if (m.role === "tool") {
        if (!supportsNativeTools) {
          // Reconstruct XML responses for prompt-based tool calling
          const results = m.toolResults || [];
          const resultText = results.map(tr => `<tool_response name="${tr.name}">\n${tr.result}\n</tool_response>`).join("\n");
          
          if (useVisionTokenSaving && resultText.length > threshold) {
            try {
              let base64List = this.getCachedImages(resultText);
              if (!base64List) {
                const pages = sliceTextIntoPages(resultText);
                base64List = [];
                for (const page of pages) {
                  const base64 = renderTextToImageBase64(page);
                  base64List.push(base64);
                }
                this.setCachedImages(resultText, base64List);
              }
              const totalPages = base64List.length;
              const contentParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = [
                {
                  type: "text",
                  text: `CRITICAL TOOL OUTPUT: The following image(s) contain the execution results/responses of your recently invoked tools. Read the text in the image(s) carefully to see the output. [Tool responses rendered as images to save tokens, split into ${totalPages} pages]:`
                }
              ];
              base64List.forEach((base64, index) => {
                contentParts.push({
                  type: "text",
                  text: `[Tool Responses Page ${index + 1} of ${totalPages}]:`
                });
                contentParts.push({ type: "image", image: base64, mimeType: "image/webp" });
              });
              coreMessages.push({
                role: "user",
                content: contentParts as any,
              });
            } catch (err: any) {
              this.writeToLogFile("WARN", `Failed to automatically convert XML tool results to image: ${err.message}. Falling back to text.`);
              coreMessages.push({
                role: "user",
                content: resultText,
              });
            }
          } else {
            coreMessages.push({
              role: "user",
              content: resultText,
            });
          }
          continue;
        }

        // Safe check to avoid orphaned tool messages (required by DeepSeek)
        let lastAssistantWithToolCalls = false;
        for (let i = coreMessages.length - 1; i >= 0; i--) {
          const prev = coreMessages[i];
          if (prev.role === "assistant") {
            if (Array.isArray(prev.content)) {
              lastAssistantWithToolCalls = prev.content.some(
                (part) => part.type === "tool-call"
              );
            }
            break;
          } else if (prev.role === "user") {
            break;
          }
        }

        if (!lastAssistantWithToolCalls) {
          continue;
        }

        const contentParts: Array<{
          type: "tool-result";
          toolCallId: string;
          toolName: string;
          result: string;
        }> = [];

        const results = m.toolResults || [];
        if (results.length === 0) {
          continue;
        }

        let pendingImagesToAppend: Array<{ toolName: string; base64List: string[]; mimeType?: string }> = [];

        for (const tr of results) {
          // Skip results with missing toolCallId — Anthropic requires tool_use_id on every tool_result block
          if (!tr.toolCallId) {
            this.writeToLogFile("WARN", `Skipping tool result for "${tr.name}": missing toolCallId`);
            continue;
          }
          const resultStr = typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result);
          
          // Check for data:image/xxx;base64,... pattern in the result
          const dataUriRegex = /data:(image\/[a-zA-Z+.-]+);base64,([a-zA-Z0-9+/=]+(?:\r?\n)?[a-zA-Z0-9+/=]*)/g;
          let match;
          let cleanedResult = resultStr;
          let hasImages = false;
          
          dataUriRegex.lastIndex = 0;
          while ((match = dataUriRegex.exec(resultStr)) !== null) {
            const mimeType = match[1];
            const base64Data = match[2].replace(/\s/g, ""); // strip whitespace/newlines
            
            pendingImagesToAppend.push({
              toolName: tr.name,
              base64List: [base64Data],
              mimeType,
            });
            hasImages = true;
          }

          if (hasImages) {
            cleanedResult = resultStr.replace(dataUriRegex, (fullMatch, mimeType) => {
              return `[Image (${mimeType}) attached as a vision image part]`;
            });
            contentParts.push({
              type: "tool-result",
              toolCallId: tr.toolCallId,
              toolName: tr.name,
              result: cleanedResult,
            });
          } else if (useVisionTokenSaving && resultStr.length > threshold) {
            try {
              this.writeToLogFile("INFO", `Automatically converting tool result of "${tr.name}" (size ${resultStr.length} chars) to image.`);
              let base64List = this.getCachedImages(resultStr);
              if (!base64List) {
                const pages = sliceTextIntoPages(resultStr);
                base64List = [];
                for (const page of pages) {
                  const base64 = renderTextToImageBase64(page);
                  base64List.push(base64);
                }
                this.setCachedImages(resultStr, base64List);
              }
              
              pendingImagesToAppend.push({ toolName: tr.name, base64List });
              contentParts.push({
                type: "tool-result",
                toolCallId: tr.toolCallId,
                toolName: tr.name,
                result: `[Tool result for "${tr.name}" rendered as image in the subsequent message to save tokens]`,
              });
            } catch (err: any) {
              this.writeToLogFile("WARN", `Failed to automatically convert native tool result of "${tr.name}" to image: ${err.message}. Falling back to text.`);
              contentParts.push({
                type: "tool-result",
                toolCallId: tr.toolCallId,
                toolName: tr.name,
                result: tr.result,
              });
            }
          } else {
            contentParts.push({
              type: "tool-result",
              toolCallId: tr.toolCallId,
              toolName: tr.name,
              result: tr.result,
            });
          }
        }

        // Do not push an empty tool message — would cause Anthropic 400
        if (contentParts.length === 0) {
          continue;
        }

        coreMessages.push({
          role: "tool",
          content: contentParts,
        });

        if (pendingImagesToAppend.length > 0) {
          const appendParts: Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = [];
          for (const item of pendingImagesToAppend) {
            const totalPages = item.base64List.length;
            if (item.mimeType) {
              // Direct image from tool execution
              appendParts.push({
                type: "text",
                text: `Direct image output from tool "${item.toolName}":`
              });
              item.base64List.forEach((base64) => {
                appendParts.push({ type: "image", image: base64, mimeType: item.mimeType });
              });
            } else {
              // Vision token saving flow
              appendParts.push({
                type: "text",
                text: `CRITICAL TOOL OUTPUT: The following image(s) contain the actual execution output of the tool "${item.toolName}". Read the text inside the image(s) to see the result. [Tool output for "${item.toolName}" rendered as image, split into ${totalPages} pages]:`
              });
              item.base64List.forEach((base64, index) => {
                appendParts.push({
                  type: "text",
                  text: `[Tool Output for "${item.toolName}" Page ${index + 1} of ${totalPages}]:`
                });
                appendParts.push({ type: "image", image: base64, mimeType: "image/webp" });
              });
            }
          }
          coreMessages.push({
            role: "user",
            content: appendParts as any,
          });
        }
      }
    }

    try {
      const modelInstance = this.getModel();
      const isTest = !!process.env.VITEST;
      const isAnthropic = (!isTest || process.env.TEST_PROMPT_CACHING === "true") && modelInstance && (modelInstance.provider === "anthropic" || (typeof modelInstance.provider === "string" && modelInstance.provider.includes("anthropic")));
      if (isAnthropic && coreMessages.length > 0) {
        let markedCount = 0;
        for (let i = coreMessages.length - 1; i >= 0; i--) {
          if (coreMessages[i].role === "user") {
            const msg = coreMessages[i];
            if (typeof msg.content === "string") {
              msg.content = [
                {
                  type: "text",
                  text: msg.content,
                  experimental_providerMetadata: {
                    anthropic: { cacheControl: { type: "ephemeral" } },
                  },
                },
              ];
              markedCount++;
            } else if (Array.isArray(msg.content)) {
              for (let j = msg.content.length - 1; j >= 0; j--) {
                if (msg.content[j].type === "text") {
                  msg.content[j] = {
                    ...msg.content[j],
                    experimental_providerMetadata: {
                      anthropic: { cacheControl: { type: "ephemeral" } },
                    },
                  };
                  markedCount++;
                  break;
                }
              }
            }
            if (markedCount >= 3) {
              break;
            }
          }
        }
      }
    } catch (e) {
      // Ignore errors in injecting cache metadata to ensure robust fallback
    }

  }

  async compactHistoryIfNeeded(signal?: AbortSignal, force: boolean = false, tokenBudget?: number, byteBudget?: number): Promise<void> {
    await this.ensureContextManager();
    const contextManager = this.conversation.getContextManager();

    if (contextManager) {
      await this.contextManagerCompact(signal, force, tokenBudget, byteBudget);
      return;
    }

    await this.legacyCompactHistory(signal, force, tokenBudget, byteBudget);
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

  private async contextManagerCompact(signal?: AbortSignal, force: boolean = false, tokenBudget?: number, byteBudget?: number): Promise<void> {
    const contextManager = this.conversation.getContextManager()!;
    if (signal) {
      await this.conversation.updateContextManagerLLM(this.getModel(), signal);
    }
    const messages = this.conversation.getMessages();
    const decision = contextManager.shouldCompact(messages);

    if (!decision.shouldCompact && !force && !tokenBudget) {
      return;
    }

    try {
      this.writeToLogFile(
        "INFO",
        `Context compaction triggered: ${force ? "forced-413" : (tokenBudget ? "forced-token-limit" : decision.reason)} (strategy: ${force ? "pruning" : (decision.recommendedStrategy?.name || "auto")})`
      );

      let strategy;
      let compactionOptions: Partial<import("./context/CompactionStrategy.js").CompactionOptions> = {
        modelName: this.config.model,
      };
      if (force && !tokenBudget) {
        const { PruningStrategy } = await import("./context/strategies/PruningStrategy.js");
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

      this.conversation.replaceMessages(result.messages);
      await this.saveHistory();

      this.writeToLogFile(
        "INFO",
        `Compaction completed: ${result.metadata.strategy} strategy, ${result.metadata.messagesBefore || 0} -> ${result.metadata.messagesAfter || 0} messages`
      );
    } catch (error) {
      console.error("ContextManager compaction failed:", error);
      this.writeToLogFile("ERROR", `ContextManager compaction failed: ${(error as Error).message}`);
      await this.legacyCompactHistory(signal, force, tokenBudget, byteBudget);
    }
  }

  private async legacyCompactHistory(signal?: AbortSignal, force: boolean = false, tokenBudget?: number, byteBudget?: number): Promise<void> {
    const modelLimit = getContextWindowLimit(this.config.model);
    const maxHistoryTokens = tokenBudget ?? Math.floor(modelLimit * (force ? 0.3 : 0.5));

    if (force || tokenBudget || this.conversation.getTokenEstimate() > maxHistoryTokens) {
      const allMsgs = this.conversation.getMessages();
      if (allMsgs.length > 20) {
        const toSummarize = allMsgs.slice(0, 20);
        try {
          if (force) {
            this.conversation.pruneToTokenLimit(maxHistoryTokens);
            await this.saveHistory();
          } else {
            const summary = await this.summarizeMessages(toSummarize, signal);
            this.conversation.replaceOldMessagesWithSummary(20, summary);
            await this.saveHistory();
          }
        } catch (err) {
          console.error("Failed to summarize and compact conversation history:", err);
          this.conversation.pruneToTokenLimit(maxHistoryTokens);
          await this.saveHistory();
        }
      } else {
        this.conversation.pruneToTokenLimit(maxHistoryTokens);
        await this.saveHistory();
      }
    }
  }

  private async summarizeMessages(messages: any[], signal?: AbortSignal): Promise<string> {
    const formatted = messages.map(m => {
      const role = m.role.toUpperCase();
      let details = m.content || "";
      if (m.toolCalls && m.toolCalls.length > 0) {
        details += `\n[Tool Calls]: ${m.toolCalls.map((tc: any) => tc.name).join(", ")}`;
      }
      return `[${role}]: ${details}`;
    }).join("\n\n");

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

        result = await generateText({
          model: this.getModel(),
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

    return result.text || "(empty summary)";
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
    this.conversation.clear();
    this.textLogBuffer = "";
    this.pendingMessagesQueue = [];
    this.lastSpeed = null;
    this.wasRunningBeforeAbort = false;
    this.currentHistoryFilePath = this.resolveHistoryFilePath(false);
    await this.saveHistory();
  }

  /**
   * Reset all internal transient state (buffers, flags) without touching
   * conversation history or file paths. Called by /new to guarantee a
   * completely clean slate in both single-agent and multi-agent modes.
   */
  /**
   * Creates an automatic checkpoint if cooldown has elapsed.
   * Called on every user message and before destructive tool operations.
   * Non-blocking — runs in background and swallows errors.
   */
  private autoCheckpoint(label: string): void {
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

  private async prepopulateTencentDBMemoryContext(): Promise<void> {
    const messages = this.conversation.getMessages();
    // Check if we already have a memory context message in the conversation
    const hasMemoryContext = messages.some(
      (m) => m.role === "user" && contentToString(m.content).startsWith("[TencentDB Agent Memory Context]:")
    );
    if (hasMemoryContext) return;

    // Fetch the memories
    const settings = getSettings();
    if (!settings.enableTencentdbMemory) return;

    const client = getTencentDBClient(2000); // 2s timeout for fast startup check

    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const query = lastUserMsg ? contentToString(lastUserMsg.content) : "latest coding context";

    this.writeToLogFile("INFO", `Pre-populating TencentDB memory context for query: "${query.slice(0, 50)}"...`);

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

    if (l1Items.length > 0) {
      formattedMemories.push("\n<relevant-memories>");
      for (const item of l1Items) {
        const typeTag = item.type ? `[${item.type}]` : "";
        formattedMemories.push(`- ${typeTag} ${item.content}`);
      }
      formattedMemories.push("</relevant-memories>");
    }

    const summaryText = formattedMemories.join("\n").trim();
    if (!summaryText) return;

    const memoryMessage: Message = {
      role: "user",
      content: `[TencentDB Agent Memory Context]:\n${summaryText}`,
      timestamp: Date.now(),
    };

    this.conversation.replaceMessages([memoryMessage, ...messages]);
    this.writeToLogFile("INFO", "TencentDB memory context successfully pre-populated and injected.");
  }

  private async syncConversationToTencentDB(): Promise<void> {
    const settings = getSettings();
    if (!settings.enableTencentdbMemory) return;

    const client = getTencentDBClient(3000); // 3s timeout to prevent CLI hang
    const historyPath = this.getCurrentHistoryFilePath();
    const sessionKey = getTencentDBSessionKey(historyPath);

    const messages = this.conversation.getMessages();
    const lastCaptured = this.conversation.lastCapturedTimestamp || 0;

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
      this.writeToLogFile("INFO", `Incrementally syncing ${newMessages.length} new messages to TencentDB (session: ${sessionKey})...`);
      await client.addConversation({
        session_id: sessionKey,
        messages: newMessages,
      });
      const maxTs = Math.max(...messages.map((m) => m.timestamp || 0));
      if (maxTs > lastCaptured) {
        this.conversation.lastCapturedTimestamp = maxTs;
      }
    }
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

interface GitFileDiff {
  added: number;
  deleted: number;
}

export type GitSnapshot = Record<string, GitFileDiff>;

export async function captureGitSnapshot(cwd: string): Promise<GitSnapshot | null> {
  try {
    const { stdout: isGit } = await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd, reject: false });
    if (isGit.trim() !== "true") {
      return null;
    }

    const snapshot: GitSnapshot = {};

    // Get tracked changes relative to HEAD
    const { stdout: numstat } = await execa("git", ["diff", "HEAD", "--numstat"], { cwd, reject: false });
    const lines = numstat.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3) {
        const added = parts[0] === "-" ? 0 : parseInt(parts[0], 10);
        const deleted = parts[1] === "-" ? 0 : parseInt(parts[1], 10);
        const filepath = parts.slice(2).join(" ");
        snapshot[filepath] = { added, deleted };
      }
    }

    // Get untracked files
    const { stdout: untracked } = await execa("git", ["ls-files", "--others", "--exclude-standard"], { cwd, reject: false });
    const untrackedFiles = untracked.split("\n");
    for (const file of untrackedFiles) {
      const filepath = file.trim();
      if (!filepath) continue;
      const fullPath = path.resolve(cwd, filepath);
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const linesCount = content.split(/\r?\n/).length;
          snapshot[filepath] = { added: linesCount, deleted: 0 };
        } catch {
          snapshot[filepath] = { added: 0, deleted: 0 };
        }
      }
    }

    return snapshot;
  } catch {
    return null;
  }
}

export function getGitDiffSummary(start: GitSnapshot | null, end: GitSnapshot | null): string | null {
  if (!end) return null;
  const startMap = start || {};
  const summaryLines: string[] = [];

  const allFiles = new Set([...Object.keys(startMap), ...Object.keys(end)]);

  for (const file of allFiles) {
    const startVal = startMap[file] || { added: 0, deleted: 0 };
    const endVal = end[file];

    if (!endVal) {
      const addedDiff = -startVal.added;
      const deletedDiff = -startVal.deleted;
      if (addedDiff !== 0 || deletedDiff !== 0) {
        const parts: string[] = [];
        if (addedDiff !== 0) {
          parts.push(addedDiff > 0 ? `+${addedDiff}` : `${addedDiff}`);
        }
        if (deletedDiff !== 0) {
          parts.push(deletedDiff > 0 ? `-${deletedDiff}` : `+${-deletedDiff}`);
        }
        summaryLines.push(`- ${file}: discarded (${parts.join(", ")})`);
      }
      continue;
    }

    const addedDiff = endVal.added - startVal.added;
    const deletedDiff = endVal.deleted - startVal.deleted;

    if (addedDiff !== 0 || deletedDiff !== 0) {
      const parts: string[] = [];
      if (addedDiff !== 0) {
        parts.push(addedDiff > 0 ? `+${addedDiff}` : `${addedDiff}`);
      }
      if (deletedDiff !== 0) {
        parts.push(deletedDiff > 0 ? `-${deletedDiff}` : `+${-deletedDiff}`);
      }
      summaryLines.push(`- ${file}: ${parts.join(", ")}`);
    }
  }

  if (summaryLines.length === 0) return null;
  return summaryLines.join("\n");
}
