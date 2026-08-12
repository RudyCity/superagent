import { type CoreMessage } from "ai";
import crypto from "crypto";
import {
  getTierModel,
  getSettings,
  getTierModelConfig
} from "../config.js";
import { contentToString } from "../conversation.js";
import type { Agent } from "../agent.js";

export class MessageBuilder {

  public modelSupportsVision(modelName: string, agent?: Agent): boolean {
    if (!modelName) return false;

    const name = modelName.toLowerCase();
    
    // Known vision-supporting models - name check overrides config misconfigurations
    if (
      name.includes("claude-3") ||
      name.includes("claude") ||
      name.includes("gpt-4o") ||
      name.includes("gpt-4.5") ||
      name.includes("gpt-4-vision") ||
      name.includes("o1") ||
      name.includes("o3") ||
      name.includes("gemini") ||
      name.includes("gemma-3") ||
      name.includes("vision") ||
      name.includes("-vl") ||
      name.includes("vl-") ||
      name.includes("qwen") ||
      name.includes("pixtral") ||
      name.includes("llava") ||
      name.includes("llama-3.2")
    ) {
      return true;
    }

    // Check configuration for custom/other models
    if (agent) {
      try {
        const mode = (agent.isMultiAgent && !process.env.SINGLE_AGENT_MODE) ? "multi" : "single";
        const tierConfig = getTierModelConfig(mode, agent.subagentType || agent.tier);
        if (tierConfig && tierConfig.supportsVision !== undefined) {
          return tierConfig.supportsVision;
        }
      } catch (e) {
        // ignore configuration read errors
      }
    }

    return false;
  }

  public buildMessages(agent: Agent, supportsNativeTools = true): CoreMessage[] {
    const coreMessages: CoreMessage[] = [];

    let modelName = "";
    let supportsVision = true;
    try {
      const mode = (agent.isMultiAgent && !process.env.SINGLE_AGENT_MODE) ? "multi" : "single";
      modelName = getTierModel(mode, agent.subagentType || agent.tier);
      supportsVision = this.modelSupportsVision(modelName, agent);
    } catch (e) {
      // Default to true to keep original behavior if model config loading/resolution fails
    }

    this.buildPlaintextMessages(agent, coreMessages, supportsNativeTools, modelName);

    const cleanedMessages = this.cleanMessageSequence(coreMessages, agent);

    // Cleanup / post-process to add cache annotations
    this.addCacheControlToMessages(agent, cleanedMessages);

    return cleanedMessages;
  }

  private cleanMessageSequence(messages: CoreMessage[], agent: Agent): CoreMessage[] {
    if (messages.length === 0) return [];

    const hasToolCalls = (msg: CoreMessage): boolean => {
      if (msg.role !== "assistant") return false;
      if (Array.isArray(msg.content)) {
        return msg.content.some((part: any) => part.type === "tool-call");
      }
      return false;
    };

    const stripToolCalls = (msg: CoreMessage): CoreMessage => {
      if (msg.role !== "assistant") return msg;
      if (Array.isArray(msg.content)) {
        const textParts = msg.content.filter((part: any) => part.type === "text");
        if (textParts.length === 0) {
          return {
            role: "assistant",
            content: "Continuing execution...",
          };
        }
        return {
          role: "assistant",
          content: textParts as any,
        };
      }
      return msg;
    };

    const mergeMessages = (m1: CoreMessage, m2: CoreMessage): CoreMessage => {
      if (m1.role !== m2.role) return m2;

      if (m1.role === "user" || m1.role === "assistant") {
        const parts1 = Array.isArray(m1.content)
          ? m1.content
          : [{ type: "text" as const, text: m1.content }];
        const parts2 = Array.isArray(m2.content)
          ? m2.content
          : [{ type: "text" as const, text: m2.content }];
        
        const mergedParts = [...parts1, ...parts2];
        const finalParts: any[] = [];
        for (const part of mergedParts) {
          if (part.type === "text") {
            const last = finalParts[finalParts.length - 1];
            if (last && last.type === "text") {
              last.text += "\n\n" + part.text;
            } else {
              finalParts.push({ ...part });
            }
          } else {
            finalParts.push(part);
          }
        }

        if (m1.role === "user") {
          return {
            role: "user",
            content: finalParts as any,
          };
        } else {
          return {
            role: "assistant",
            content: finalParts as any,
          };
        }
      }

      if (m1.role === "tool") {
        const results1 = Array.isArray(m1.content) ? m1.content : [];
        const results2 = Array.isArray(m2.content) ? m2.content : [];
        return {
          role: "tool",
          content: [...results1, ...results2] as any,
        };
      }

      return m2;
    };

    const result: CoreMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      let msg = { ...messages[i] };

      const isEmpty = (m: CoreMessage) => {
        if (!m.content) return true;
        if (typeof m.content === "string" && m.content.trim() === "") {
          if (m.role === "assistant" && hasToolCalls(m)) return false;
          return true;
        }
        if (Array.isArray(m.content) && m.content.length === 0) return true;
        return false;
      };

      if (isEmpty(msg)) {
        continue;
      }

      if (msg.role === "tool") {
        const last = result[result.length - 1];
        if (!last || last.role !== "assistant" || !hasToolCalls(last)) {
          continue;
        }
      }

      if (result.length > 0) {
        const last = result[result.length - 1];
        if (last.role === "assistant" && hasToolCalls(last) && msg.role !== "tool") {
          result[result.length - 1] = stripToolCalls(last);
        }
      }

      if (result.length > 0 && result[result.length - 1].role === msg.role) {
        result[result.length - 1] = mergeMessages(result[result.length - 1], msg);
      } else {
        result.push(msg);
      }
    }

