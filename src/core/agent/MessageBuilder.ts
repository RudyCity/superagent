import { type CoreMessage } from "ai";
import crypto from "crypto";
import {
  getTierModel,
  getSettings,
  getDynamicVisionThreshold,
  getTierModelConfig
} from "../config.js";
import { contentToString } from "../conversation.js";
import {
  renderTextToImageBase64,
  sliceTextIntoPages,
  minifyTextForImage
} from "../../utils/textToImage.js";
import type { Agent } from "../agent.js";

export class MessageBuilder {
  private static imageCache: Map<string, string[]> = new Map();

  private getCachedImages(text: string): string[] | null {
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    return MessageBuilder.imageCache.get(hash) || null;
  }

  private setCachedImages(text: string, images: string[]): void {
    const hash = crypto.createHash("sha256").update(text).digest("hex");
    if (MessageBuilder.imageCache.size >= 500) {
      const oldest = MessageBuilder.imageCache.keys().next().value;
      if (oldest) MessageBuilder.imageCache.delete(oldest);
    }
    MessageBuilder.imageCache.set(hash, images);
  }

  public modelSupportsVision(modelName: string, agent?: Agent): boolean {
    if (!modelName) return false;

    // Check configuration first
    if (agent) {
      try {
        const mode = (agent.isMultiAgent && !process.env.SINGLE_AGENT_MODE) ? "multi" : "single";
        const tierConfig = getTierModelConfig(mode, agent.subagentType || agent.tier);
        if (tierConfig && tierConfig.supportsVision !== undefined) {
          return tierConfig.supportsVision;
        }
      } catch (e) {
        // Fallback to name check
      }
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

  public buildMessages(agent: Agent, supportsNativeTools = true, dynamicContext?: string): CoreMessage[] {
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

    const settings = getSettings();
    const useVisionTokenSaving = supportsVision && (settings.autoVisionTokenSaving ?? false) && (agent.detectedPayloadLimitBytes === undefined || agent.detectedPayloadLimitBytes >= 500 * 1024);

    if (useVisionTokenSaving) {
      // MODE 2: Compile all messages into a single text block, clean up, render to images, and append.
      let compiledText = "";
      const messages = agent.conversation.getMessages();
      for (const m of messages) {
        if (m.role === "system") continue;
        const rawContent = typeof m.content === "string" ? m.content : contentToString(m.content);
        if (m.role === "user") {
          compiledText += `\n=== USER MESSAGE ===\n${rawContent}\n`;
        } else if (m.role === "assistant") {
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

        const contentParts: Array<{ type: "image"; image: string; mimeType?: string }> = [];
        limitedBase64List.forEach((base64) => {
          contentParts.push({ type: "image", image: base64, mimeType: "image/webp" });
        });

        coreMessages.push({
          role: "user",
          content: contentParts as any,
        });
      } catch (err: any) {
        agent.writeToLogFile("WARN", `Failed to compile prompt to image: ${err.message}. Falling back to text.`);
        this.buildPlaintextMessages(agent, coreMessages, supportsVision, supportsNativeTools, modelName);
      }
    } else {
      this.buildPlaintextMessages(agent, coreMessages, supportsVision, supportsNativeTools, modelName);
    }

    // Cleanup / post-process to add cache annotations
    this.addCacheControlToMessages(agent, coreMessages);

    return coreMessages;
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
    supportsVision: boolean,
    supportsNativeTools: boolean,
    modelName: string
  ): void {
    const messages = agent.conversation.getMessages();
    for (const m of messages) {
      if (m.role === "system") continue;

      if (m.role === "user") {
        let sdkContent: string | Array<{ type: "text"; text: string } | { type: "image"; image: string; mimeType?: string }> = "";

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
