import type { ChatLine } from "../core/slash-commands.js";

export function capDisplayLines(text: string, maxLines: number, width: number): { text: string; truncated: boolean } {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\t/g, "    ");
  const rawLines = normalized.split("\n");
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

// Strip ANSI/SGR escape codes to get the visible character length of a string
function visibleLength(str: string): number {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length;
}

const wrapCache = new Map<string, string[]>();
const MAX_CACHE_SIZE = 4000;

export function wrapTextForDisplay(text: string, width: number): string[] {
  const cacheKey = `${width}:${text}`;
  const cached = wrapCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const safeWidth = Math.max(10, width);
  const wrapped: string[] = [];
  // Normalize \r\n -> \n, strip bare \r (defensive: prevents col-0 bleed if \r slips through)
  // Replace tabs with 4 spaces to avoid layout breaking
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\t/g, "    ");
  for (const rawLine of normalized.split("\n")) {
    // Use visible length to avoid splitting inside ANSI escape sequences
    if (visibleLength(rawLine) <= safeWidth) {
      wrapped.push(rawLine);
      continue;
    }
    // Walk the string character by character, tracking visible width
    let lineStart = 0;
    let visibleCount = 0;
    let i = 0;
    while (i < rawLine.length) {
      // Detect ANSI escape sequence and skip it (count 0 visible chars)
      // eslint-disable-next-line no-control-regex
      if (rawLine[i] === "\x1b" && rawLine[i + 1] === "[") {
        let j = i + 2;
        while (j < rawLine.length && !/[A-Za-z]/.test(rawLine[j])) j++;
        i = j + 1; // skip past the escape sequence
        continue;
      }
      visibleCount++;
      i++;
      if (visibleCount >= safeWidth) {
        wrapped.push(rawLine.slice(lineStart, i));
        lineStart = i;
        visibleCount = 0;
      }
    }
    if (lineStart < rawLine.length) {
      wrapped.push(rawLine.slice(lineStart));
    }
  }
  const result = wrapped.length > 0 ? wrapped : [""];

  if (wrapCache.size >= MAX_CACHE_SIZE) {
    const firstKey = wrapCache.keys().next().value;
    if (firstKey !== undefined) {
      wrapCache.delete(firstKey);
    }
  }
  wrapCache.set(cacheKey, result);

  return result;
}

export function renderScrollBar(offset: number, windowHeight: number, totalLines: number): string {
  const width = 10;
  if (totalLines <= windowHeight) return `[${"■".repeat(width)}]`;
  const maxOffset = Math.max(1, totalLines - windowHeight);
  const ratio = offset / maxOffset;
  const filled = Math.max(1, Math.min(width, Math.round(ratio * (width - 1)) + 1));
  return `[${"■".repeat(filled)}${"□".repeat(width - filled)}]`;
}
