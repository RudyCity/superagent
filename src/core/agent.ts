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

export type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_start"; toolCall: ToolCall; description: string }
  | { type: "tool_end"; toolResult: ToolResult; description: string }
  | { type: "error"; message: string }
  | { type: "done" }
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
  public planState: "IDLE" | "PLANNING_PENDING" | "APPROVED" = "IDLE";
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

  private getHistoryFilePath(): string {
    ensureGlobalConfigDir();
    const sanitizedPath = this.config.workingDirectory.replace(/[^a-zA-Z0-9]/g, "_");
    return path.join(getGlobalConfigDir(), "history", `${sanitizedPath}.json`);
  }

  async loadHistory(): Promise<void> {
    await this.conversation.loadFromFile(this.getHistoryFilePath());
  }

  async saveHistory(): Promise<void> {
    await this.conversation.saveToFile(this.getHistoryFilePath());
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
      await this.runAgentLoop();
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
    const maxIterations = parseInt(process.env.MAX_ITERATIONS || "50", 10) || 50;
    let continueCount = 0;
    const maxContinues = 3;

    const baseSystemPrompt = this.customSystemPrompt || this.config.systemPrompt;

    for (let i = 0; i < maxIterations; i++) {
      await this.compactHistoryIfNeeded();
      const messages = this.buildMessages();
      const toolDefs = getToolDefinitions();

      const currentStep = i + 1;
      const systemPrompt = `${baseSystemPrompt}

CRITICAL TASK EXECUTION CONTEXT:
- You are running with a strict step limit of ${maxIterations} agent iterations per request.
- Current Step: ${currentStep} of ${maxIterations}.
- Be highly efficient. If the task is complex, requires multiple steps, or involves extensive research/coding across different components, DO NOT try to do everything in a single sequential thread.
- Instead, immediately plan and delegate subtasks to specialized subagents (e.g., 'researcher', 'explorer', 'coder', 'reviewer') via 'invoke_subagent' to run tasks in parallel.
- Spawning subagents is the recommended way to solve large tasks within the iteration limit. Ensure you check subagent statuses and integrate their results.`;

      let textContent = "";
      const toolCalls: ToolCall[] = [];

      if (this.config.disableStreaming) {
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
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.onEvent({ type: "error", message: `Generate text failed: ${msg}` });
          return;
        }
      } else {
        let result;
        try {
          result = streamText({
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
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.onEvent({ type: "error", message: `Stream init failed: ${msg}` });
          return;
        }

        try {
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
              const errMsg =
                delta.error instanceof Error
                  ? delta.error.message
                  : String(delta.error);
              this.onEvent({ type: "error", message: `API error: ${errMsg}` });
              return;
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          this.onEvent({ type: "error", message: `Stream error: ${msg}` });
          return;
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
        return;
      }

      const toolResults: ToolResult[] = [];

      for (const tc of toolCalls) {
        const description = getToolDescription(tc);
        this.onEvent({ type: "tool_start", toolCall: tc, description });

        if (tc.name === "ask_question") {
          const question = tc.args.question as string || "";
          const options = tc.args.options as string[] || [];
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

        // Check if this tool modifies files
        if (MODIFYING_TOOLS.includes(tc.name)) {
          const filePath = tc.args.filePath as string || "";
          const isPlanFile = filePath && path.basename(filePath).toLowerCase() === "implementation_plan.md";

          if (isPlanFile) {
            this.planState = "PLANNING_PENDING";
          } else if (this.planState === "PLANNING_PENDING") {
            const blocked: ToolResult = {
              toolCallId: tc.id,
              name: tc.name,
              result: "Error: File modification blocked. A plan is pending approval. You must wait for the user to approve the plan using '/approve' before modifying any codebase files.",
              isError: true,
            };
            toolResults.push(blocked);
            this.onEvent({ type: "tool_end", toolResult: blocked, description });
            continue;
          }
        }

        if (
          (tc.name === "bash" || tc.name === "run_command" || tc.name === "run_background") &&
          isDangerousCommand(tc.args.command as string)
        ) {
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
          this.onEvent({
            type: "text",
            content: `\n\n⚠️ [System Warning: Reached maximum iteration limit and maximum auto-continues (${maxContinues}). Stopping to prevent infinite loop. You can continue the session by sending a message or running '/resume'.]\n`
          });
        } else {
          try {
            const selected = await this.onQuestion(
              `Reached maximum iteration limit of ${maxIterations} steps. The task may be incomplete. Would you like to continue for another ${maxIterations} steps?`,
              ["Yes, continue", "No, stop here"]
            );
            if (selected === "Yes, continue") {
              continueCount++;
              i = -1; // Reset loop counter to run again
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

    const result = await generateText({
      model: this.getModel(),
      system: "You are a helpful system agent that summarizes conversation history logs to save token context window space.",
      prompt,
      abortSignal: this.abortController?.signal,
    });

    return result.text || "(empty summary)";
  }

  abort(): void {
    this.abortController?.abort();
  }

  async clearHistory(): Promise<void> {
    this.conversation.clear();
    await this.saveHistory();
  }

  getHistory(): Conversation {
    return this.conversation;
  }

  isAgentRunning(): boolean {
    return this.isRunning;
  }
}
