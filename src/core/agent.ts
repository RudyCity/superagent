import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import fs from "fs";
import { getConfig, getContextWindowLimit, getGlobalConfigDir, ensureGlobalConfigDir, getModelInstanceForTier, getModelInstanceForString, loadAgentSkills } from "./config.js";
import { Conversation } from "./conversation.js";
import { getToolDefinitions, backgroundTasks } from "./tools.js";
import type { Tool, AgentTier } from "./tools.js";
import { rateLimiter, concurrencyLimiter } from "./rateLimiter.js";
import {
  executeToolCall,
  getToolDescription,
  isDangerousCommand,
  MODIFYING_TOOLS,
  isSuperagentOutOfBounds,
} from "./permissions.js";
import type { ToolCall, ToolResult } from "./conversation.js";
import { AsyncLocalStorage } from "async_hooks";

export const agentLocalStorage = new AsyncLocalStorage<Agent>();

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_start"; toolCall: ToolCall; description: string }
  | { type: "tool_end"; toolResult: ToolResult; description: string }
  | { type: "error"; message: string }
  | { type: "done" }
  | { type: "goal_done"; goal: string; summary: string }
  | { type: "permission_required"; toolCall: ToolCall; description: string }
  | { type: "token_usage"; promptTokens: number; completionTokens: number; durationMs?: number };

export type PermissionHandler = (
  toolCall: ToolCall,
  description: string
) => Promise<boolean>;

export type QuestionHandler = (
  question: string,
  options: string[],
  isMultiSelect?: boolean
) => Promise<string>;

