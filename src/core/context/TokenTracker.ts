import { Message, MessageContent, contentToString } from "../conversation";

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
    this.model = model;
    // Note: caches are intentionally NOT cleared here.
    // The tiktoken encoder (cl100k_base) is the same for all models,
    // so existing cached token counts remain valid after a model switch.
  }

  getModel(): string {
    return this.model;
  }

  estimateTokens(message: Message): number {
    const hash = this.hashMessage(message);

    if (this.cache.has(hash)) {
      return this.cache.get(hash)!;
    }

    let tokens = this.countContent(message.content);

    if (message.toolCalls) {
      for (const call of message.toolCalls) {
        tokens += this.countText(JSON.stringify(call.args));
      }
    }

    if (message.toolResults) {
      for (const result of message.toolResults) {
        tokens += this.countText(result.result);
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

    for (const msg of messages) {
      const hash = this.hashMessage(msg);
      let cached = this.breakdownCache.get(hash);

      if (!cached) {
        let content = this.countContent(msg.content);
        let tcTokens = 0;
        if (msg.toolCalls) {
          for (const call of msg.toolCalls) {
            tcTokens += this.countText(JSON.stringify(call.args));
          }
        }
        let trTokens = 0;
        if (msg.toolResults) {
          for (const result of msg.toolResults) {
            trTokens += this.countText(result.result);
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
      const sysTokens = this.countText(systemPrompt);
      breakdown.systemPrompt += sysTokens;
      breakdown.total += sysTokens;
    }

    return breakdown;
  }

  private countContent(content: MessageContent): number {
    if (!content) return 0;
    if (typeof content === "string") {
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
    // First 64 chars as discriminator — cheap and collision-resistant enough
    const contentPrefix = text.slice(0, 64).replace(/\s+/g, " ");
    return `${message.role}:${contentLen}:${message.timestamp || 0}:${message.toolCalls?.length || 0}:${message.toolResults?.length || 0}:${contentPrefix}`;
  }
}

