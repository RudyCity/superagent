import type { ChatLine } from "../core/slash-commands.js";

export function capDisplayLines(text: string, maxLines: number, width: number): { text: string; truncated: boolean } {
  const rawLines = text.split("\n");
  let accumulated = 0;
  const resultLines: string[] = [];

  for (const line of rawLines) {
    const wrappedCount = Math.max(1, Math.ceil(line.length / Math.max(1, width)));
    if (accumulated + wrappedCount > maxLines) {
      return { text: resultLines.join("\n"), truncated: true };
    }
    accumulated += wrappedCount;
    resultLines.push(line);
  }

  return { text, truncated: false };
}

export function getTruncatedAssistantIndexes(lines: ChatLine[], maxLines: number, width: number): number[] {
  return lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.type === "assistant" && capDisplayLines(line.content, maxLines, width).truncated)
    .map(({ index }) => index);
}

export function wrapTextForDisplay(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const wrapped: string[] = [];
  for (const rawLine of text.split("\n")) {
    if (rawLine.length <= safeWidth) {
      wrapped.push(rawLine);
      continue;
    }
    for (let i = 0; i < rawLine.length; i += safeWidth) {
      wrapped.push(rawLine.slice(i, i + safeWidth));
    }
  }
  return wrapped.length > 0 ? wrapped : [""];
}

export function renderScrollBar(offset: number, windowHeight: number, totalLines: number): string {
  const width = 10;
  if (totalLines <= windowHeight) return `[${"■".repeat(width)}]`;
  const maxOffset = Math.max(1, totalLines - windowHeight);
  const ratio = offset / maxOffset;
  const filled = Math.max(1, Math.min(width, Math.round(ratio * (width - 1)) + 1));
  return `[${"■".repeat(filled)}${"□".repeat(width - filled)}]`;
}