function isRetryableError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const msg = err.message.toLowerCase();
    
    const statusCode = (err as any).statusCode || (err as any).status;
    if (statusCode === 401 || statusCode === 403 || statusCode === 400) {
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
      msg.includes("missing authentication header")
    ) {
      return false;
    }
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
  public lastSpeed: number | null = null;
  public goalMode: string | null = null;
  public goalMaxIterations: number = 200;
  public wasRunningBeforeAbort = false;
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
  private textLogBuffer = "";

  public approvePlan(): void {
    this.planState = "APPROVED";
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
      }
      onEvent(event);
    };
    this.onPermission = onPermission;
    this.onQuestion = onQuestion;
  }

  public writeToLogFile(level: string, message: string): void {
    try {
      ensureGlobalConfigDir();
      const logPath = path.join(getGlobalConfigDir(), "superagent.log");
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [tier:${this.tier}] [depth:${this.delegationDepth}] [multi:${this.isMultiAgent}] [${level}]`;
      const lines = message.split("\n");
      const formattedLines = lines.map(line => `${prefix} ${line}`).join("\n") + "\n";
      fs.appendFileSync(logPath, formattedLines, "utf-8");
    } catch (err) {
      // Ignore log write errors to prevent crashing the agent
    }
  }

  private currentHistoryFilePath: string | null = null;

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
            return nameLower === sanitizedPath.toLowerCase() || nameLower.startsWith(sanitizedPath.toLowerCase() + "_");
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

            return sorted[0].filePath;
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
    await this.conversation.saveToFile(this.currentHistoryFilePath, this.planState);
  }

  private getModel() {
    return getModelInstanceForTier(this.tier, this.delegationDepth, this.subagentType, !this.isMultiAgent);
  }

  async sendMessage(userInput: string): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    this.writeToLogFile("INFO", `Agent execution started (tier: ${this.tier}, depth: ${this.delegationDepth}, isMultiAgent: ${this.isMultiAgent}, workingDirectory: ${this.workingDirectory}, worktreePath: ${this.worktreePath})`);
    this.writeToLogFile("INFO", `Received user message: "${userInput}"`);

    this.conversation.addUserMessage(userInput);
    await this.compactHistoryIfNeeded();
    await this.saveHistory();

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
        const message = err instanceof Error ? err.message : String(err);
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
      this.onEvent({ type: "done" });
    }
  }

  private async runAgentLoop(): Promise<void> {
    const isGoalMode = !!this.goalMode;
    const defaultMax = parseInt(process.env.MAX_ITERATIONS || "50", 10) || 50;
    const maxIterations = isGoalMode ? this.goalMaxIterations : defaultMax;
    let continueCount = 0;
    // In goal mode, allow many more auto-continues without prompting the user
    const maxContinues = isGoalMode ? 10 : 3;

    let baseSystemPrompt = this.customSystemPrompt || this.config.systemPrompt;
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
      for (const p of searchPaths) {
        if (fs.existsSync(p)) {
          guidelinesText += `\n\nPROJECT GUIDELINES (agents.md):\n${fs.readFileSync(p, "utf-8")}\n`;
          break;
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
        if (this.abortController?.signal.aborted) {
          const err = new Error("AbortError");
          err.name = "AbortError";
          throw err;
        }
        await this.compactHistoryIfNeeded();
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

        const planStateNotice = `

PLANNING, TASKS & VERIFICATION FILES FOR THIS SESSION:
You MUST write/read the planning lifecycle documents at these exact absolute paths for this specific conversation history:
- Implementation Plan File: ${this.getPlanFilePath()}
- Task Tracking File: ${this.getTaskFilePath()}
- Verification/Walkthrough File: ${this.getWalkthroughFilePath()}

Whenever you reference these files in your thoughts or messages to the user, always use their absolute paths or format them as absolute file:/// links so the user can click and open them directly.
Do NOT write them in the local workspace directory. Always write/read to/from these global paths.`;

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

        const currentStep = i + 1;
        const runningProcesses = Array.from(backgroundTasks.entries())
          .filter(([_, t]) => !t.hasExited)
          .map(([id, t]) => `- Process ID: ${id}, Command: "${t.command}"`)
          .join("\n");
        const processNotice = runningProcesses
          ? `\n\n⚙️ RUNNING BACKGROUND/TERMINAL PROCESSES:\nYou are aware that the following background/terminal processes are currently running in the environment:\n${runningProcesses}`
          : "";

        const systemPrompt = `${baseSystemPrompt}

CRITICAL TASK EXECUTION CONTEXT:
- You are running with a strict step limit of ${maxIterations} agent iterations per request.
- Current Step: ${currentStep} of ${maxIterations}.
- Be highly efficient. If the task is complex, requires multiple steps, or involves extensive research/coding across different components, DO NOT try to do everything in a single sequential thread.
- Instead, immediately plan and delegate subtasks to specialized subagents (e.g., 'researcher', 'coder', 'reviewer') via 'invoke_subagent' to run tasks in parallel.
- Spawning subagents is the recommended way to solve large tasks within the iteration limit. Ensure you check subagent statuses and integrate their results.
${scratchpadText ? `\n\nPERSISTENT SCRATCHPAD MEMORY:\n${scratchpadText}` : ""}${goalModeAddendum}${guidelinesText}${planStateNotice}${planStateAddendum}${processNotice}`;

        let textContent = "";
        const toolCalls: ToolCall[] = [];

        if (this.config.disableStreaming) {
          let attempt = 0;
          const maxRetries = 10;
          const baseDelay = 5000;

          while (true) {
            let concurrencyAcquired = false;
            try {
              if (process.env.SUPERAGENT_MAX_CONCURRENCY === "1") {
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
                abortSignal: this.abortController?.signal,
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
                const rawMsg = err instanceof Error ? err.message : String(err);
                const msg = rawMsg === "Empty response from model"
                  ? "Empty response from model. Check your endpoint/model config."
                  : rawMsg;
                const prefixMsg = !isRetryable ? "Fatal error" : `Generate text failed after ${maxRetries} retries`;
                const errMsg = `${prefixMsg}: ${msg}`;
                this.onEvent({ type: "error", message: errMsg });
                this.conversation.addMessage({
                  role: "system",
                  content: `[ERROR] ${errMsg}`,
                  timestamp: Date.now(),
                });
                await this.saveHistory();
                return;
              }
              const msg = err instanceof Error ? err.message : String(err);
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${msg}. Retrying attempt ${attempt}/${maxRetries}...\n` });
              await this.delayWithCountdown(attempt, baseDelay * Math.pow(2, attempt - 1));
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
              if (process.env.SUPERAGENT_MAX_CONCURRENCY === "1") {
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
                abortSignal: this.abortController?.signal,
              });

              for await (const delta of result.fullStream) {
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
                  throw delta.error instanceof Error ? delta.error : new Error(String(delta.error));
                }
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
                const rawMsg = err instanceof Error ? err.message : String(err);
                const msg = rawMsg === "Empty response from model"
                  ? "Empty response from model. Check your endpoint/model config."
                  : rawMsg;
                const prefixMsg = !isRetryable ? "Fatal error" : `Stream error after ${maxRetries} retries`;
                const errMsg = `${prefixMsg}: ${msg}`;
                this.onEvent({ type: "error", message: errMsg });
                this.conversation.addMessage({
                  role: "system",
                  content: `[ERROR] ${errMsg}`,
                  timestamp: Date.now(),
                });
                await this.saveHistory();
                return;
              }
              const msg = err instanceof Error ? err.message : String(err);
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${msg}. Retrying attempt ${attempt}/${maxRetries}...\n` });
              await this.delayWithCountdown(attempt, baseDelay * Math.pow(2, attempt - 1));
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
          if (this.abortController?.signal.aborted) {
            const err = new Error("AbortError");
            err.name = "AbortError";
            throw err;
          }
          const description = getToolDescription(tc);
          this.onEvent({ type: "tool_start", toolCall: tc, description });

          if (tc.name === "ask_question") {
            let question = tc.args.question as string || "";
            let rawOptionsVal = tc.args.options;
            let isMultiSelect = tc.args.isMultiSelect as boolean | undefined;

            if (Array.isArray(tc.args.questions) && tc.args.questions.length > 0) {
              const firstQ = tc.args.questions[0];
              if (firstQ && typeof firstQ === "object") {
                const firstQObj = firstQ as Record<string, unknown>;
                if (typeof firstQObj.question === "string") {
                  question = firstQObj.question;
                }
                if (firstQObj.options !== undefined) {
                  rawOptionsVal = firstQObj.options;
                }
                if (typeof firstQObj.is_multi_select === "boolean") {
                  isMultiSelect = firstQObj.is_multi_select;
                } else if (typeof firstQObj.isMultiSelect === "boolean") {
                  isMultiSelect = firstQObj.isMultiSelect;
                }
              }
            }

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
              const blocked: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `Error: Task Tracking File is missing at '${taskFilePath}'. Write a task checklist to this exact file before spawning or merging Superagents.`,
                isError: true,
              };
              toolResults.push(blocked);
              this.onEvent({ type: "tool_end", toolResult: blocked, description });
              continue;
            }
          }

          if (MODIFYING_TOOLS.includes(tc.name)) {
            const filePath = tc.args.filePath as string || tc.args.TargetFile as string || "";
            const planFilePath = this.getPlanFilePath();
            const taskFilePath = this.getTaskFilePath();
            const walkthroughFilePath = this.getWalkthroughFilePath();
            const isPlanFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(planFilePath).toLowerCase();
            const isTaskFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(taskFilePath).toLowerCase();
            const isWalkthroughFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(walkthroughFilePath).toLowerCase();

            if (this.tier === "master" && !isPlanFile && !isTaskFile && !isWalkthroughFile) {
              const blocked: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: "Error: The Master Agent is restricted from directly modifying source code files in the codebase. You must delegate all code modifications to Superagents by invoking them.",
                isError: true,
              };
              toolResults.push(blocked);
              this.onEvent({ type: "tool_end", toolResult: blocked, description });
              continue;
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

              const hasTitle = /^#\s+.+/m.test(planContent);
              const hasProposedChanges = /##\s+(proposed\s+changes|rencana\s+perubahan)/i.test(planContent);
              const hasVerificationPlan = /##\s+(verification\s+plan|rencana\s+verifikasi)/i.test(planContent);
              const hasAutomatedTests = /###\s+(automated\s+tests|test\s+otomatis)/i.test(planContent);
              const hasManualVerification = /###\s+(manual\s+verification|verifikasi\s+manual|manual\s+testing)/i.test(planContent);

              const missing: string[] = [];
              if (!hasTitle) missing.push("Main Title (e.g., '# Goal Description')");
              if (!hasProposedChanges) missing.push("Proposed Changes section ('## Proposed Changes')");
              if (!hasVerificationPlan) missing.push("Verification Plan section ('## Verification Plan')");
              if (!hasAutomatedTests) missing.push("Automated Tests sub-section ('### Automated Tests')");
              if (!hasManualVerification) missing.push("Manual Verification sub-section ('### Manual Verification')");

              if (this.tier === "master") {
                const hasSuperagentOrDelegate = /superagent|spawning|delegate|worktree/i.test(planContent);
                if (!hasSuperagentOrDelegate) {
                  missing.push("References to Superagent spawning or task delegation (the Master Agent cannot edit codebase files directly, so the 'Proposed Changes' section MUST detail the Superagents to be spawned, their roles, and branch names)");
                }
              }

              if (missing.length > 0) {
                const blocked: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: `Error: The implementation plan is invalid or lacks deep structure. A valid global plan must include:\n${missing.map(m => `- ${m}`).join("\n")}\n\nPlease rewrite the plan with all required sections and headers included.`,
                  isError: true,
                };
                toolResults.push(blocked);
                this.onEvent({ type: "tool_end", toolResult: blocked, description });
                continue;
              }

              if (this.goalMode) {
                this.planState = "APPROVED";
                this.onEvent({ type: "text", content: "\n[SYS] Goal Mode active: Auto-approving implementation plan for autonomous execution.\n" });
              } else {
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
                const hasSuperagentOrSpawnOrMerge = /superagent|spawn|merge|worktree/i.test(taskContent);
                if (!hasSuperagentOrSpawnOrMerge) {
                  const blocked: ToolResult = {
                    toolCallId: tc.id,
                    name: tc.name,
                    result: `Error: The Task Tracking File is invalid or lacks multi-agent context. As the Master Agent, your task list MUST include items for spawning, monitoring, and merging Superagents (e.g., 'spawning superagent', 'merge superagents') instead of listing direct file modifications.`,
                    isError: true,
                  };
                  toolResults.push(blocked);
                  this.onEvent({ type: "tool_end", toolResult: blocked, description });
                  continue;
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
                toolResults.push(blocked);
                this.onEvent({ type: "tool_end", toolResult: blocked, description });
                continue;
              }
            }

            if (isDangerousCommand(tc.args.command as string)) {
              const approved = await this.onPermission(tc, description);
              if (!approved) {
                const denied: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: "User denied permission for this command.",
                  isError: true,
                };
                toolResults.push(denied);
                this.onEvent({ type: "tool_end", toolResult: denied, description });
                continue;
              }
            }
          }

          // Superagent out-of-bounds file access check
          if (this.tier === "superagent" && this.worktreePath) {
            if (isSuperagentOutOfBounds(tc, this.worktreePath)) {
              const blocked: ToolResult = {
                toolCallId: tc.id,
                name: tc.name,
                result: `Error: Access denied. As a Superagent you may only access files within your worktree: ${this.worktreePath}`,
                isError: true,
              };
              toolResults.push(blocked);
              this.onEvent({ type: "tool_end", toolResult: blocked, description });
              continue;
            }
          }

          // Use worktreePath as CWD for superagents, otherwise use configured workingDirectory
          const effectiveCwd = (this.tier === "superagent" && this.worktreePath)
            ? this.worktreePath
            : this.workingDirectory;

          const toolResult = await executeToolCall(
            tc,
            effectiveCwd,
            this.abortController?.signal
          );
          if (this.abortController?.signal.aborted) {
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
        coreMessages.push({
          role: "user",
          content: m.content,
        });
      } else if (m.role === "assistant") {
        const hasToolCalls = m.toolCalls && m.toolCalls.length > 0;
        if (hasToolCalls) {
          const contentParts: Array<
            | { type: "text"; text: string }
            | { type: "tool-call"; toolCallId: string; toolName: string; args: unknown }
          > = [];

          if (m.content) {
            contentParts.push({ type: "text", text: m.content });
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
            content: m.content,
          });
        }
      } else if (m.role === "tool") {
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

  async compactHistoryIfNeeded(): Promise<void> {
    const modelLimit = getContextWindowLimit(this.config.model);
    const maxHistoryTokens = Math.floor(modelLimit * 0.5);

    if (this.conversation.getTokenEstimate() > maxHistoryTokens) {
      const allMsgs = this.conversation.getMessages();
      if (allMsgs.length > 20) {
        const toSummarize = allMsgs.slice(0, 20);
        try {
          const summary = await this.summarizeMessages(toSummarize);
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

  private async summarizeMessages(messages: any[]): Promise<string> {
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
        if (process.env.SUPERAGENT_MAX_CONCURRENCY === "1") {
          await concurrencyLimiter.acquire();
          concurrencyAcquired = true;
        }
        await rateLimiter.acquire(1);

        result = await generateText({
          model: this.getModel(),
          system: "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
          prompt,
          abortSignal: this.abortController?.signal,
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
        const summarySignal = this.abortController?.signal;
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

  private async delayWithCountdown(attempt: number, delayMs: number): Promise<void> {
    const delaySec = Math.ceil(delayMs / 1000);
    const signal = this.abortController?.signal;
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
    this.abortController?.abort();
  }

  async clearHistory(): Promise<void> {
    this.conversation.clear();
    this.currentHistoryFilePath = this.resolveHistoryFilePath(false);
    await this.saveHistory();
  }

  getHistory(): Conversation {
    return this.conversation;
  }

  isAgentRunning(): boolean {
    return this.isRunning;
  }
}
