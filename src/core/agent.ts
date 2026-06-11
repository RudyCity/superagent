import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import fs from "fs";
import { getConfig, getContextWindowLimit, getGlobalConfigDir, ensureGlobalConfigDir } from "./config.js";
import { Conversation } from "./conversation.js";
import { getToolDefinitions } from "./tools.js";
import {
  executeToolCall,
  getToolDescription,
  isDangerousCommand,
  MODIFYING_TOOLS,
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
  | { type: "token_usage"; promptTokens: number; completionTokens: number };

export type PermissionHandler = (
  toolCall: ToolCall,
  description: string
) => Promise<boolean>;

export type QuestionHandler = (
  question: string,
  options: string[]
) => Promise<string>;

export class Agent {
  public delegationDepth = 0;
  public planState: "IDLE" | "PLANNING_PENDING" | "APPROVED" = "IDLE";
  public goalMode: string | null = null;
  public goalMaxIterations: number = 200;
  private conversation: Conversation;
  private customSystemPrompt?: string;
  private get config() {
    return getConfig();
  }
  private onEvent: (event: AgentEvent) => void;
  private onPermission: PermissionHandler;
  private onQuestion: QuestionHandler;
  private abortController: AbortController | null = null;
  private isRunning = false;

  public approvePlan(): void {
    this.planState = "APPROVED";
  }

  constructor(
    onEvent: (event: AgentEvent) => void,
    onPermission: PermissionHandler,
    onQuestion: QuestionHandler,
    customSystemPrompt?: string
  ) {
    this.customSystemPrompt = customSystemPrompt;
    this.conversation = new Conversation();
    this.onEvent = (event: AgentEvent) => {
      if (event.type === "error") {
        this.writeToLogFile(event.message);
      } else if (event.type === "tool_end" && event.toolResult.isError) {
        this.writeToLogFile(`Tool '${event.toolResult.name}' failed: ${event.toolResult.result}`);
      }
      onEvent(event);
    };
    this.onPermission = onPermission;
    this.onQuestion = onQuestion;
  }

  private writeToLogFile(message: string): void {
    try {
      ensureGlobalConfigDir();
      const logPath = path.join(getGlobalConfigDir(), "superagent.log");
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [ERROR] ${message}\n`;
      fs.appendFileSync(logPath, logMessage, "utf-8");
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

  private resolveHistoryFilePath(autoResume: boolean): string {
    ensureGlobalConfigDir();
    const sanitizedPath = this.config.workingDirectory.replace(/[^a-zA-Z0-9]/g, "_");
    const historyDir = path.join(getGlobalConfigDir(), "history");

    if (autoResume) {
      try {
        const files = fs.readdirSync(historyDir);
        const matchedFiles = files.filter(f => {
          if (!f.endsWith(".json")) return false;
          const nameWithoutExt = f.replace(/\.json$/, "").toLowerCase();
          return nameWithoutExt === sanitizedPath.toLowerCase() || nameWithoutExt.startsWith(sanitizedPath.toLowerCase() + "_");
        });

        if (matchedFiles.length > 0) {
          const sorted = matchedFiles.map(f => {
            const filePath = path.join(historyDir, f);
            const stat = fs.statSync(filePath);
            return { filePath, mtime: stat.mtime.getTime() };
          }).sort((a, b) => b.mtime - a.mtime);

          return sorted[0].filePath;
        }
      } catch {
        // Ignore and generate a new one
      }
    }

    return path.join(historyDir, `${sanitizedPath}_${Date.now()}.json`);
  }

  public getCurrentHistoryFilePath(): string {
    if (!this.currentHistoryFilePath) {
      this.currentHistoryFilePath = this.resolveHistoryFilePath(false);
    }
    return this.currentHistoryFilePath;
  }

  async loadHistory(autoResume = false): Promise<void> {
    this.currentHistoryFilePath = this.resolveHistoryFilePath(autoResume);
    await this.conversation.loadFromFile(this.currentHistoryFilePath);
    if (this.conversation.loadedPlanState) {
      this.planState = this.conversation.loadedPlanState;
    }
  }

  async loadHistoryFromPath(filePath: string): Promise<void> {
    this.currentHistoryFilePath = filePath;
    await this.conversation.loadFromFile(filePath);
    if (this.conversation.loadedPlanState) {
      this.planState = this.conversation.loadedPlanState;
    }
  }

  async saveHistory(): Promise<void> {
    if (!this.currentHistoryFilePath) {
      this.currentHistoryFilePath = this.resolveHistoryFilePath(false);
    }
    await this.conversation.saveToFile(this.currentHistoryFilePath, this.planState);
  }

  private getModel() {
    if (this.config.provider === "anthropic") {
      const anthropic = createAnthropic({ apiKey: this.config.apiKey });
      return anthropic(this.config.model);
    }
    const openai = createOpenAI({
      apiKey: this.config.apiKey,
      ...(this.config.baseUrl && { baseURL: this.config.baseUrl }),
      headers: {
        "HTTP-Referer": "https://github.com/RudyCity/superagent",
        "X-Title": "SuperAgent CLI",
      },
    });
    return openai(this.config.model);
  }

  async sendMessage(userInput: string): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    this.conversation.addUserMessage(userInput);
    await this.compactHistoryIfNeeded();
    await this.saveHistory();

    try {
      await agentLocalStorage.run(this, () => this.runAgentLoop());
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        this.onEvent({ type: "text", content: "\n\n[Interrupted]" });
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.onEvent({ type: "error", message });
      }
    } finally {
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

    const baseSystemPrompt = this.customSystemPrompt || this.config.systemPrompt;

    // Load scratchpad content if it exists
    let scratchpadText = "";
    try {
      const scratchpadPath = path.resolve(this.config.workingDirectory, "scratch", "scratchpad.md");
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
        await this.compactHistoryIfNeeded();
        const messages = this.buildMessages();
        const toolDefs = getToolDefinitions();

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
        const systemPrompt = `${baseSystemPrompt}

CRITICAL TASK EXECUTION CONTEXT:
- You are running with a strict step limit of ${maxIterations} agent iterations per request.
- Current Step: ${currentStep} of ${maxIterations}.
- Be highly efficient. If the task is complex, requires multiple steps, or involves extensive research/coding across different components, DO NOT try to do everything in a single sequential thread.
- Instead, immediately plan and delegate subtasks to specialized subagents (e.g., 'researcher', 'coder', 'reviewer') via 'invoke_subagent' to run tasks in parallel.
- Spawning subagents is the recommended way to solve large tasks within the iteration limit. Ensure you check subagent statuses and integrate their results.
${scratchpadText ? `\n\nPERSISTENT SCRATCHPAD MEMORY:\n${scratchpadText}` : ""}${goalModeAddendum}${planStateNotice}${planStateAddendum}`;

        let textContent = "";
        const toolCalls: ToolCall[] = [];

        if (this.config.disableStreaming) {
          let attempt = 0;
          const maxRetries = 3;
          const baseDelay = 1000;

          while (true) {
            try {
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
              const usage = result.usage;
              if (usage) {
                this.onEvent({
                  type: "token_usage",
                  promptTokens: usage.promptTokens,
                  completionTokens: usage.completionTokens,
                });
              }
              break;
            } catch (err: unknown) {
              if (err instanceof Error && err.name === "AbortError") {
                throw err;
              }
              attempt++;
              if (attempt > maxRetries) {
                const msg = err instanceof Error ? err.message : String(err);
                this.onEvent({ type: "error", message: `Generate text failed after ${maxRetries} retries: ${msg}` });
                return;
              }
              const msg = err instanceof Error ? err.message : String(err);
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${msg}. Retrying attempt ${attempt}/${maxRetries}...\n` });
              await this.delayWithCountdown(attempt, baseDelay * Math.pow(2, attempt - 1));
            }
          }
        } else {
          let attempt = 0;
          const maxRetries = 3;
          const baseDelay = 1000;

          while (true) {
            try {
              textContent = "";
              toolCalls.length = 0;

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
                if (usage) {
                  this.onEvent({
                    type: "token_usage",
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                  });
                }
              } catch (err) {
                // Ignore or log error silently
              }

              break;
            } catch (err: unknown) {
              if (err instanceof Error && err.name === "AbortError") {
                throw err;
              }
              attempt++;
              if (attempt > maxRetries) {
                const msg = err instanceof Error ? err.message : String(err);
                this.onEvent({ type: "error", message: `Stream error after ${maxRetries} retries: ${msg}` });
                return;
              }
              const msg = err instanceof Error ? err.message : String(err);
              this.onEvent({ type: "text", content: `\n[SYS] Communication error: ${msg}. Retrying attempt ${attempt}/${maxRetries}...\n` });
              await this.delayWithCountdown(attempt, baseDelay * Math.pow(2, attempt - 1));
            }
          }
        }

        if (toolCalls.length === 0) {
          if (!textContent.trim()) {
            this.onEvent({
              type: "error",
              message: "Empty response from model. Check your endpoint/model config.",
            });
          } else {
            this.conversation.addAssistantMessage(textContent);
            await this.saveHistory();
          }
          break;
        }

        const toolResults: ToolResult[] = [];

        for (const tc of toolCalls) {
          const description = getToolDescription(tc);
          this.onEvent({ type: "tool_start", toolCall: tc, description });

          if (tc.name === "ask_question") {
            const question = tc.args.question as string || "";
            const rawOptions = (tc.args.options as unknown[]) || [];
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
              const selected = await this.onQuestion(question, options);
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

          if (MODIFYING_TOOLS.includes(tc.name)) {
            const filePath = tc.args.filePath as string || tc.args.TargetFile as string || "";
            const planFilePath = this.getPlanFilePath();
            const isPlanFile = filePath && path.resolve(filePath).toLowerCase() === path.resolve(planFilePath).toLowerCase();

            if (isPlanFile) {
              const planContent = (tc.args.content as string || tc.args.codeContent as string || tc.args.CodeContent as string || "").trim();
              const hasProposedChanges = /proposed\s+changes/i.test(planContent) || /rencana\s+perubahan/i.test(planContent);
              const hasVerificationPlan = /verification\s+plan/i.test(planContent) || /rencana\s+verifikasi/i.test(planContent);
              const hasTitle = /^#\s+.+/m.test(planContent);

              if (!hasTitle || (!hasProposedChanges && !hasVerificationPlan)) {
                const blocked: ToolResult = {
                  toolCallId: tc.id,
                  name: tc.name,
                  result: "Error: The implementation plan is invalid or lacks structure. A valid plan must include a main title (e.g., '# Goal Description') and sections for 'Proposed Changes' and 'Verification Plan'. Please rewrite the plan with these sections included.",
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
            } else if (this.planState === "PLANNING_PENDING") {
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

          const toolResult = await executeToolCall(
            tc,
            this.config.workingDirectory,
            this.abortController?.signal
          );
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
    const maxRetries = 3;
    const baseDelay = 1000;
    let result;

    while (true) {
      try {
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
        await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt - 1)));
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
