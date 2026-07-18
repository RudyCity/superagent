import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText, generateText, jsonSchema, type CoreMessage } from "ai";
import path from "path";
import { renderTextToImageBase64, sliceTextIntoPages, minifyTextForImage } from "../../utils/textToImage.js";
import { captureGitSnapshot, getGitDiffSummary } from "./GitUtils.js";
import fs from "fs";
import { getConfig, getSettings, getDynamicVisionThreshold } from "../config.js";
import { rateLimiter, concurrencyLimiter } from "../rateLimiter.js";
import type { ToolCall, ToolResult } from "../conversation.js";
import { contentToString } from "../conversation.js";
import { checkPlanStructure } from "./PlanValidator.js";
import { MessageBuilder } from "./MessageBuilder.js";
import { HistoryCompactor } from "./HistoryCompactor.js";
import { ToolExecutor } from "./ToolExecutor.js";
import { ContextBuilder } from "./ContextBuilder.js";
import { formatError } from "./AgentEvents.js";
import { type Agent, parsePayloadLimitBytes } from "../agent.js";
import { isRetryableError as isRetryableErrorHelper } from "./AgentUtils.js";

function isRetryableError(err: unknown): boolean {
  return isRetryableErrorHelper(err);
}

export class LoopIterationProcessor {
  public static async processIteration(
    agent: Agent,
    i: number,
    maxIterations: number,
    signal?: AbortSignal
  ): Promise<{ shouldBreak: boolean }> {
    const {
      finalSystemPrompt: builderSystemPrompt,
      messages: builderMessages,
      toolDefs: builderToolDefs,
      filteredToolDefs: builderFilteredToolDefs,
      supportsNativeTools: builderSupportsNativeTools,
      dynamicContext: builderDynamicContext,
    } = await ContextBuilder.buildContext(agent, signal);

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

    const modelInstance = agent.getModel();
    const modelName = modelInstance ? modelInstance.modelId : "";
    const supportsVision = agent.modelSupportsVision(modelName);
    const useVisionTokenSaving = supportsVision && (getSettings().autoVisionTokenSaving ?? false) && (agent.detectedPayloadLimitBytes === undefined || agent.detectedPayloadLimitBytes >= 500 * 1024);

    const isTest = !!process.env.VITEST;
    const isAnthropic = !isTest && modelInstance && (modelInstance.provider === "anthropic" || (typeof modelInstance.provider === "string" && modelInstance.provider.includes("anthropic")));

    let concurrencyAcquired = false;
    if (getSettings().concurrencyLimit === 1) {
      await concurrencyLimiter.acquire();
      concurrencyAcquired = true;
    }
    await rateLimiter.acquire(1);

    const startTime = Date.now();
    let textContent = "";
    let toolCalls: ToolCall[] = [];
    let reasoningContent: string | undefined;

    try {
      const activeTools = await agent.getActiveTools();

      let result;
      if (supportsNativeTools) {
        const system = finalSystemPrompt;
        const modelTools: Record<string, any> = {};
        for (const t of activeTools) {
          const category = agent.currentClassification?.category;
          if (category) {
            const { getToolsetForCategory } = await import("../requestClassifier.js");
            const filtered = getToolsetForCategory(category, activeTools);
            if (!filtered.some((ft: any) => ft.name === t.name)) {
              continue;
            }
          }
          modelTools[t.name] = {
            description: t.description,
            parameters: jsonSchema(t.parameters),
          };
        }

        if (!getConfig().disableStreaming) {
          let attempt = 0;
          const maxRetries = 3;
          const baseDelay = 5000;
          let currentByteBudget = 3 * 1024 * 1024; // 3.0 MB initial safety threshold
          let payload413Count = 0;

          while (true) {
            try {
              const callMessages = [...messages];
              const resultStream = await streamText({
                model: modelInstance,
                system,
                messages: callMessages,
                ...(Object.keys(modelTools).length > 0 && { tools: modelTools }),
                abortSignal: signal,
                ...(isAnthropic && {
                  experimental_providerMetadata: {
                    anthropic: { cacheControl: { type: "ephemeral" } },
                  },
                }),
              });

              for await (const delta of resultStream.fullStream) {
                if (signal?.aborted) {
                  const err = new Error("AbortError");
                  err.name = "AbortError";
                  throw err;
                }
                if (delta.type === "text-delta") {
                  textContent += delta.textDelta;
                  agent.onEvent({ type: "text", content: delta.textDelta });
                } else if ((delta.type as string) === "reasoning" || (delta.type as string) === "reasoning-delta") {
                  const reasoningText = (delta as any).reasoning || (delta as any).reasoningDelta || (delta as any).delta || "";
                  if (reasoningText) {
                    if (reasoningContent === undefined) reasoningContent = "";
                    reasoningContent += reasoningText;
                    agent.onEvent({ type: "reasoning", content: reasoningText });
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

              try {
                const usage = await resultStream.usage;
                if (usage) {
                  const durationMs = Date.now() - startTime;
                  if (durationMs > 0 && usage.completionTokens > 0) {
                    agent.lastSpeed = usage.completionTokens / (durationMs / 1000);
                  }
                  agent.onEvent({
                    type: "token_usage",
                    promptTokens: usage.promptTokens || 0,
                    completionTokens: usage.completionTokens || 0,
                    durationMs,
                  });
                }
              } catch {}

              if (!textContent.trim() && toolCalls.length === 0) {
                throw new Error("Empty response from model. Check your endpoint/model config.");
              }

              break; // Success
            } catch (err: any) {
              const rawMsg = err.message || String(err);
              const isUnavailableTool = rawMsg.toLowerCase().includes("tried to call unavailable tool") || rawMsg.toLowerCase().includes("tried to call tool that is not available");
              if (isUnavailableTool) {
                const match = rawMsg.match(/(?:tried to call unavailable tool|tool that is not available|tool) ['"]([^'"]+)['"]/i);
                const toolName = match ? match[1] : "bash";
                const toolCallId = "call_unavail_" + Math.random().toString(36).substring(2, 11);
                const mockToolCall = {
                  id: toolCallId,
                  name: toolName,
                  args: {},
                };
                const mockToolResult = {
                  toolCallId,
                  name: toolName,
                  result: `Error: Tool "${toolName}" is not available. Available tools: ${activeTools.map((t: any) => t.name).join(", ")}. Please use only the available tools.`,
                  isError: true,
                };
                agent.conversation.addAssistantMessage(
                  textContent || `Attempted to call tool "${toolName}"`,
                  [mockToolCall],
                  [mockToolResult],
                  reasoningContent
                );
                agent.conversation.addMessage({
                  role: "tool",
                  content: "",
                  toolResults: [mockToolResult],
                  timestamp: Date.now(),
                });
                await agent.saveHistory();
                return { shouldBreak: false };
              }
              const isRetryable = isRetryableError(err) || rawMsg.toLowerCase().includes("empty response");
              const isPayloadTooLarge = err.status === 413 || /payload too large/i.test(err.message) || /request entity too large/i.test(err.message);
              const isOverloaded = err.status === 429 || err.status === 503 || /overloaded/i.test(err.message) || /rate limit/i.test(err.message);

              attempt++;
              const currentMaxRetries = isOverloaded ? 5 : maxRetries;
              if (attempt > currentMaxRetries || !isRetryable) {
                if (isPayloadTooLarge) {
                  throw new Error(`Payload size limit exceeded (413). System prompt (${(Buffer.byteLength(system, "utf-8") / 1024).toFixed(1)} KB) and tool schemas exceed model payload limit. Try reducing history length.`);
                }
                if (rawMsg.toLowerCase().includes("empty response")) {
                  throw new Error("Empty response from model. Check your endpoint/model config.");
                }
                if (!isRetryable) {
                  throw err;
                }
                throw new Error(`Stream error after ${attempt - 1} retries: ${rawMsg}`);
              }

              if (isPayloadTooLarge) {
                payload413Count++;
                const parsedLimit = parsePayloadLimitBytes(rawMsg);
                if (parsedLimit) {
                  agent.detectedPayloadLimitBytes = parsedLimit;
                }
                const limitToUse = agent.detectedPayloadLimitBytes || parsedLimit || 4 * 1024 * 1024;
                const maxPayloadBytes = Math.floor(limitToUse * 0.9);
                const systemSize = finalSystemPrompt ? Buffer.byteLength(finalSystemPrompt, "utf-8") : 0;
                const toolsSize = Object.keys(modelTools).length > 0 ? Buffer.byteLength(JSON.stringify(modelTools), "utf-8") : 0;

                if (payload413Count > 3) {
                  throw new Error(`Payload size limit exceeded repeatedly. System prompt (${(systemSize / 1024).toFixed(1)} KB) and tool schemas exceed payload limit.`);
                }

                const reductionFactor = Math.pow(0.5, payload413Count - 1);
                const allowedHeadroom = maxPayloadBytes - systemSize - toolsSize - 5000;
                currentByteBudget = Math.max(1024 * 20, Math.floor(allowedHeadroom * reductionFactor));

                const beforePayloadBytes = Buffer.byteLength(JSON.stringify(messages), "utf-8") + systemSize + toolsSize + 5000;
                agent.writeToLogFile("INFO", `413 Compaction (stream): attempt ${payload413Count}. Before size: ${(beforePayloadBytes / 1024).toFixed(1)} KB, Budget target: ${(currentByteBudget / 1024).toFixed(1)} KB`);
                await agent.compactHistoryIfNeeded(signal, true, undefined, currentByteBudget);

                if (useVisionTokenSaving) {
                  messages = agent.buildMessages(supportsNativeTools, dynamicContext);
                } else {
                  messages = agent.buildMessages(supportsNativeTools);
                  injectDynamicContext(messages);
                }
                agent.onEvent({ type: "text", content: `\n[SYS] Payload limit exceeded (413). Retrying compaction... (attempt ${payload413Count}/3)\n` });
                await agent.delayWithCountdown(1, 1000, signal);
                continue;
              }

              const isRateLimit = err.status === 429 || /rate limit/i.test(rawMsg);
              const is503 = err.status === 503 || /overloaded/i.test(rawMsg);
              const overloadedDelays = [5000, 10000, 20000, 50000, 100000];

              if (isRateLimit || is503) {
                const retryLabel = isRateLimit ? "Rate limit" : "Server overloaded";
                const delay = overloadedDelays[attempt - 1] ?? 100000;
                agent.onEvent({ type: "text", content: `\n[SYS] ${retryLabel}. Retrying in ${delay / 1000}s (attempt ${attempt}/${currentMaxRetries})...\n` });
                await agent.delayWithCountdown(attempt, delay, signal);
                continue;
              }

              agent.onEvent({ type: "text", content: `\n[SYS] Communication error: ${rawMsg}. Retrying in ${Math.round(baseDelay * Math.pow(2, attempt - 1) / 1000)}s (attempt ${attempt}/${currentMaxRetries})...\n` });
              let delayMs = baseDelay * Math.pow(2, attempt - 1);
              if (rawMsg.toLowerCase().includes("empty response")) {
                if (attempt === 1) delayMs = 10000;
                else if (attempt === 2) delayMs = 20000;
                else if (attempt === 3) delayMs = 50000;
              }
              await agent.delayWithCountdown(attempt, delayMs, signal);
            }
          }
        } else {
          // Non-streaming Mode
          let attempt = 0;
          const maxRetries = 3;
          const baseDelay = 5000;
          let currentByteBudget = 3 * 1024 * 1024;
          let payload413Count = 0;

          while (true) {
            try {
              const callMessages = [...messages];
              result = await generateText({
                model: modelInstance,
                system: finalSystemPrompt,
                messages: callMessages,
                ...(Object.keys(modelTools).length > 0 && { tools: modelTools }),
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
                agent.onEvent({ type: "text", content: textContent });
              }
              reasoningContent = (result as any).reasoning || "";
              if (reasoningContent) {
                agent.onEvent({ type: "reasoning", content: reasoningContent });
              }

              if (result.toolCalls && result.toolCalls.length > 0) {
                for (const tc of result.toolCalls) {
                  toolCalls.push({
                    id: tc.toolCallId || Math.random().toString(),
                    name: tc.toolName,
                    args: tc.args as Record<string, unknown>,
                  });
                }
              }

              if (result.usage) {
                const durationMs = Date.now() - startTime;
                if (durationMs > 0 && result.usage.completionTokens > 0) {
                  agent.lastSpeed = result.usage.completionTokens / (durationMs / 1000);
                }
                agent.onEvent({
                  type: "token_usage",
                  promptTokens: result.usage.promptTokens || 0,
                  completionTokens: result.usage.completionTokens || 0,
                  durationMs,
                });
              }

              if (!textContent.trim() && toolCalls.length === 0) {
                throw new Error("Empty response from model. Check your endpoint/model config.");
              }

              break;
            } catch (err: any) {
              const rawMsg = err.message || String(err);
              const isUnavailableTool = rawMsg.toLowerCase().includes("tried to call unavailable tool") || rawMsg.toLowerCase().includes("tried to call tool that is not available");
              if (isUnavailableTool) {
                const match = rawMsg.match(/(?:tried to call unavailable tool|tool that is not available|tool) ['"]([^'"]+)['"]/i);
                const toolName = match ? match[1] : "bash";
                const toolCallId = "call_unavail_" + Math.random().toString(36).substring(2, 11);
                const mockToolCall = {
                  id: toolCallId,
                  name: toolName,
                  args: {},
                };
                const mockToolResult = {
                  toolCallId,
                  name: toolName,
                  result: `Error: Tool "${toolName}" is not available. Available tools: ${activeTools.map((t: any) => t.name).join(", ")}. Please use only the available tools.`,
                  isError: true,
                };
                agent.conversation.addAssistantMessage(
                  textContent || `Attempted to call tool "${toolName}"`,
                  [mockToolCall],
                  [mockToolResult],
                  reasoningContent
                );
                agent.conversation.addMessage({
                  role: "tool",
                  content: "",
                  toolResults: [mockToolResult],
                  timestamp: Date.now(),
                });
                await agent.saveHistory();
                return { shouldBreak: false };
              }
              const isRetryable = isRetryableError(err) || rawMsg.toLowerCase().includes("empty response");
              const isPayloadTooLarge = err.status === 413 || /payload too large/i.test(err.message) || /request entity too large/i.test(err.message);
              const isOverloaded = err.status === 429 || err.status === 503 || /overloaded/i.test(err.message) || /rate limit/i.test(err.message);

              attempt++;
              const currentMaxRetries = isOverloaded ? 5 : maxRetries;
              if (attempt > currentMaxRetries || !isRetryable) {
                if (isPayloadTooLarge) {
                  throw new Error(`Payload size limit exceeded (413).`);
                }
                if (rawMsg.toLowerCase().includes("empty response")) {
                  throw new Error("Empty response from model. Check your endpoint/model config.");
                }
                if (!isRetryable) {
                  throw err;
                }
                throw new Error(`Generate text failed after ${attempt - 1} retries: ${rawMsg}`);
              }

              if (isPayloadTooLarge) {
                payload413Count++;
                const parsedLimit = parsePayloadLimitBytes(rawMsg);
                if (parsedLimit) {
                  agent.detectedPayloadLimitBytes = parsedLimit;
                }
                const limitToUse = agent.detectedPayloadLimitBytes || parsedLimit || 4 * 1024 * 1024;
                const maxPayloadBytes = Math.floor(limitToUse * 0.9);
                const systemSize = finalSystemPrompt ? Buffer.byteLength(finalSystemPrompt, "utf-8") : 0;
                const toolsSize = Object.keys(modelTools).length > 0 ? Buffer.byteLength(JSON.stringify(modelTools), "utf-8") : 0;

                if (payload413Count > 3) {
                  throw new Error(`Payload size limit exceeded repeatedly.`);
                }

                const reductionFactor = Math.pow(0.5, payload413Count - 1);
                const allowedHeadroom = maxPayloadBytes - systemSize - toolsSize - 5000;
                currentByteBudget = Math.max(1024 * 20, Math.floor(allowedHeadroom * reductionFactor));

                const beforePayloadBytes = Buffer.byteLength(JSON.stringify(messages), "utf-8") + systemSize + toolsSize + 5000;
                agent.writeToLogFile("INFO", `413 Compaction (non-stream): attempt ${payload413Count}. Before size: ${(beforePayloadBytes / 1024).toFixed(1)} KB, Budget target: ${(currentByteBudget / 1024).toFixed(1)} KB`);
                await agent.compactHistoryIfNeeded(signal, true, undefined, currentByteBudget);

                if (useVisionTokenSaving) {
                  messages = agent.buildMessages(supportsNativeTools, dynamicContext);
                } else {
                  messages = agent.buildMessages(supportsNativeTools);
                  injectDynamicContext(messages);
                }
                agent.onEvent({ type: "text", content: `\n[SYS] Payload limit exceeded (413). Retrying compaction...\n` });
                await agent.delayWithCountdown(1, 1000, signal);
                continue;
              }

              const isRateLimit = err.status === 429 || /rate limit/i.test(rawMsg);
              const is503 = err.status === 503 || /overloaded/i.test(rawMsg);
              const overloadedDelays = [5000, 10000, 20000, 50000, 100000];

              if (isRateLimit || is503) {
                const delay = overloadedDelays[attempt - 1] ?? 100000;
                agent.onEvent({ type: "text", content: `\n[SYS] Retrying in ${delay / 1000}s...\n` });
                await agent.delayWithCountdown(attempt, delay, signal);
                continue;
              }

              let delayMs = baseDelay * Math.pow(2, attempt - 1);
              if (rawMsg.toLowerCase().includes("empty response")) {
                if (attempt === 1) delayMs = 10000;
                else if (attempt === 2) delayMs = 20000;
                else if (attempt === 3) delayMs = 50000;
              }
              await agent.delayWithCountdown(attempt, delayMs, signal);
            }
          }
        }
      } else {
        // Fallback or XML-based prompt tools
        let attempt = 0;
        const maxRetries = 10;
        const baseDelay = 5000;
        let currentByteBudget = 3 * 1024 * 1024;
        let payload413Count = 0;

        while (true) {
          try {
            const callMessages = [...messages];
            result = await generateText({
              model: modelInstance,
              system: finalSystemPrompt,
              messages: callMessages,
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
              agent.onEvent({ type: "text", content: textContent });
            }
            reasoningContent = (result as any).reasoning || "";
            if (reasoningContent) {
              agent.onEvent({ type: "reasoning", content: reasoningContent });
            }

            try {
              const { parseXmlToolCalls } = await import("../../utils/xmlToolParser.js");
              const parsed = parseXmlToolCalls(textContent, toolDefs);
              if (parsed.toolCalls && parsed.toolCalls.length > 0) {
                for (const p of parsed.toolCalls) {
                  toolCalls.push({
                    id: p.id || Math.random().toString(),
                    name: p.name,
                    args: p.args,
                  });
                }
              }
            } catch {}

            if (!textContent.trim() && toolCalls.length === 0) {
              throw new Error("Empty response from model. Check your endpoint/model config.");
            }

            break;
          } catch (err: any) {
            const rawMsg = err.message || String(err);
            const isUnavailableTool = rawMsg.toLowerCase().includes("tried to call unavailable tool") || rawMsg.toLowerCase().includes("tried to call tool that is not available");
            if (isUnavailableTool) {
              const match = rawMsg.match(/(?:tried to call unavailable tool|tool that is not available|tool) ['"]([^'"]+)['"]/i);
              const toolName = match ? match[1] : "bash";
              const toolCallId = "call_unavail_" + Math.random().toString(36).substring(2, 11);
              const mockToolCall = {
                id: toolCallId,
                name: toolName,
                args: {},
              };
              const mockToolResult = {
                toolCallId,
                name: toolName,
                result: `Error: Tool "${toolName}" is not available. Available tools: ${activeTools.map((t: any) => t.name).join(", ")}. Please use only the available tools.`,
                isError: true,
              };
              agent.conversation.addAssistantMessage(
                textContent || `Attempted to call tool "${toolName}"`,
                [mockToolCall],
                [mockToolResult],
                reasoningContent
              );
              agent.conversation.addMessage({
                role: "tool",
                content: "",
                toolResults: [mockToolResult],
                timestamp: Date.now(),
              });
              await agent.saveHistory();
              return { shouldBreak: false };
            }
            const isRetryable = isRetryableError(err) || rawMsg.toLowerCase().includes("empty response");
            const isPayloadTooLarge = err.status === 413 || /payload too large/i.test(err.message) || /request entity too large/i.test(err.message);
            const isOverloaded = err.status === 429 || err.status === 503 || /overloaded/i.test(err.message) || /rate limit/i.test(err.message);

            attempt++;
            const currentMaxRetries = isOverloaded ? 5 : maxRetries;
            if (attempt > currentMaxRetries || !isRetryable) {
              if (rawMsg.toLowerCase().includes("empty response")) {
                throw new Error("Empty response from model. Check your endpoint/model config.");
              }
              if (!isRetryable) {
                throw err;
              }
              throw new Error(`preset stream failed after ${attempt} attempts: ${rawMsg}`);
            }

            if (isPayloadTooLarge) {
              payload413Count++;
              const parsedLimit = parsePayloadLimitBytes(rawMsg);
              if (parsedLimit) {
                agent.detectedPayloadLimitBytes = parsedLimit;
              }
              const limitToUse = agent.detectedPayloadLimitBytes || parsedLimit || 4 * 1024 * 1024;
              const maxPayloadBytes = Math.floor(limitToUse * 0.9);
              const systemSize = finalSystemPrompt ? Buffer.byteLength(finalSystemPrompt, "utf-8") : 0;
              const toolsSize = 0;

              if (payload413Count > 3) {
                throw new Error(`Payload size limit exceeded repeatedly.`);
              }

              const reductionFactor = Math.pow(0.5, payload413Count - 1);
              const allowedHeadroom = maxPayloadBytes - systemSize - toolsSize - 5000;
              currentByteBudget = Math.max(1024 * 20, Math.floor(allowedHeadroom * reductionFactor));

              const beforePayloadBytes = Buffer.byteLength(JSON.stringify(messages), "utf-8") + systemSize + toolsSize + 5000;
              agent.writeToLogFile("INFO", `413 Compaction (xml-fallback): attempt ${payload413Count}. Before size: ${(beforePayloadBytes / 1024).toFixed(1)} KB, Budget target: ${(currentByteBudget / 1024).toFixed(1)} KB`);
              await agent.compactHistoryIfNeeded(signal, true, undefined, currentByteBudget);

              if (useVisionTokenSaving) {
                messages = agent.buildMessages(supportsNativeTools, dynamicContext);
              } else {
                messages = agent.buildMessages(supportsNativeTools);
                injectDynamicContext(messages);
              }
              agent.onEvent({ type: "text", content: `\n[SYS] Payload limit exceeded (413). Retrying compaction...\n` });
              await agent.delayWithCountdown(1, 1000, signal);
              continue;
            }

            const isRateLimit = err.status === 429 || /rate limit/i.test(rawMsg);
            const is503 = err.status === 503 || /overloaded/i.test(rawMsg);
            const overloadedDelays = [5000, 10000, 20000, 50000, 100000];

            if (isRateLimit || is503) {
              const delay = overloadedDelays[attempt - 1] ?? 100000;
              agent.onEvent({ type: "text", content: `\n[SYS] Retrying in ${delay / 1000}s...\n` });
              await agent.delayWithCountdown(attempt, delay, signal);
              continue;
            }

            let delayMs = baseDelay * Math.pow(2, attempt - 1);
            if (rawMsg.toLowerCase().includes("empty response")) {
              if (attempt === 1) delayMs = 10000;
              else if (attempt === 2) delayMs = 20000;
              else if (attempt === 3) delayMs = 50000;
            }
            await agent.delayWithCountdown(attempt, delayMs, signal);
          }
        }
      }
    } finally {
      if (concurrencyAcquired) {
        concurrencyLimiter.release();
      }
    }

    if (toolCalls.length === 0) {
      if (textContent.trim()) {
        const isEarlyIteration = i < 2;
        const category = agent.currentClassification?.category || "complex_task";
        const skipPlanningCategories = ["conversation", "question"];
        const isPlanningText =
          isEarlyIteration &&
          !skipPlanningCategories.includes(category) &&
          textContent.trim().length > 0 &&
          textContent.trim().length < 500 &&
          !/\?$/.test(textContent.trim());

        if (isPlanningText) {
          agent.writeToLogFile(
            "INFO",
            `Text-only response on iteration ${i} (likely planning narration). Auto-continuing with nudge.`
          );
          agent.conversation.addAssistantMessage(textContent, undefined, undefined, reasoningContent);
          agent.conversation.addMessage({
            role: "user",
            content: "[SYS] Continue. Use the available tools to execute the plan you described.",
            timestamp: Date.now(),
          });
          await agent.saveHistory();
          return { shouldBreak: false };
        }

        const currentCwd = (agent.tier === "superagent" && agent.worktreePath)
          ? agent.worktreePath
          : agent.workingDirectory;
        const endSnapshot = await captureGitSnapshot(currentCwd);
        const gitSummary = getGitDiffSummary(agent.gitStartSnapshot, endSnapshot);
        if (gitSummary) {
          const summaryHeader = "\n\nChanges summary:\n" + gitSummary;
          textContent += summaryHeader;
          agent.onEvent({ type: "text", content: summaryHeader });
        }

        agent.conversation.addAssistantMessage(textContent, undefined, undefined, reasoningContent);
        await agent.saveHistory();
      }
      return { shouldBreak: true };
    }

    const toolResults = await ToolExecutor.executeTools(
      agent,
      toolCalls,
      toolDefs,
      filteredToolDefs,
      supportsNativeTools,
      finalSystemPrompt,
      signal
    );

    agent.conversation.addAssistantMessage(
      textContent,
      toolCalls,
      toolResults,
      reasoningContent
    );

    agent.conversation.addMessage({
      role: "tool",
      content: "",
      toolResults,
      timestamp: Date.now(),
    });
    await agent.saveHistory();

    if (getSettings().enableAdvisor ?? true) {
      const advisorResult = agent.advisor.evaluateStep(toolCalls, toolResults);
      if (advisorResult.action === "warn_agent" && advisorResult.message) {
        agent.onEvent({
          type: "text",
          content: `\n⚠️ [Advisor] Warning: ${advisorResult.message}\n`,
        });
        agent.conversation.addMessage({
          role: "user",
          content: advisorResult.message,
          timestamp: Date.now(),
        });
        await agent.saveHistory();
      } else if (advisorResult.action === "pause_execution" && advisorResult.message) {
        agent.onEvent({
          type: "text",
          content: `\n❌ [Advisor] Critical: ${advisorResult.message}\n`,
        });
        agent.onEvent({
          type: "error",
          message: advisorResult.message,
        });
        return { shouldBreak: true };
      }
    }

    {
      const ctxMgr = agent.conversation.getContextManager();
      if (ctxMgr) {
        const postMessages = agent.conversation.getMessages();
        if (postMessages.length === 0) return { shouldBreak: false };
        const postDecision = ctxMgr.shouldCompact(postMessages);
        if (postDecision.shouldCompact) {
          agent.writeToLogFile(
            "INFO",
            `Post-iteration compaction triggered: ${postDecision.reason}`
          );
          await agent.compactHistoryIfNeeded(signal);
        }
      }
    }

    if (agent.planState === "PLANNING_PENDING") {
      return { shouldBreak: true };
    }

    return { shouldBreak: false };
  }
}
