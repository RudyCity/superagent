import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import fs from "fs";
import { getConfig, getContextWindowLimit, getGlobalConfigDir, ensureGlobalConfigDir, getModelInstanceForTier, getModelInstanceForString, loadAgentSkills, getSettings } from "./config.js";
import { Conversation } from "./conversation.js";
import { getToolDefinitions, backgroundTasks } from "./tools.js";
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
import { contentToString } from "./conversation.js";
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
  | { type: "tool_start"; toolCall: ToolCall; description: string }
  | { type: "tool_end"; toolResult: ToolResult; description: string }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "goal_done"; goal: string; summary: string }
  | { type: "permission_required"; toolCall: ToolCall; description: string }
  | { type: "illegal_operation"; violation: ViolationRecord }
  | { type: "token_usage"; promptTokens: number; completionTokens: number; durationMs?: number }
  | { type: "checkpoint_auto"; name: string; id: string };

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


function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object") {
    try {
      const obj = err as any;
      if (obj.message && typeof obj.message === "string") {
        return obj.message;
      }
      if (obj.error && typeof obj.error === "object" && obj.error.message && typeof obj.error.message === "string") {
        return obj.error.message;
      }
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
    msg.includes("model output must contain") ||
    msg.includes("empty response from model")
  ) {
    return false;
  }
  
  return true;
}


export class Agent {
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
  public lastSpeed: number | null = null;
  public goalMode: string | null = null;
  public goalMaxIterations: number = 200;
  public wasRunningBeforeAbort = false;
  public allowSessionOutOfBounds = false;
  public allowSessionEnvAccess = false;
  public allowSessionDangerous = false;
  public workspaceCache: any = null;
  public disableWorkspaceDiscovery: boolean = !!process.env.VITEST;
  private conversation: Conversation;
  private customSystemPrompt?: string;
  /** Custom tool list for this agent (tier-specific). Undefined = use allTools. */
  private customTools?: Tool[];
  private get config() {
    return getConfig();
  }
  private onEvent: (event: AgentEvent) => void;
  private onPermission: PermissionHandler;
  private onQuestion: QuestionHandler;
  private abortController: AbortController | null = null;
  private isRunning = false;
  private pendingMessage: string | null = null;
  private textLogBuffer = "";
  /** Flag set when completed tasks were just archived — used to inject system prompt hint */
  private tasksJustArchived: boolean = false;
  /** Number of tasks that were archived in the last sendMessage call */
  private archivedTaskCount: number = 0;
  /** Timestamp of last auto-checkpoint (for cooldown) */
  private lastAutoCheckpointAt: number = 0;
  /** Minimum interval between auto-checkpoints in ms */
  private static readonly AUTO_CHECKPOINT_COOLDOWN_MS = 10_000;

