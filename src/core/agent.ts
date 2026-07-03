import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import fs from "fs";
import { getConfig, getContextWindowLimit, getGlobalConfigDir, ensureGlobalConfigDir, getModelInstanceForTier, getModelInstanceForString, loadAgentSkills, getSettings, getTierModel, getPackageRootDir, getModelConnectionDetailsForTier, clearHistoryCache } from "./config.js";
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
import { contentToString, Message } from "./conversation.js";
import { getTencentDBClient, getTencentDBSessionKey } from "./tencentdbUtil.js";
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
  private skillContentCache: Map<string, string> = new Map();
  /** Keys of skills that were successfully preloaded into guidelinesText */
  private preloadedSkillKeys: Set<string> = new Set();

  public approvePlan(): void {
    this.planState = "APPROVED";
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
    let text = "";
    try {
      // agents.md: only load from project workspace paths (never global)
      const searchPaths = [
        path.join(process.cwd(), "agents.md"),
        path.join(this.workingDirectory, "agents.md"),
      ];
      if (!this.workspaceCache?.agentsMd) {
        for (const p of searchPaths) {
          if (fs.existsSync(p)) {
            text += `\n\nPROJECT GUIDELINES (agents.md):\n${fs.readFileSync(p, "utf-8")}\n`;
            break;
          }
        }
      }

      // Dynamically determine target skills based on current state and query
      const targetSkills: Array<{ key: string; label: string }> = [];

      // Always include Karpathy Guidelines (universal coding rules)
      const karpathy = Agent.MANDATORY_SKILLS.find(s => s.key === "karpathy-guidelines");
      if (karpathy) targetSkills.push(karpathy);

      // Always include Pragmatic Minimalism (forces lean coding & reviews)
      const minimalism = Agent.MANDATORY_SKILLS.find(s => s.key === "pragmatic-minimalism");
      if (minimalism) targetSkills.push(minimalism);

      // Planning-related guidelines: only load during planning phase
      if (!this.isSimpleTask && (this.planState === "IDLE" || this.planState === "PLANNING_PENDING")) {
        const planning = Agent.MANDATORY_SKILLS.find(s => s.key === "superagent-planning");
        const writing = Agent.MANDATORY_SKILLS.find(s => s.key === "writing-plans");
        if (planning) targetSkills.push(planning);
        if (writing) targetSkills.push(writing);
      }

      // Execution-related guidelines: only load during execution phase
      if (!this.isSimpleTask && this.planState === "APPROVED") {
        const executing = Agent.MANDATORY_SKILLS.find(s => s.key === "executing-plans");
        const subagent = Agent.MANDATORY_SKILLS.find(s => s.key === "subagent-driven-development");
        const verification = Agent.MANDATORY_SKILLS.find(s => s.key === "verification-before-completion");
        if (executing) targetSkills.push(executing);
        if (subagent) targetSkills.push(subagent);
        if (verification) targetSkills.push(verification);
      }

      // Track management guidelines: only load if track is query-relevant
      const hasTrackQuery = userQuery && /track|milestone/i.test(userQuery);
      if (hasTrackQuery) {
        const track = Agent.MANDATORY_SKILLS.find(s => s.key === "track-management");
        if (track) targetSkills.push(track);
      }

      // Debugging guidelines: only load if query mentions debugging/error terms
      const hasDebugQuery = userQuery && /debug|error|fail|bug|crash|incorrect|fix|issue|broken|slow|diagnose/i.test(userQuery);
      if (hasDebugQuery) {
        const debugging = Agent.MANDATORY_SKILLS.find(s => s.key === "systematic-debugging");
        if (debugging) targetSkills.push(debugging);
      }

      // Master agent orchestration: only load for master agent tier
      if (this.tier === "master") {
        const orchestration = Agent.MASTER_ONLY_SKILLS.find(s => s.key === "master-agent-orchestration");
        if (orchestration) targetSkills.push(orchestration);
      }

      // Clear preloaded keys for this construction turn
      this.preloadedSkillKeys.clear();

      for (const skill of targetSkills) {
        let trimmedContent = this.skillContentCache.get(skill.key) || "";
        if (!trimmedContent) {
          const candidatePaths = [
            path.join(process.cwd(), ".agents", "skills", skill.key, "SKILL.md"),
            path.join(this.workingDirectory, ".agents", "skills", skill.key, "SKILL.md"),
            path.join(getPackageRootDir(), ".agents", "skills", skill.key, "SKILL.md"),
          ];
          for (const p of candidatePaths) {
            if (fs.existsSync(p)) {
              const rawContent = fs.readFileSync(p, "utf-8");
              // Trim body to MAX_SKILL_LINES, preserving YAML frontmatter
              trimmedContent = Agent.trimSkillContent(rawContent, p);
              this.skillContentCache.set(skill.key, trimmedContent);
              break;
            }
          }
        }

        if (trimmedContent) {
          text += `\n\n${skill.label}:\n${trimmedContent}\n`;
          this.preloadedSkillKeys.add(skill.key);
        }
      }
    } catch {
      // Ignore guideline loading errors — non-critical
    }

    return text;
  }


  /**
   * Mark already-preloaded skill entries in the INSTALLED AGENT SKILLS list.
   * This prevents the AI from wasting tokens re-reading skill files whose content
   * is already injected earlier in the same system prompt.
   */
  private markPreloadedSkillsInList(skillsPrompt: string): string {
    if (this.preloadedSkillKeys.size === 0) return skillsPrompt;
    let result = skillsPrompt;
    for (const key of this.preloadedSkillKeys) {
      // Match "Instruction File: <path>" lines containing this skill key in the path
      const escapedKey = key.replace(/[-]/g, "[-]");
      const regex = new RegExp(
        `(Instruction File: [^\\n]*${escapedKey}[^\\n]*)`,
        "gi"
      );
      result = result.replace(
        regex,
        `$1 [Content already loaded in context above — no need to re-read]`
      );
    }
    return result;
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
    if (this.customTools) return this.customTools;
    const { masterToolset, superagentToolset, subagentToolsets, defaultSubagentToolset } = await import("./tools/toolsets.js");
    if (this.tier === "master") {
      return masterToolset;
    } else if (this.tier === "superagent" || this.tier === "single") {
      return superagentToolset;
    } else if (this.tier === "subagent") {
      return (this.subagentType && subagentToolsets[this.subagentType]) || defaultSubagentToolset;
    }
    return [];
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
        if (!this.disableWorkspaceDiscovery && this.tier !== "subagent") {
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

        const systemPrompt = `${activeSystemPrompt}

CRITICAL TASK EXECUTION CONTEXT:
- You are running with a strict step limit of ${maxIterationsStr} agent iterations per request.
- Be highly efficient. DO NOT try to do everything in a single sequential thread.
- MANDATORY: For any task that is complex, multi-step, or touches multiple files/components — you MUST spawn subagents via 'invoke_subagent'. Doing it yourself is forbidden for such tasks.
- Spawn subagents in parallel whenever tasks are independent. This is the primary way to complete large tasks within the iteration limit.
- After spawning, wait for results, integrate them, and report back to the user.
${singleModeSubagentDirective}${goalModeAddendum}${guidelinesText}${processNotice}${pinnedKnowledgeNotice}${devHookNotice}${sharedMemoryNotice}${workspaceBoundaryNotice}`;

        // Build dynamic context to inject into messages array
        const stepsRemaining = maxIterations === Infinity ? Infinity : (maxIterations - currentStep);
        const stepNotice = stepsRemaining <= 5
          ? `\n- Current Step: ${currentStep} of ${maxIterationsStr} (WARNING: Only ${stepsRemaining} steps remaining!)`
          : "";
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

        const dynamicContext = `\n\n[DYNAMIC EXECUTION CONTEXT]${stepNotice}${scratchpadText ? `\n\nPERSISTENT SCRATCHPAD MEMORY:\n${scratchpadText}` : ""}${workspaceStateText}${planStateNotice}${planStateAddendum}${followUpTaskAddendum}`;

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
        injectDynamicContext(messages);

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
          // Estimate system prompt tokens (conservative ~3 chars/token for code-heavy text)
          const estSysTokens = Math.ceil(systemPrompt.length / 3);
          const estMsgTokens = this.conversation.getTokenEstimate() + Math.ceil(dynamicContext.length / 3);
          const estTotal = estMsgTokens + estSysTokens;
          if (estTotal > safetyMax) {
            const overshootPct = Math.round((estTotal / modelLimit) * 100);
            this.writeToLogFile("WARN", `Pre-flight context check: estimated ~${estTotal.toLocaleString()} total tokens (${overshootPct}% of ${modelLimit.toLocaleString()} limit). Compact threshold: ${safetyMax.toLocaleString()}. Triggering emergency compaction.`);
            await this.compactHistoryIfNeeded(signal);
            // Rebuild messages from compacted conversation
            messages = this.buildMessages(supportsNativeTools);
            injectDynamicContext(messages);
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
            const toolDefsForPrompt = toolDefs.map((t) => ({
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

        let textContent = "";
        let reasoningContent = ""; // DeepSeek R1 thinking tokens — displayed in UI but NOT stored in history
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
              const modelInstance = this.getModel();
              const isTest = !!process.env.VITEST;
              const isAnthropic = !isTest && modelInstance && (modelInstance.provider === "anthropic" || (typeof modelInstance.provider === "string" && modelInstance.provider.includes("anthropic")));

              const result = await generateText({
                model: modelInstance,
                system: finalSystemPrompt,
                messages,
                ...(supportsNativeTools && {
                  tools: Object.fromEntries(
                    toolDefs.map((t) => [
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
              if (textContent) {
                if (!supportsNativeTools) {
                  try {
                    const { parseXmlToolCalls } = await import("../utils/xmlToolParser.js");
                    const parsed = parseXmlToolCalls(textContent, toolDefs);
                    if (parsed.toolCalls.length > 0) {
                      this.writeToLogFile(
                        "INFO",
                        `Parsed ${parsed.toolCalls.length} XML tool calls from non-streamed response`
                      );
                      toolCalls.push(...parsed.toolCalls);
                      textContent = parsed.cleanText;
                    }
                  } catch (err: any) {
                    this.writeToLogFile("WARN", `Failed to parse XML tool calls: ${err.message}`);
                  }
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
              const isOverloaded = rawMsg.toLowerCase().includes("our servers are currently overloaded") || rawMsg.toLowerCase().includes("overloaded_error");
              const isEmptyResponse = err instanceof Error && err.message === "Empty response from model";
              const isRetryable = isRetryableError(err) || isEmptyResponse || isOverloaded;
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
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${rawMsg}. Retrying attempt ${attempt}/${currentMaxRetries}...\n` });
              let delayMs = baseDelay * Math.pow(2, attempt - 1);
              if (isEmptyResponse) {
                if (attempt === 1) delayMs = 10000;
                else if (attempt === 2) delayMs = 20000;
                else if (attempt === 3) delayMs = 50000;
              } else if (isOverloaded) {
                const overloadedDelays = [5000, 10000, 20000, 50000, 100000];
                delayMs = overloadedDelays[attempt - 1] ?? 100000;
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

              const result = streamText({
                model: modelInstance,
                system: finalSystemPrompt,
                messages,
                ...(supportsNativeTools && {
                  tools: Object.fromEntries(
                    toolDefs.map((t) => [
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
              if (!supportsNativeTools) {
                const { StreamXmlFilter } = await import("../utils/xmlToolParser.js");
                xmlFilter = new StreamXmlFilter((text) => {
                  this.onEvent({ type: "text", content: text });
                }, toolDefs);
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
              const isOverloaded = rawMsg.toLowerCase().includes("our servers are currently overloaded") || rawMsg.toLowerCase().includes("overloaded_error");
              const isEmptyResponse = err instanceof Error && err.message === "Empty response from model";
              const isRetryable = isRetryableError(err) || isEmptyResponse || isOverloaded;
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
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${rawMsg}. Retrying attempt ${attempt}/${currentMaxRetries}...\n` });
              let delayMs = baseDelay * Math.pow(2, attempt - 1);
              if (isEmptyResponse) {
                if (attempt === 1) delayMs = 10000;
                else if (attempt === 2) delayMs = 20000;
                else if (attempt === 3) delayMs = 50000;
              } else if (isOverloaded) {
                const overloadedDelays = [5000, 10000, 20000, 50000, 100000];
                delayMs = overloadedDelays[attempt - 1] ?? 100000;
              }
              await this.delayWithCountdown(attempt, delayMs, signal);
            } finally {
              if (concurrencyAcquired) {
                concurrencyLimiter.release();
              }
            }
          }
        }
        if (toolCalls.length === 0 && textContent.trim()) {
          try {
            const { parseXmlToolCalls } = await import("../utils/xmlToolParser.js");
            const parsed = parseXmlToolCalls(textContent, toolDefs);
            if (parsed.toolCalls.length > 0) {
              this.writeToLogFile(
                "INFO",
                `Parsed ${parsed.toolCalls.length} XML tool calls from model response text`
              );
              toolCalls.push(...parsed.toolCalls);
              textContent = parsed.cleanText;
            }
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
      if (isGoalMode && this.goalMode) {
        this.onEvent({
          type: "goal_done",
          goal: this.goalMode,
          summary: "Agent has finished executing. Check the output above for GOAL_COMPLETE or GOAL_PARTIAL status.",
        });
      }
    }
  }

  private modelSupportsVision(modelName: string): boolean {
    if (!modelName) return false;
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

  private buildMessages(supportsNativeTools = true): CoreMessage[] {
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

    for (const m of this.conversation.getMessages()) {
      if (m.role === "system") continue;

      if (m.role === "user") {
        // Map MessageContent (string | Part[]) to Vercel AI SDK CoreMessage format
        const sdkContent: string | Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> =
          typeof m.content === "string"
            ? m.content
            : (m.content as any[]).map((p: any) => {
                if (p.type === "image") {
                  if (supportsVision) {
                    return { type: "image" as const, image: p.image, mimeType: p.mimeType };
                  }
                  return {
                    type: "text" as const,
                    text: `[Image: (${p.mimeType || "unknown type"}) - not sent because the active model (${modelName || "unknown"}) does not support vision/images. Base64 Data: data:${p.mimeType || "image/png"};base64,${p.image}]`
                  };
                }
                return { type: "text" as const, text: p.text };
              });
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
          coreMessages.push({
            role: "user",
            content: resultText,
          });
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

      const result = await contextManager.compact(messages, undefined, signal);

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
