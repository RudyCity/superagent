import { Message } from "../conversation";

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

    let tokens = this.countText(message.content);

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
        systemPrompt += this.countText(msg.content);
      } else {
        messagesTokens += this.countText(msg.content);
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
    return `${message.role}:${message.content.length}:${message.toolCalls?.length || 0}:${message.toolResults?.length || 0}`;
  }
}