  public approvePlan(): void {
    this.planState = "APPROVED";
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
    const historyDir = path.join(getGlobalConfigDir(), "history", mode);

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
              let mtime = 0;
              try {
                mtime = fs.statSync(filePath).mtime.getTime();
              } catch {
                mtime = fs.statSync(dirPath).mtime.getTime();
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
    await this.conversation.saveToFile(this.currentHistoryFilePath, this.planState, this.workingDirectory);
  }

  private getModel() {
    return getModelInstanceForTier(this.tier, this.delegationDepth, this.subagentType, !this.isMultiAgent);
  }

  async sendMessage(userInput: string | import("./conversation.js").MessageContent): Promise<void> {
    if (this.isRunning) {
      // Queue the message instead of dropping it silently.
      // This handles the race condition where the user approves a plan
      // while the agent loop is still finishing its current iteration.
      this.pendingMessage = typeof userInput === "string" ? userInput : "[multimodal message]";
      this.writeToLogFile("INFO", `Message queued (agent is running): "${typeof userInput === "string" ? userInput.substring(0, 80) : "[multimodal]"}..."`);
      return;
    }

    if (this.planState === "IDLE" && (!process.env.VITEST || process.env.SUPERAGENT_TEST_SIMPLE_TASK === "true")) {
      try {
        const model = this.getModel();
        const threshold = getSettings().simpleTaskFileThreshold ?? 3;
        const classificationPrompt = `You are a helper that classifies if a user request is a "simple task".
A request is a "simple task" if it expects modification or creation of fewer than ${threshold} files and does NOT introduce any new architecture, major system changes, or complex orchestration.
For example, simple refactorings, adding single simple functions, modifying specific existing logic, or fixing a simple bug are simple tasks.

User request: "${userInput}"

Reply with EXACTLY "yes" if it is a simple task, or "no" if it is not. Reply with nothing else.`;

        const response = await generateText({
          model,
          prompt: classificationPrompt,
        });

        // Track tokens for the classification call
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
          const words = lowerInput.split(/[^a-zA-Z0-9'’]+/).filter(Boolean);
          const preApprovalWords = getSettings().simpleTaskKeywords || ['lanjut', 'coba', 'go ahead', 'proceed', 'try', 'run', 'execute', 'ok', 'yes', 'y'];
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
      } catch (err: any) {
        this.writeToLogFile("WARN", `Failed to classify user request: ${err.message}`);
      }
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    this.writeToLogFile("INFO", `Agent execution started (tier: ${this.tier}, depth: ${this.delegationDepth}, isMultiAgent: ${this.isMultiAgent}, workingDirectory: ${this.workingDirectory}, worktreePath: ${this.worktreePath})`);
    this.writeToLogFile("INFO", `Received user message: "${typeof userInput === "string" ? userInput : "[multimodal message]"}"`);

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

      // If a message was queued while this run was in progress (e.g. plan approval),
      // auto-send it now instead of firing "done" and stopping.
      if (this.pendingMessage !== null) {
        const queued = this.pendingMessage;
        this.pendingMessage = null;
        this.writeToLogFile("INFO", `Auto-sending queued message: "${queued.substring(0, 80)}..."`);
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
    const defaultMax = getSettings().maxIterations || 50;
    const maxIterations = isGoalMode ? this.goalMaxIterations : defaultMax;
    let continueCount = 0;
    // In goal mode, allow many more auto-continues without prompting the user
    const maxContinues = isGoalMode ? 10 : 3;

    let baseSystemPrompt = this.customSystemPrompt || this.config.systemPrompt;
    // config.systemPrompt (from getSystemPrompt() in base.ts) already includes skills for main tiers.
    // We only need to inject skills when using a customSystemPrompt (subagents spawned with custom prompts
    // that bypass getSystemPrompt), to ensure they also see the installed skills list.
    if (this.customSystemPrompt) {
      const skillsPrompt = loadAgentSkills();
      if (skillsPrompt && !baseSystemPrompt.includes("INSTALLED AGENT SKILLS:")) {
        baseSystemPrompt += "\n\n" + skillsPrompt;
      }
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

    let guidelinesText = "";
    try {
      const searchPaths = [
        path.join(process.cwd(), "agents.md"),
        path.join(this.workingDirectory, "agents.md"),
      ];
      if (!this.workspaceCache?.agentsMd) {
        for (const p of searchPaths) {
          if (fs.existsSync(p)) {
            guidelinesText += `\n\nPROJECT GUIDELINES (agents.md):\n${fs.readFileSync(p, "utf-8")}\n`;
            break;
          }
        }
      }
      const skillPaths = [
        path.join(process.cwd(), ".agents", "skills", "karpathy-guidelines", "SKILL.md"),
        path.join(this.workingDirectory, ".agents", "skills", "karpathy-guidelines", "SKILL.md"),
      ];
      for (const p of skillPaths) {
        if (fs.existsSync(p)) {
          guidelinesText += `\n\nBEHAVIORAL CODING GUIDELINES (karpathy-guidelines):\n${fs.readFileSync(p, "utf-8")}\n`;
          break;
        }
      }
    } catch {
      // Ignore guideline loading errors
    }

    try {
      for (let i = 0; i < maxIterations; i++) {
        if (signal?.aborted) {
          const err = new Error("AbortError");
          err.name = "AbortError";
          throw err;
        }

        // Run workspace discovery and load/update cache if workspace files changed
        if (!this.disableWorkspaceDiscovery) {
          try {
            const { discoverWorkspace } = await import("./workspaceDiscovery.js");
            const { isIdentical, cache } = await discoverWorkspace(this.workingDirectory);
            const wasFirstRun = !this.workspaceCache;
            this.workspaceCache = cache;
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

        await this.compactHistoryIfNeeded(signal);
        const messages = this.buildMessages();
        // Use tier-specific toolset if provided, otherwise use the appropriate tier-default toolset dynamically
        let toolsToUse = this.customTools;
        if (!toolsToUse) {
          const { masterToolset, superagentToolset, subagentToolsets, defaultSubagentToolset } = await import("./tools/toolsets.js");
          if (this.tier === "master") {
            toolsToUse = masterToolset;
          } else if (this.tier === "superagent" || this.tier === "single") {
            toolsToUse = superagentToolset;
          } else if (this.tier === "subagent") {
            toolsToUse = (this.subagentType && subagentToolsets[this.subagentType]) || defaultSubagentToolset;
          }
        }

        const toolDefs = toolsToUse
          ? toolsToUse.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            }))
          : getToolDefinitions();

        let planStateNotice = "";
        if (this.tier === "master" || this.tier === "single") {
          planStateNotice = `

PLANNING, TASKS & VERIFICATION FILES FOR THIS SESSION:
- Implementation Plan File: ${this.getPlanFilePath()}
- Task Tracking File: ${this.getTaskFilePath()}
- Task History File: ${this.getTaskHistoryFilePath()}
- Verification/Walkthrough File: ${this.getWalkthroughFilePath()}

CRITICAL RULES FOR PLANNING:
1. You MUST use the 'manage_plan' tool (action: 'create' or 'sync') to create, update, or synchronize the Implementation Plan and tasks.
2. You MUST use the 'manage_tasks' tool (action: 'update') to update the status of checklist tasks.
3. DO NOT use 'write_to_file', 'replace_file_content', 'multi_replace_file_content', or 'edit' to create, modify, or update the Implementation Plan File or the Task Tracking File directly. Doing so is strictly forbidden.
4. For the Verification/Walkthrough File, you may use 'write_to_file' directly.
5. Do NOT write or create plan or task files in the local workspace directory.
6. Whenever you reference these files, always use their absolute paths or format them as absolute file:/// links.`;
        } else if (this.tier === "superagent") {
          planStateNotice = `

PLANNING, TASKS & VERIFICATION FILES FOR THIS SESSION:
- Implementation Plan File: ${this.getPlanFilePath()}
- Task Tracking File: ${this.getTaskFilePath()}
- Task History File: ${this.getTaskHistoryFilePath()}
- Verification/Walkthrough File: ${this.getWalkthroughFilePath()}

CRITICAL RULES FOR PLANNING:
1. You MUST use the 'manage_tasks' tool (action: 'update') to update the status of checklist tasks.
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
You SHOULD use the 'manage_tasks' tool (action: 'add') or 'manage_plan' tool (action: 'create') to create fresh tasks for the user's new request.
This ensures the ACTIVE TASK CHECKLIST stays up-to-date with the current work.`;
          // Reset the flag after injecting on first iteration only
          this.tasksJustArchived = false;
        }

        const currentStep = i + 1;
        const runningProcesses = Array.from(backgroundTasks.entries())
          .filter(([_, t]) => !t.hasExited)
          .map(([id, t]) => `- Process ID: ${id}, Command: "${t.command}"`)
          .join("\n");
        const processNotice = runningProcesses
          ? `\n\n⚙️ RUNNING BACKGROUND/TERMINAL PROCESSES:\nYou are aware that the following background/terminal processes are currently running in the environment:\n${runningProcesses}`
          : "";

        // ── Inject pinned knowledge from global store (once per session, on first iteration) ──
        let pinnedKnowledgeNotice = "";
        if (i === 0) {
          try {
            const { getAllKnowledge, formatKnowledgeForPrompt } = await import("./pinnedKnowledge.js");
            const knowledgeEntries = getAllKnowledge({ limit: 10 });
            if (knowledgeEntries.length > 0) {
              pinnedKnowledgeNotice = "\n\n" + formatKnowledgeForPrompt(knowledgeEntries, 8, 1500);
            }
          } catch { /* non-critical */ }
        }

        // ── Single-mode subagent directive ──────────────────────────────────
        const singleModeSubagentDirective = this.tier === "single" ? `

SUBAGENT WORKFLOW — MANDATORY FOR SINGLE MODE:
You operate in single-agent mode but you MUST leverage subagents aggressively. Your role is to ORCHESTRATE, not to do everything yourself.

COMPULSORY SUBAGENT RULES:
1. RESEARCH tasks (exploring codebase, reading docs, searching web) → ALWAYS spawn a 'researcher' subagent. Never do research inline.
2. IMPLEMENTATION tasks (writing code, editing files) → spawn a 'coder' subagent. You coordinate, not code.
3. REVIEW tasks (checking correctness, testing, validating) → spawn a 'reviewer' subagent after each implementation.
4. COMPLEX requests → immediately break into parallel subtasks and spawn multiple subagents concurrently.

SUBAGENT DISPATCH PATTERN (follow this every time):
  Step 1 — Analyze: understand what the user wants.
  Step 2 — Plan: identify independent subtasks (and which skills are relevant).
  Step 3 — Spawn: invoke subagents for each subtask (parallel if independent).
  Step 4 — Integrate: collect results, synthesize, respond to user.

WHEN YOU MUST SPAWN A SUBAGENT (non-exhaustive):
- Any codebase investigation or file reading beyond a single quick lookup
- Any multi-file editing or feature implementation
- Any test run or build verification
- Any web search or documentation lookup
- Any task that would take more than 2 of your own steps to complete

DO NOT do any of the above yourself. Delegate everything you can.

SKILL USAGE — MANDATORY:
You have access to INSTALLED AGENT SKILLS listed above. You MUST use them.
BEFORE starting any task, identify which skill(s) are relevant and read their SKILL.md file using the view_file tool.
Skill categories to always check:
- Debugging/investigation → 'systematic-debugging', 'root-cause-tracing', 'diagnosing-bugs'
- New feature/development → 'writing-plans', 'subagent-driven-development', 'test-driven-development-tdd'
- Code review → 'requesting-code-review', 'code-review-reception'
- Finishing work → 'finishing-a-development-branch', 'verification-before-completion'
- Research/exploration → 'dispatching-parallel-agents'
DO NOT skip skill reading. Instruct your subagents to also read and follow the relevant SKILL.md.

SELF-VERIFICATION & CRITIC — MANDATORY BEFORE RESPONDING TO USER:
After all subagents finish, you MUST perform this verification loop before considering the task done:
1. VALIDATE OUTPUTS: Review each subagent's report. Check that build passed, tests passed, and all task requirements are met.
2. CRITIC: Actively challenge the results. Ask yourself:
   - Did the coder subagent actually run the build and tests? If not, spawn a reviewer to verify.
   - Are there edge cases that were not addressed?
   - Does the implementation actually solve the user's original request (not just a surface interpretation)?
   - Are there any TODOs, placeholders, or incomplete parts?
3. IF GAPS FOUND → spawn a fix subagent (coder or reviewer) to address them. Do NOT report completion with known gaps.
4. ONLY report completion when you have concrete evidence (build pass, test pass, acceptance criteria met).` : "";

        let activeSystemPrompt = baseSystemPrompt;
        if (this.workspaceCache) {
          try {
            const { injectWorkspaceOverview } = await import("./workspaceDiscovery.js");
            activeSystemPrompt = injectWorkspaceOverview(baseSystemPrompt, this.workspaceCache);
          } catch {}
        }

        const systemPrompt = `${activeSystemPrompt}

CRITICAL TASK EXECUTION CONTEXT:
- You are running with a strict step limit of ${maxIterations} agent iterations per request.
- Current Step: ${currentStep} of ${maxIterations}.
- Be highly efficient. DO NOT try to do everything in a single sequential thread.
- MANDATORY: For any task that is complex, multi-step, or touches multiple files/components — you MUST spawn subagents via 'invoke_subagent'. Doing it yourself is forbidden for such tasks.
- Spawn subagents in parallel whenever tasks are independent. This is the primary way to complete large tasks within the iteration limit.
- After spawning, wait for results, integrate them, and report back to the user.
${scratchpadText ? `\n\nPERSISTENT SCRATCHPAD MEMORY:\n${scratchpadText}` : ""}${singleModeSubagentDirective}${goalModeAddendum}${guidelinesText}${planStateNotice}${planStateAddendum}${followUpTaskAddendum}${processNotice}${pinnedKnowledgeNotice}`;

        let textContent = "";
        const toolCalls: ToolCall[] = [];

        if (this.config.disableStreaming) {
          let attempt = 0;
          const maxRetries = 10;
          const baseDelay = 5000;

          while (true) {
            let concurrencyAcquired = false;
            try {
              if (getSettings().concurrencyLimit === 1) {
                await concurrencyLimiter.acquire();
                concurrencyAcquired = true;
              }
              await rateLimiter.acquire(1);

              const startTime = Date.now();
              const result = await generateText({
                model: this.getModel(),
                system: systemPrompt,
                messages,
                tools: Object.fromEntries(
                  toolDefs.map((t) => [
                    t.name,
                    {
                      description: t.description,
                      parameters: jsonSchema(t.input_schema),
                    },
                  ])
                ),
                maxSteps: 1,
                abortSignal: signal,
              });

              textContent = result.text || "";
              if (textContent) {
                this.onEvent({ type: "text", content: textContent });
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
              const isRetryable = isRetryableError(err);
              attempt++;
              if (attempt > maxRetries || !isRetryable) {
                const rawMsg = formatError(err);
                const msg = rawMsg === "Empty response from model"
                  ? "Empty response from model. Check your endpoint/model config."
                  : rawMsg;
                const prefixMsg = !isRetryable ? "Fatal error" : `Generate text failed after ${maxRetries} retries`;
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
              const msg = formatError(err);
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${msg}. Retrying attempt ${attempt}/${maxRetries}...\n` });
              await this.delayWithCountdown(attempt, baseDelay * Math.pow(2, attempt - 1), signal);
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
              const result = streamText({
                model: this.getModel(),
                system: systemPrompt,
                messages,
                tools: Object.fromEntries(
                  toolDefs.map((t) => [
                    t.name,
                    {
                      description: t.description,
                      parameters: jsonSchema(t.input_schema),
                    },
                  ])
                ),
                maxSteps: 1,
                abortSignal: signal,
              });

              for await (const delta of result.fullStream) {
                if (signal?.aborted) {
                  const err = new Error("AbortError");
                  err.name = "AbortError";
                  throw err;
                }
                if (delta.type === "text-delta") {
                  textContent += delta.textDelta;
                  this.onEvent({ type: "text", content: delta.textDelta });
                } else if ((delta.type as string) === "reasoning" || (delta.type as string) === "reasoning-delta") {
                  const reasoningText = (delta as any).reasoning || (delta as any).reasoningDelta || (delta as any).delta || "";
                  if (reasoningText) {
                    textContent += reasoningText;
                    this.onEvent({ type: "text", content: reasoningText });
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
                throw new Error("Empty response from model");
              }

              break;
            } catch (err: unknown) {
              if (err instanceof Error && err.name === "AbortError") {
                throw err;
              }
              const isRetryable = isRetryableError(err);
              attempt++;
              if (attempt > maxRetries || !isRetryable) {
                const rawMsg = formatError(err);
                const msg = rawMsg === "Empty response from model"
                  ? "Empty response from model. Check your endpoint/model config."
                  : rawMsg;
                const prefixMsg = !isRetryable ? "Fatal error" : `Stream error after ${maxRetries} retries`;
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
              const msg = formatError(err);
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${msg}. Retrying attempt ${attempt}/${maxRetries}...\n` });
              await this.delayWithCountdown(attempt, baseDelay * Math.pow(2, attempt - 1), signal);
            } finally {
              if (concurrencyAcquired) {
                concurrencyLimiter.release();
              }
            }
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
            this.conversation.addAssistantMessage(textContent);
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

          if (tc.name === "invoke_superagent" || tc.name === "merge_superagents" || tc.name === "invoke_subagent") {
            if (this.planState !== "APPROVED") {
              let msg = "";
              if (this.planState === "PLANNING_PENDING") {
                msg = `Error: Spawning Superagents or Subagents is blocked. A plan is pending approval. You must wait for the user to approve the plan using the interactive approval wizard before starting execution.`;
              } else {
                msg = `Error: Spawning Superagents or Subagents is blocked. You must first write an implementation plan to '${this.getPlanFilePath()}' and have the user approve it before you can invoke any agents.`;
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
          const needsPermission = isModelCfg
            ? true
            : isEnvFile
            ? !this.allowSessionEnvAccess
            : isToolCallOutOfBounds(tc, effectiveWorkspace) && !this.allowSessionOutOfBounds;
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
              : `Out-of-bounds access detected for tool: ${tc.name}. Requires permission to access files/directories/processes outside the workspace.${details}`;
            const approved = await this.onPermission(
              tc,
              permMessage
            );
            // model-config.json: "Allow for This Session" is not meaningful — treat it as a one-time allow
            if (!isModelCfg && !isEnvFile && approved === "session") {
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
          this.onEvent({ type: "tool_end", toolResult, description });
        }

        this.conversation.addAssistantMessage(
          textContent,
          toolCalls,
          toolResults
        );

        this.conversation.addMessage({
          role: "tool",
          content: "",
          toolResults,
          timestamp: Date.now(),
        });
        await this.saveHistory();

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
      if (isGoalMode && this.goalMode) {
        this.onEvent({
          type: "goal_done",
          goal: this.goalMode,
          summary: "Agent has finished executing. Check the output above for GOAL_COMPLETE or GOAL_PARTIAL status.",
        });
      }
    }
  }

  private buildMessages(): CoreMessage[] {
    const coreMessages: CoreMessage[] = [];

    for (const m of this.conversation.getMessages()) {
      if (m.role === "system") continue;

      if (m.role === "user") {
        // Map MessageContent (string | Part[]) to Vercel AI SDK CoreMessage format
        const sdkContent: string | Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> =
          typeof m.content === "string"
            ? m.content
            : (m.content as any[]).map((p: any) => {
                if (p.type === "image") {
                  return { type: "image" as const, image: p.image, mimeType: p.mimeType };
                }
                return { type: "text" as const, text: p.text };
              });
        coreMessages.push({
          role: "user",
          content: sdkContent as any,
        });
      } else if (m.role === "assistant") {
        const hasToolCalls = m.toolCalls && m.toolCalls.length > 0;
        if (hasToolCalls) {
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
        } else {
          coreMessages.push({
            role: "assistant",
            content: contentToString(m.content),
          });
        }
      } else if (m.role === "tool") {
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
        for (const tr of results) {
          contentParts.push({
            type: "tool-result",
            toolCallId: tr.toolCallId,
            toolName: tr.name,
            result: tr.result,
          });
        }

        coreMessages.push({
          role: "tool",
          content: contentParts,
        });
      }
    }

    return coreMessages;
  }

  async compactHistoryIfNeeded(signal?: AbortSignal): Promise<void> {
    await this.ensureContextManager();
    const contextManager = this.conversation.getContextManager();

    if (contextManager) {
      await this.contextManagerCompact(signal);
      return;
    }

    await this.legacyCompactHistory(signal);
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

  private async contextManagerCompact(signal?: AbortSignal): Promise<void> {
    const contextManager = this.conversation.getContextManager()!;
    if (signal) {
      await this.conversation.updateContextManagerLLM(this.getModel(), signal);
    }
    const messages = this.conversation.getMessages();
    const decision = contextManager.shouldCompact(messages);

    if (!decision.shouldCompact) {
      return;
    }

    try {
      this.writeToLogFile(
        "INFO",
        `Context compaction triggered: ${decision.reason} (strategy: ${decision.recommendedStrategy?.name || "auto"})`
      );

      const result = await contextManager.compact(messages);

      this.conversation.replaceMessages(result.messages);
      await this.saveHistory();

      this.writeToLogFile(
        "INFO",
        `Compaction completed: ${result.metadata.strategy} strategy, ${result.metadata.messagesBefore || 0} -> ${result.metadata.messagesAfter || 0} messages`
      );
    } catch (error) {
      console.error("ContextManager compaction failed:", error);
      this.writeToLogFile("ERROR", `ContextManager compaction failed: ${(error as Error).message}`);
      await this.legacyCompactHistory(signal);
    }
  }

  private async legacyCompactHistory(signal?: AbortSignal): Promise<void> {
    const modelLimit = getContextWindowLimit(this.config.model);
    const maxHistoryTokens = Math.floor(modelLimit * 0.5);

    if (this.conversation.getTokenEstimate() > maxHistoryTokens) {
      const allMsgs = this.conversation.getMessages();
      if (allMsgs.length > 20) {
        const toSummarize = allMsgs.slice(0, 20);
        try {
          const summary = await this.summarizeMessages(toSummarize, signal);
          this.conversation.replaceOldMessagesWithSummary(20, summary);
          await this.saveHistory();
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
    this.pendingMessage = null;
    this.abortController?.abort();
  }

  async clearHistory(): Promise<void> {
    this.conversation.clear();
    this.textLogBuffer = "";
    this.pendingMessage = null;
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
    this.pendingMessage = null;
    this.lastSpeed = null;
    this.wasRunningBeforeAbort = false;
    this.isRunning = false;
    this.abortController = null;
    this.tasksJustArchived = false;
    this.archivedTaskCount = 0;
    this.lastAutoCheckpointAt = 0;
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
