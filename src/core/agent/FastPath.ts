import { streamText, generateText, type CoreMessage } from "ai";
import { contentToString } from "../conversation.js";
import { HistoryCompactor } from "./HistoryCompactor.js";
import type { Agent } from "../agent.js";

export function cleanThinkingTags(text: string, existingReasoning = ""): { cleanText: string; reasoning: string } {
  let rawText = text || "";
  let reasoning = existingReasoning || "";

  const thinkRegex = /<(think|thought|reasoning|thinking)(?:\s+[^>]*)?>([\s\S]*?)<\/\1\s*>/gi;
  let match;
  while ((match = thinkRegex.exec(rawText)) !== null) {
    const innerText = match[2].trim();
    if (innerText) {
      reasoning = (reasoning + "\n" + innerText).trim();
    }
  }
  rawText = rawText.replace(thinkRegex, "").trim();

  const looseCloseRegex = /<\/(think|thought|reasoning|thinking)\s*>/gi;
  rawText = rawText.replace(looseCloseRegex, "").trim();

  const unclosedRegex = /<(think|thought|reasoning|thinking)(?:\s+[^>]*)?>([\s\S]*)$/i;
  const unclosedMatch = unclosedRegex.exec(rawText);
  if (unclosedMatch) {
    const innerText = unclosedMatch[2].trim();
    if (innerText) {
      reasoning = (reasoning + "\n" + innerText).trim();
    }
    rawText = rawText.replace(unclosedRegex, "").trim();
  }

  return { cleanText: rawText, reasoning };
}

