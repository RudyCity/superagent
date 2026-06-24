import fs from "fs/promises";
import path from "path";

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
  private filePath?: string;
  private isLoaded = false;
  private loadingPromise: Promise<void>;

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath) {
      this.loadingPromise = this.load()
        .then(() => {
          this.isLoaded = true;
        })
        .catch(() => {
          this.isLoaded = true;
        });
    } else {
      this.isLoaded = true;
      this.loadingPromise = Promise.resolve();
    }
  }

  async record(event: CompactionEvent): Promise<void> {
    if (!this.isLoaded) {
      await this.loadingPromise;
    }

    this.events.push(event);

    if (this.events.length > this.maxHistory) {
      this.events = this.events.slice(-this.maxHistory);
    }

    if (this.filePath) {
      this.save().catch((err) => {
        console.error("Failed to save compaction history:", err);
      });
    }
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
    if (this.filePath) {
      this.save().catch(() => {});
    }
  }

  private async save(): Promise<void> {
    if (!this.filePath) return;

    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(
        this.filePath,
        JSON.stringify(this.events, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.error("Failed to save compaction history:", err);
    }
  }

  private async load(): Promise<void> {
    if (!this.filePath) return;

    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      this.events = JSON.parse(data);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error("Failed to load compaction history:", err);
      }
    }
  }
}