    if (result.length > 0) {
      const last = result[result.length - 1];
      if (last.role === "assistant" && hasToolCalls(last)) {
        result[result.length - 1] = stripToolCalls(last);
      }
    }

    const coreContentToString = (content: any): string => {
      if (!content) return "";
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return String(content);
      return content
        .map((p: any) => {
          if (!p) return "";
          if (typeof p === "string") return p;
          if (p.type === "text") return p.text || "";
          if (p.type === "tool-call") return `[Tool Call: ${p.toolName}(${JSON.stringify(p.args || {})})]`;
          if (p.type === "tool-result") {
            const resStr = typeof p.result === "string" ? p.result : JSON.stringify(p.result);
            return `[Tool Result ${p.toolName}]: ${resStr}`;
          }
          if (p.type === "image") return "[image]";
          return String(p);
        })
        .filter(Boolean)
        .join("\n");
    };

    while (result.length > 0 && result[0].role !== "user") {
      const first = result[0];
      if (first.role === "assistant") {
        let textContent = coreContentToString(first.content);
        if (result.length > 1 && result[1].role === "tool") {
          const toolMsg = result[1];
          const toolText = coreContentToString(toolMsg.content);
          textContent += `\n[Tool Results]:\n${toolText}`;
          result.splice(1, 1);
        }
        result[0] = {
          role: "user",
          content: `[Previous Assistant Message]:\n${textContent}`,
        };
      } else {
        result.shift();
      }
    }

    // Final sanitization pass to enforce strict Bedrock/Anthropic tool call & result pairing rules:
    // 1. Any 'tool' message must be immediately preceded by an 'assistant' message with matching tool calls.
    // 2. Any 'assistant' message with tool calls must be immediately followed by a 'tool' message with matching results.
    const sanitized: CoreMessage[] = [];
    for (let i = 0; i < result.length; i++) {
      const curr = result[i];
      if (curr.role === "assistant" && hasToolCalls(curr)) {
        const next = result[i + 1];
        if (next && next.role === "tool") {
          sanitized.push(curr);
          sanitized.push(next);
          i++; // skip next since it's consumed as matching tool result
        } else {
          // Assistant message has tool calls but no matching tool result follows -> strip tool calls
          sanitized.push(stripToolCalls(curr));
        }
      } else if (curr.role === "tool") {
        // Orphaned tool message without preceding assistant tool call -> drop it
        continue;
      } else {
        sanitized.push(curr);
      }
    }

    // Merge adjacent user messages or assistant text messages created during sanitization
    const finalResult: CoreMessage[] = [];
    for (const msg of sanitized) {
      if (finalResult.length > 0 && finalResult[finalResult.length - 1].role === msg.role) {
        finalResult[finalResult.length - 1] = mergeMessages(finalResult[finalResult.length - 1], msg);
      } else {
        finalResult.push(msg);
      }
    }

    return finalResult;
  }

  private addCacheControlToMessages(agent: Agent, coreMessages: CoreMessage[]): void {
    try {
      const modelInstance = agent.getModel();
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

  private buildPlaintextMessages(
    agent: Agent,
    coreMessages: CoreMessage[],
    supportsNativeTools: boolean,
    modelName: string
  ): void {
    const messages = agent.conversation.getMessages();
    for (const m of messages) {
      if (m.role === "system") {
        const rawContent = contentToString(m.content);
        if (rawContent.startsWith("[RMemory Agent Memory Context]:")) {
          coreMessages.push({
            role: "system",
            content: rawContent,
          });
        }
        continue;
      }

      if (m.role === "user") {
        let sdkContent: string | Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = "";

        sdkContent = typeof m.content === "string"
          ? m.content
          : (m.content as any[]).map((p: any) => {
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
        if (results.length === 0) {
          continue;
        }

        let pendingImagesToAppend: Array<{ toolName: string; base64List: string[]; mimeType?: string }> = [];

        for (const tr of results) {
          // Skip results with missing toolCallId — Anthropic requires tool_use_id on every tool_result block
          if (!tr.toolCallId) {
            agent.writeToLogFile("WARN", `Skipping tool result for "${tr.name}": missing toolCallId`);
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
          }

          contentParts.push({
            type: "tool-result",
            toolCallId: tr.toolCallId,
            toolName: tr.name,
            result: cleanedResult,
          });
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
            if (item.mimeType) {
              // Direct image from tool execution
              appendParts.push({
                type: "text",
                text: `Direct image output from tool "${item.toolName}":`
              });
              item.base64List.forEach((base64) => {
                appendParts.push({ type: "image", image: base64, mimeType: item.mimeType });
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
      const modelInstance = agent.getModel();
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
}
