import { Message, MessageContent } from "../conversation";

/** Extract plain text from a MessageContent (string or parts array) */
function contentText(c: MessageContent): string {
  return typeof c === "string" ? c : c.map(p => p.type === "text" ? p.text : "").join("");
}

export interface SemanticChunk {
  messages: Message[];
  startIndex: number;
  endIndex: number;
  topic?: string;
}

export interface KeyPoint {
  messageIndex: number;
  type: "decision" | "requirement" | "error" | "conclusion";
  content: string;
}

export class SemanticAnalyzer {
  detectTopicBoundaries(messages: Message[]): number[] {
    const boundaries = [0];

    for (let i = 1; i < messages.length; i++) {
      const prev = messages[i - 1];
      const curr = messages[i];

      // Signal 1: New user message after non-user (strong boundary)
      if (curr.role === "user" && prev.role !== "user") {
        boundaries.push(i);
        continue;
      }

      // Signal 2: File path change
      const prevFiles = this.extractFilePaths(contentText(prev.content));
      const currFiles = this.extractFilePaths(contentText(curr.content));
      if (prevFiles.length > 0 && currFiles.length > 0) {
        const overlap = prevFiles.filter((f) => currFiles.includes(f)).length;
        if (overlap === 0) {
          boundaries.push(i);
          continue;
        }
      }

      // Signal 3: Time gap (>5 minutes)
      if (curr.timestamp - prev.timestamp > 5 * 60 * 1000) {
        boundaries.push(i);
      }
    }

    return boundaries;
  }

  splitIntoChunks(messages: Message[]): SemanticChunk[] {
    const boundaries = this.detectTopicBoundaries(messages);
    const chunks: SemanticChunk[] = [];

    for (let i = 0; i < boundaries.length; i++) {
      const start = boundaries[i];
      const end = i < boundaries.length - 1 ? boundaries[i + 1] : messages.length;

      chunks.push({
        messages: messages.slice(start, end),
        startIndex: start,
        endIndex: end - 1,
      });
    }

    return chunks;
  }

  scoreImportance(message: Message): number {
    let score = 50;

    if (this.containsDecision(message)) score += 30;
    if (this.containsArchitectureChoice(message)) score += 25;
    if (this.containsUserRequirement(message)) score += 20;
    if (this.containsErrorMessage(message)) score += 15;
    if (this.containsFilePath(message)) score += 10;

    if (this.isRoutineToolCall(message)) score -= 20;
    if (this.isVerboseOutput(message)) score -= 15;

    return Math.max(0, Math.min(100, score));
  }

  extractKeyPoints(messages: Message[]): KeyPoint[] {
    const keyPoints: KeyPoint[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const score = this.scoreImportance(msg);

      if (score >= 75) {
        let type: KeyPoint["type"] = "conclusion";

        if (this.containsDecision(msg)) type = "decision";
        else if (this.containsUserRequirement(msg)) type = "requirement";
        else if (this.containsErrorMessage(msg)) type = "error";

        keyPoints.push({
          messageIndex: i,
          type,
          content: contentText(msg.content).substring(0, 200),
        });
      }
    }

    return keyPoints;
  }

  private extractFilePaths(text: string): string[] {
    const matches = text.match(
      /(?:\/|\\|\b)[\w.-]+(?:\/|\\)[\w.-]+(?:\.\w+)?/g
    );
    return matches || [];
  }

  private containsDecision(message: Message): boolean {
    const patterns = [
      /we (?:decided|will use|chose|selected)/i,
      /let's (?:use|go with|implement)/i,
      /the (?:best|right) (?:approach|solution|way)/i,
      /conclusion:/i,
    ];
    return patterns.some((p) => p.test(contentText(message.content)));
  }

  private containsArchitectureChoice(message: Message): boolean {
    const patterns = [
      /architecture/i,
      /design pattern/i,
      /we'll (?:structure|organize)/i,
      /component (?:structure|hierarchy)/i,
    ];
    return patterns.some((p) => p.test(contentText(message.content)));
  }

  private containsUserRequirement(message: Message): boolean {
    return (
      message.role === "user" &&
      (/i (?:need|want|require)/i.test(contentText(message.content)) ||
        /please (?:add|implement|create)/i.test(contentText(message.content)))
    );
  }

  private containsErrorMessage(message: Message): boolean {
    return /error|failed|exception|warning/i.test(contentText(message.content));
  }

  private containsFilePath(message: Message): boolean {
    return this.extractFilePaths(contentText(message.content)).length > 0;
  }

  private isRoutineToolCall(message: Message): boolean {
    return (
      message.toolCalls?.some((tc) =>
        ["read_file", "list_directory", "grep"].includes(tc.name)
      ) || false
    );
  }

  private isVerboseOutput(message: Message): boolean {
    const text = contentText(message.content);
    return text.length > 2000 && text.split("\n").length > 50;
  }
}
