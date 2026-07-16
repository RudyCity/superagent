import { Message, MessageContent, contentToString } from "../conversation.js";
import { getSettings, getDynamicVisionThreshold } from "../config.js";

export interface TokenBreakdown {
  systemPrompt: number;
  messages: number;
  toolCalls: number;
  toolResults: number;
  total: number;
}

const MAX_CACHE_SIZE = 500;

/** Simple LRU eviction: when Map exceeds MAX_CACHE_SIZE, drop the oldest entry. */
function lruSet<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (map.size >= MAX_CACHE_SIZE) {
    const oldest = map.keys().next().value;
    map.delete(oldest!);
  }
  map.set(key, value);
}

export class TokenTracker {
  private model: string;
  private cache: Map<string, number> = new Map();
  private breakdownCache: Map<string, { content: number; toolCalls: number; toolResults: number }> = new Map();
  private encoder: any = null;
  /** Resolved once tiktoken is ready (or failed). Await before first count. */
  private encoderReady: Promise<void>;

  constructor(model: string) {
    this.model = model;
    this.encoderReady = this.initEncoder();
  }

  private async initEncoder(): Promise<void> {
    try {
      const { get_encoding } = await import("tiktoken");
      this.encoder = get_encoding("cl100k_base");
    } catch {
      this.encoder = null;
    }
  }

  /** Await this before the first token estimate to ensure encoder is loaded. */
  async ensureEncoder(): Promise<void> {
    return this.encoderReady;
  }

  setModel(model: string): void {
    if (this.model !== model) {
      this.model = model;
      this.cache.clear();
      this.breakdownCache.clear();
    }
  }

  getModel(): string {
    return this.model;
  }

  private modelSupportsVision(modelName: string): boolean {
    if (!modelName) return false;
    const name = modelName.toLowerCase();
    if (name.includes("claude-3")) return true;
    if (name.includes("gpt-4o")) return true;
    if (name.includes("gpt-4-vision")) return true;
    if (name.includes("gemini")) return true;
    if (name.includes("gemma-3")) return true;
    if (name.includes("vision")) return true;
    return false;
  }

  estimateTokens(message: Message): number {
    const hash = this.hashMessage(message);

    if (this.cache.has(hash)) {
      return this.cache.get(hash)!;
    }

    const settings = getSettings();
    const supportsVision = this.modelSupportsVision(this.model);
    const useVision = supportsVision && (settings.autoVisionTokenSaving ?? false);
    const threshold = getDynamicVisionThreshold(this.model);

    let tokens = this.countContent(message.content, useVision, threshold);

    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        tokens += this.countText(JSON.stringify(call.args));
      }
    }

    if (message.toolResults) {
      for (const result of message.toolResults) {
        const resultStr = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        if (useVision && resultStr.length > threshold) {
          const lines = resultStr.split(/\r?\n/);
          const pageCount = Math.min(3, Math.ceil(lines.length / 150));
          tokens += pageCount * 1600 + 150;
        } else {
          tokens += this.countText(resultStr);
        }
      }
    }

    lruSet(this.cache, hash, tokens);
    return tokens;
  }

  estimateTokensForAll(messages: Message[]): TokenBreakdown {
    let systemPrompt = 0;
    let messagesTokens = 0;
    let toolCalls = 0;
    let toolResults = 0;

    const settings = getSettings();
    const supportsVision = this.modelSupportsVision(this.model);
    const useVision = supportsVision && (settings.autoVisionTokenSaving ?? false);
    const threshold = getDynamicVisionThreshold(this.model);

    for (const msg of messages) {
      const hash = this.hashMessage(msg);
      let cached = this.breakdownCache.get(hash);

      if (!cached) {
        let content = this.countContent(msg.content, useVision, threshold);
        let tcTokens = 0;
        if (msg.toolCalls) {
          for (const call of msg.toolCalls) {
            tcTokens += this.countText(JSON.stringify(call.args));
          }
        }
        let trTokens = 0;
        if (msg.toolResults) {
          for (const result of msg.toolResults) {
            const resultStr = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
            if (useVision && resultStr.length > threshold) {
              const lines = resultStr.split(/\r?\n/);
              const pageCount = Math.min(3, Math.ceil(lines.length / 150));
              trTokens += pageCount * 1600 + 150;
            } else {
              trTokens += this.countText(resultStr);
            }
          }
        }
        cached = { content, toolCalls: tcTokens, toolResults: trTokens };
        lruSet(this.breakdownCache, hash, cached);
      }

      if (msg.role === "system") {
        systemPrompt += cached.content;
      } else {
        messagesTokens += cached.content;
      }
      toolCalls += cached.toolCalls;
      toolResults += cached.toolResults;
    }

    return {
      systemPrompt,
      messages: messagesTokens,
      toolCalls,
      toolResults,
      total: systemPrompt + messagesTokens + toolCalls + toolResults,
    };
  }

  getBreakdown(messages: Message[], systemPrompt?: string): TokenBreakdown {
    const breakdown = this.estimateTokensForAll(messages);

    if (systemPrompt) {
      const settings = getSettings();
      const supportsVision = this.modelSupportsVision(this.model);
      const useVision = supportsVision && (settings.autoVisionTokenSaving ?? false);
      const threshold = getDynamicVisionThreshold(this.model);

      let sysTokens = 0;
      if (useVision && systemPrompt.length > threshold) {
        const lines = systemPrompt.split(/\r?\n/);
        const pageCount = Math.min(3, Math.ceil(lines.length / 150));
        sysTokens = pageCount * 1600 + 150;
      } else {
        sysTokens = this.countText(systemPrompt);
      }
      breakdown.systemPrompt += sysTokens;
      breakdown.total += sysTokens;
    }

    return breakdown;
  }

  private countContent(content: MessageContent, useVision: boolean, threshold: number): number {
    if (!content) return 0;

    if (typeof content === "string") {
      const isMemoryContext = content.startsWith("[RMemory Agent Memory Context]:");
      if (useVision && (content.length > threshold || isMemoryContext)) {
        const lines = content.split(/\r?\n/);
        const pageCount = Math.min(3, Math.ceil(lines.length / 150));
        return pageCount * 1600 + 150;
      }
      return this.countText(content);
    }

    let tokens = 0;
    for (const part of content) {
      if (part.type === "text") {
        tokens += this.countText(part.text);
      } else if (part.type === "image") {
        // Multi-modal image token overhead (Anthropic is ~1600 tokens)
        tokens += 1600;
      }
    }
    return tokens;
  }

  private countText(text: string): number {
    if (!text) return 0;

    if (this.encoder) {
      try {
        return this.encoder.encode(text).length;
      } catch {
        // Fall through to heuristic
      }
    }

    // Fallback: improved heuristic
    const hasCode = /[{}\[\]()=<>]/.test(text);
    const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/.test(text);

    let ratio = 4;
    if (hasCode) ratio = 3;
    if (hasCJK) ratio = 2;

    return Math.ceil(text.length / ratio);
  }

  /**
   * Stable hash that includes a content prefix to prevent collisions between
   * messages sharing the same role, timestamp, and content length but differing
   * in actual text (e.g., two user messages sent at the same millisecond).
   */
  private hashMessage(message: Message): string {
    const text = contentToString(message.content);
    const contentLen = text.length;
    let contentPrefix = text.length <= 64 ? text : text.substring(0, 64);
    contentPrefix = contentPrefix.replace(/\s+/g, " ");
    return `${message.role}:${contentLen}:${message.timestamp || 0}:${message.toolCalls?.length || 0}:${message.toolResults?.length || 0}:${contentPrefix}`;
  }
}

