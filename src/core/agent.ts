import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import { getConfig } from "./config.js";
import { Conversation } from "./conversation.js";
import { getToolDefinitions } from "./tools.js";
import {
  executeToolCall,
  getToolDescription,
  isDangerousCommand,
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

export class Agent {
  private conversation: Conversation;
  private config = getConfig();
  private onEvent: (event: AgentEvent) => void;
  private onPermission: PermissionHandler;
  private abortController: AbortController | null = null;
  private isRunning = false;

  constructor(
    onEvent: (event: AgentEvent) => void,
    onPermission: PermissionHandler
  ) {
    this.conversation = new Conversation();
    this.onEvent = onEvent;
    this.onPermission = onPermission;
  }

  private getHistoryFilePath(): string {
    return path.join(this.config.workingDirectory, ".superagent_history.json");
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
    });
    return openai(this.config.model);
  }

  async sendMessage(userInput: string): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();

    this.conversation.addUserMessage(userInput);
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
    const maxIterations = 20;

    for (let i = 0; i < maxIterations; i++) {
      const messages = this.buildMessages();
      const toolDefs = getToolDefinitions();

      let textContent = "";
      const toolCalls: ToolCall[] = [];

      if (this.config.disableStreaming) {
        try {
          const result = await generateText({
            model: this.getModel(),
            system: this.config.systemPrompt,
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
            system: this.config.systemPrompt,
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
