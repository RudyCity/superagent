import { Message, MessageContent } from "../conversation";

export interface TokenBreakdown {
  systemPrompt: number;
  messages: number;
  toolCalls: number;
  toolResults: number;
  total: number;
}

export class TokenTracker {
  private model: string;
  private cache: Map<string, number> = new Map();
  private encoder: any = null;

  constructor(model: string) {
    this.model = model;
    this.initEncoder();
  }

  private async initEncoder(): Promise<void> {
    try {
      const { get_encoding } = await import("tiktoken");
      this.encoder = get_encoding("cl100k_base");
    } catch {
      this.encoder = null;
    }
  }

  setModel(model: string): void {
    this.model = model;
    this.cache.clear();
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

    this.cache.set(hash, tokens);
    return tokens;
  }

  estimateTokensForAll(messages: Message[]): TokenBreakdown {
    let systemPrompt = 0;
    let messagesTokens = 0;
    let toolCalls = 0;
    let toolResults = 0;

    for (const msg of messages) {
      if (msg.role === "system") {
        systemPrompt += this.countContent(msg.content);
      } else {
        messagesTokens += this.countContent(msg.content);
      }

      if (msg.toolCalls) {
        for (const call of msg.toolCalls) {
          toolCalls += this.countText(JSON.stringify(call.args));
        }
      }

      if (msg.toolResults) {
        for (const result of msg.toolResults) {
          toolResults += this.countText(result.result);
        }
      }
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

  private hashMessage(message: Message): string {
    const contentLen = typeof message.content === "string"
      ? message.content.length
      : message.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 0), 0);
    return `${message.role}:${contentLen}:${message.toolCalls?.length || 0}:${message.toolResults?.length || 0}`;
  }
}
