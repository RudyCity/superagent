import { recordCompactionToDb, getCompactionHistoryFromDb, clearCompactionHistoryInDb } from "../storage/historyDb.js";

export interface CompactionEvent {
  id: string;
  timestamp: number;
  strategy: string;
  messagesBefore: number;
  messagesAfter: number;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  summaryTokens?: number;
  pinnedMessages?: string[];
  reason: "threshold" | "emergency" | "manual";
}

export class CompactionHistory {
  private events: CompactionEvent[] = [];
  private maxHistory = 50;

  constructor() {
    this.load();
  }

  async record(event: CompactionEvent): Promise<void> {
    this.events.push(event);

    if (this.events.length > this.maxHistory) {
      this.events = this.events.slice(-this.maxHistory);
    }

    try {
      recordCompactionToDb({
        id: event.id,
        timestamp: event.timestamp,
        strategy: event.strategy,
        messagesBefore: event.messagesBefore,
        messagesAfter: event.messagesAfter,
        tokensBefore: event.tokensBefore,
        tokensAfter: event.tokensAfter,
        summary: event.summary,
        summaryTokens: event.summaryTokens,
        pinnedMessages: event.pinnedMessages ? JSON.stringify(event.pinnedMessages) : undefined,
        reason: event.reason,
      });
    } catch {}
  }

  getHistory(): CompactionEvent[] {
    return [...this.events];
  }

  getLastSummary(): CompactionEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].strategy === "summarization") {
        return this.events[i];
      }
    }
    return null;
  }

  getTokensSaved(): number {
    return this.events.reduce(
      (sum, event) => sum + (event.tokensBefore - event.tokensAfter),
      0
    );
  }

  getCompactionCount(): number {
    return this.events.length;
  }

  clear(): void {
    this.events = [];
    try {
      clearCompactionHistoryInDb();
    } catch {}
  }

  private load(): void {
    try {
      const dbRecords = getCompactionHistoryFromDb(this.maxHistory);
      if (dbRecords.length > 0) {
        this.events = dbRecords.map((r) => ({
          id: r.id,
          timestamp: r.timestamp,
          strategy: r.strategy,
          messagesBefore: r.messagesBefore,
          messagesAfter: r.messagesAfter,
          tokensBefore: r.tokensBefore,
          tokensAfter: r.tokensAfter,
          summary: r.summary,
          summaryTokens: r.summaryTokens,
          pinnedMessages: r.pinnedMessages ? JSON.parse(r.pinnedMessages) : undefined,
          reason: r.reason as any,
        }));
      }
    } catch {}
  }
}