export class FastPath {
  /**
   * Lightweight response path for high-confidence conversational messages.
   *
   * Bypasses the full agent loop (workspace discovery, tool loading, plan injection,
   * rate limiter acquire, concurrency limiter acquire) and calls streamText directly
   * with a minimal system prompt and current conversation history.
   *
   * Activated only when: category=conversation AND confidence=high AND tier=single|master.
   */
  public static async runConversationFastPath(
    agent: Agent,
    userInput: string | import("../conversation.js").MessageContent
  ): Promise<void> {
    (agent as any).isRunning = true;
    (agent as any).abortController = new AbortController();
    const signal = (agent as any).abortController.signal;
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

    agent.writeToLogFile("INFO", `Agent execution started (fast-path, tier: ${agent.tier})`);
    agent.writeToLogFile("USER", typeof userInput === "string" ? userInput : "[multimodal message]");

    agent.conversation.addUserMessage(userInput);
    await agent.compactHistoryIfNeeded();
    await agent.saveHistory();
    (agent as any).autoCheckpoint("User message");

    try {
      await Promise.race([
        (async () => {
          const modelInstance = agent.getModel();
          if (!modelInstance) {
            throw new Error("No model instance available for conversation fast-path");
          }

          // Build minimal conversation history (user/assistant pairs only, skip tool results)
          const coreMessages: CoreMessage[] = [];
          const messages = agent.conversation.getMessages();
          const modelName = modelInstance.modelId;
          const supportsVision = agent.modelSupportsVision(modelName);

          for (const m of messages) {
            if (m.role === "system" || m.role === "tool") continue;
            if (m.role === "user") {
              let sdkContent: string | Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = "";
              if (typeof m.content === "string") {
                sdkContent = m.content;
              } else if (Array.isArray(m.content)) {
                if (supportsVision) {
                  sdkContent = m.content.map((p: any) => {
                    if (p.type === "image") {
                      const mime = p.mimeType || "image/png";
                      const imgStr = typeof p.image === "string" ? p.image : "";
                      const dataUrl = imgStr.startsWith("data:")
                        ? imgStr
                        : `data:${mime};base64,${imgStr}`;
                      return { type: "image" as const, image: dataUrl, mimeType: mime };
                    }
                    return { type: "text" as const, text: p.text };
                  });
                } else {
                  sdkContent = contentToString(m.content);
                }
              }
              coreMessages.push({ role: "user", content: sdkContent as any });
            } else if (m.role === "assistant") {
              const content = typeof m.content === "string" ? m.content : contentToString(m.content);
              if (content.trim()) {
                coreMessages.push({ role: "assistant", content });
              }
            }
          }

          // Minimal system prompt for conversational replies
          const baseSystemPrompt = (agent as any).customSystemPrompt || (agent as any).config.systemPrompt || "";
          const convSystemPrompt = baseSystemPrompt
            ? `${baseSystemPrompt}\n\nCLASSIFICATION: Conversational message detected. Respond directly and concisely. No tools needed.`
            : "You are a helpful AI coding assistant. The user sent a short conversational message. Respond naturally and concisely.";

          const startTime = Date.now();
          const useStreaming = !(agent as any).config.disableStreaming;
          let textContent = "";
          let reasoningContent = "";

          if (useStreaming) {
            try {
              const { logPrompt } = await import("./PromptLogger.js");
              logPrompt("FastPath:streamText", modelInstance?.modelId, convSystemPrompt, coreMessages, agent);
            } catch {}
            const result = streamText({
              model: modelInstance,
              system: convSystemPrompt,
              messages: coreMessages,
              abortSignal: signal,
            });

            let inThinkTagState = false;
            let currentThinkTagType = "";
            let streamBuffer = "";
            reasoningContent = "";

            for await (const delta of result.fullStream) {
              if (signal?.aborted) {
                const err = new Error("AbortError");
                err.name = "AbortError";
                throw err;
              }
              if (delta.type === "text-delta") {
                streamBuffer += delta.textDelta;
                
                while (streamBuffer.length > 0) {
                  if (!inThinkTagState) {
                    const openMatch = /^(<(think|thought|reasoning|thinking)(?:\s+[^>]*)?>)/i.exec(streamBuffer);
                    if (openMatch) {
                      inThinkTagState = true;
                      currentThinkTagType = openMatch[2];
                      streamBuffer = streamBuffer.substring(openMatch[1].length);
                      continue;
                    }
                    
                    const ltIdx = streamBuffer.indexOf("<");
                    if (ltIdx === -1) {
                      const textToEmit = streamBuffer;
                      textContent += textToEmit;
                      agent.onEvent({ type: "text", content: textToEmit });
                      streamBuffer = "";
                      break;
                    } else if (ltIdx > 0) {
                      const textToEmit = streamBuffer.substring(0, ltIdx);
                      textContent += textToEmit;
                      agent.onEvent({ type: "text", content: textToEmit });
                      streamBuffer = streamBuffer.substring(ltIdx);
                      continue;
                    }
                    
                    let isPrefix = false;
                    const tags = ["<think>", "<thought>", "<reasoning>", "<thinking>"];
                    for (const t of tags) {
                      if (t.startsWith(streamBuffer)) {
                        isPrefix = true;
                        break;
                      }
                    }
                    if (isPrefix && streamBuffer.length < "<reasoning>".length) {
                      break;
                    }
                    
                    const char = streamBuffer[0];
                    textContent += char;
                    agent.onEvent({ type: "text", content: char });
                    streamBuffer = streamBuffer.substring(1);
                  } else {
                    const closeMatch = new RegExp(`^((?:<\\/(?:${currentThinkTagType || "think|thought|reasoning|thinking"})\\s*>))`, "i").exec(streamBuffer);
                    if (closeMatch) {
                      inThinkTagState = false;
                      currentThinkTagType = "";
                      streamBuffer = streamBuffer.substring(closeMatch[1].length);
                      continue;
                    }
                    
                    const ltIdx = streamBuffer.indexOf("<");
                    if (ltIdx === -1) {
                      const textToEmit = streamBuffer;
                      reasoningContent += textToEmit;
                      agent.onEvent({ type: "reasoning", content: textToEmit });
                      streamBuffer = "";
                      break;
                    } else if (ltIdx > 0) {
                      const textToEmit = streamBuffer.substring(0, ltIdx);
                      reasoningContent += textToEmit;
                      agent.onEvent({ type: "reasoning", content: textToEmit });
                      streamBuffer = streamBuffer.substring(ltIdx);
                      continue;
                    }
                    
                    let isPrefix = false;
                    const closeTag = `</${currentThinkTagType}>`;
                    if (closeTag.startsWith(streamBuffer)) {
                      isPrefix = true;
                    }
                    if (isPrefix && streamBuffer.length < closeTag.length) {
                      break;
                    }
                    
                    const char = streamBuffer[0];
                    reasoningContent += char;
                    agent.onEvent({ type: "reasoning", content: char });
                    streamBuffer = streamBuffer.substring(1);
                  }
                }
              } else if ((delta.type as string) === "reasoning" || (delta.type as string) === "reasoning-delta") {
                const reasoningText = (delta as any).textDelta || (delta as any).text || (delta as any).reasoning || (delta as any).reasoningDelta || (delta as any).delta || "";
                if (reasoningText) {
                  reasoningContent += reasoningText;
                  agent.onEvent({ type: "reasoning", content: reasoningText });
                }
              } else if (delta.type === "error") {
                const { formatError } = await import("./AgentEvents.js");
                throw delta.error instanceof Error ? delta.error : new Error(formatError(delta.error));
              }
            }

            if (streamBuffer.length > 0) {
              if (inThinkTagState) {
                reasoningContent += streamBuffer;
                agent.onEvent({ type: "reasoning", content: streamBuffer });
              } else {
                textContent += streamBuffer;
                agent.onEvent({ type: "text", content: streamBuffer });
              }
            }

            if (!textContent.trim()) {
              if (reasoningContent.trim()) {
                textContent = reasoningContent.trim();
                agent.onEvent({ type: "text", content: textContent });
              } else {
                throw new Error("Empty response from model. Check your endpoint/model config.");
              }
            }

            // Emit token usage (streaming path)
            try {
              const usage = await result.usage;
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
                try {
                  const { addMasterTokens } = await import("../tools/state.js");
                  addMasterTokens(usage.promptTokens || 0, usage.completionTokens || 0);
                } catch { /* non-critical */ }
              }
            } catch { /* non-critical */ }
          } else {
            try {
              const { logPrompt } = await import("./PromptLogger.js");
              logPrompt("FastPath:generateText", modelInstance?.modelId, convSystemPrompt, coreMessages, agent);
            } catch {}
            // disableStreaming=true: use generateText to match main agent loop behavior
            const result = await generateText({
              model: modelInstance,
              system: convSystemPrompt,
              messages: coreMessages,
              abortSignal: signal,
            });
            const cleaned = cleanThinkingTags(result.text || "", (result as any).reasoning || "");
            textContent = cleaned.cleanText;
            reasoningContent = cleaned.reasoning;
            if (textContent) {
              agent.onEvent({ type: "text", content: textContent });
            }
            if (cleaned.reasoning) {
              agent.onEvent({ type: "reasoning", content: cleaned.reasoning });
            }

            if (!textContent.trim()) {
              if (cleaned.reasoning.trim()) {
                textContent = cleaned.reasoning.trim();
                agent.onEvent({ type: "text", content: textContent });
              } else {
                throw new Error("Empty response from model. Check your endpoint/model config.");
              }
            }

            // Emit token usage (non-streaming path)
            const usage = result.usage;
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
              try {
                const { addMasterTokens } = await import("../tools/state.js");
                addMasterTokens(usage.promptTokens || 0, usage.completionTokens || 0);
              } catch { /* non-critical */ }
            }
          }

          // Persist assistant reply
          if (textContent.trim()) {
            agent.conversation.addAssistantMessage(textContent, undefined, undefined, reasoningContent);
          }
          await agent.saveHistory();
          agent.writeToLogFile("ASSISTANT", textContent);
        })(),
        abortPromise,
      ]);
    } catch (err: unknown) {
      const { formatError } = await import("./AgentEvents.js");
      if (err instanceof Error && err.name === "AbortError") {
        agent.onEvent({ type: "text", content: "\n\n[Interrupted]" });
        await agent.saveHistory();
      } else {
        const message = formatError(err);
        agent.writeToLogFile("AGENT_ERROR", message);
        agent.onEvent({ type: "text", content: `\n\n❌ [ERROR] ${message}\n` });
        agent.onEvent({ type: "error", message });
        agent.conversation.addMessage({
          role: "system",
          content: `[ERROR] ${message}`,
          timestamp: Date.now(),
        });
        await agent.saveHistory();
      }
    } finally {
      if (signal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
      (agent as any).flushTextLogBuffer();
      (agent as any).isRunning = false;
      (agent as any).abortController = null;
      agent.currentClassification = null;

      if ((agent as any).pendingMessagesQueue.length > 0) {
        const queued = (agent as any).pendingMessagesQueue.shift()!;
        const logText = typeof queued === "string" ? queued : "[multimodal message]";
        agent.writeToLogFile("INFO", `Auto-sending queued message: "${logText.substring(0, 80)}..."`);
        agent.onEvent({ type: "text", content: "\n[SYS] Resuming with queued approval message...\n" });
        await agent.sendMessage(queued);
      } else {
        agent.onEvent({ type: "done" });
      }
    }
  }
}
