import { Message, MessageContent, contentToString } from "../conversation.js";
import { getSettings } from "../config.js";

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

let sharedEncoder: any = null;
let sharedEncoderReady: Promise<void> | null = null;

async function getSharedEncoder(): Promise<any> {
  if (sharedEncoder) return sharedEncoder;
  if (!sharedEncoderReady) {
    sharedEncoderReady = (async () => {
      try {
        const { get_encoding } = await import("tiktoken");
        sharedEncoder = get_encoding("cl100k_base");
      } catch {
        sharedEncoder = null;
      }
    })();
  }
  await sharedEncoderReady;
  return sharedEncoder;
}

export class TokenTracker {
  private model: string;
  private cache: Map<string, number> = new Map();
  private breakdownCache: Map<string, { content: number; toolCalls: number; toolResults: number }> = new Map();
  /** Resolved once tiktoken is ready (or failed). Await before first count. */
  private encoderReady: Promise<void>;

  constructor(model: string) {
    this.model = model;
    this.encoderReady = this.initEncoder();
  }

  private async initEncoder(): Promise<void> {
    await getSharedEncoder();
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

  static modelSupportsVision(modelName: string): boolean {
    if (!modelName) return false;
    const name = modelName.toLowerCase();
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
    return false;
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
        const resultStr = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
        tokens += this.countText(resultStr);
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
            const resultStr = typeof result.result === "string" ? result.result : JSON.stringify(result.result);
            trTokens += this.countText(resultStr);
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

    const encoder = sharedEncoder;
    if (encoder) {
      try {
        return encoder.encode(text).length;
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
   * Stable hash computed WITHOUT materializing the full joined content string.
   * Walks content parts accumulating total length plus 64-char head/tail slices,
   * mirroring contentToString's join(" ") semantics for identity purposes.
   */
  private hashMessage(message: Message): string {
    const segments =
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.map((p) => (p && p.type === "text" ? p.text : "[image]"))
          : [];

    let contentLen = 0;
    let head = "";
    let tail = "";
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (i > 0) {
        contentLen += 1;
        if (head.length < 64) head += " ";
      }
      contentLen += seg.length;
      if (head.length < 64) head += seg.slice(0, 64 - head.length);
    }
    let remaining = 64;
    for (let i = segments.length - 1; i >= 0 && remaining > 0; i--) {
      const seg = segments[i];
      const take = Math.min(remaining, seg.length);
      tail = seg.slice(seg.length - take) + tail;
      remaining -= take;
      if (remaining > 0 && i > 0) {
        tail = " " + tail;
        remaining -= 1;
      }
    }

    const normalizedHead = head.replace(/\s+/g, " ");
    const normalizedTail = tail.replace(/\s+/g, " ");
    return `${message.role}:${contentLen}:${message.timestamp || 0}:${message.toolCalls?.length || 0}:${message.toolResults?.length || 0}:${normalizedHead}:${normalizedTail}`;
  }
}

