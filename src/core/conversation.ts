import fs from "fs/promises";
import path from "path";

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  result: string;
  isError?: boolean;
}

export class Conversation {
  private messages: Message[] = [];
  private maxHistory = 50;

  async saveToFile(filePath: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(this.messages, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save history:", err);
    }
  }

  async loadFromFile(filePath: string): Promise<void> {
    try {
      const data = await fs.readFile(filePath, "utf-8");
      this.messages = JSON.parse(data);
    } catch (err: any) {
      if (err.code !== "ENOENT") {
        console.error("Failed to load history:", err);
      }
    }
  }

  addMessage(msg: Message): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxHistory) {
      this.messages = this.messages.slice(-this.maxHistory);
    }
  }

  addUserMessage(content: string): void {
    this.addMessage({
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }

  addAssistantMessage(
    content: string,
    toolCalls?: ToolCall[],
    toolResults?: ToolResult[]
  ): void {
    this.addMessage({
      role: "assistant",
      content,
      toolCalls,
      toolResults,
      timestamp: Date.now(),
    });
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getApiMessages(): Array<{
    role: "user" | "assistant";
    content: string;
  }> {
    return this.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
  }

  clear(): void {
    this.messages = [];
  }

  getCompactSummary(): string {
    if (this.messages.length === 0) return "No messages yet.";
    const userMsgs = this.messages.filter((m) => m.role === "user").length;
    const assistantMsgs = this.messages.filter(
      (m) => m.role === "assistant"
    ).length;
    return `${this.messages.length} messages (${userMsgs} user, ${assistantMsgs} assistant)`;
  }

  getTokenEstimate(): number {
    return this.messages.reduce(
      (sum, m) => sum + Math.ceil(m.content.length / 4),
      0
    );
  }
}
