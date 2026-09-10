/**
 * Utility functions for real-time terminal output streaming and carriage-return normalization.
 */

/**
 * Resolves carriage return characters (`\r`) in streamed terminal text.
 * Simulates terminal cursor movement to line start so that progress bars,
 * tickers, and download counters overwrite the active line rather than creating
 * fragmented duplicate lines.
 */
export function resolveCarriageReturns(input: string): string {
  if (!input || !input.includes("\r")) return input || "";

  // Normalize CRLF into standard newline first so only standalone \r remain
  const normalized = input.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const processedLines = lines.map((line) => {
    if (!line.includes("\r")) return line;
    const parts = line.split("\r");

    let current = "";
    for (const part of parts) {
      if (part.length >= current.length) {
        current = part;
      } else {
        // Overlay part on top of existing current text
        current = part + current.slice(part.length);
      }
    }
    return current;
  });

  return processedLines.join("\n");
}

/**
 * Extracts the most recent N lines of output from a streaming text buffer,
 * with carriage-return normalization applied.
 */
export function getTerminalTailLines(text: string, maxLines: number = 10): string[] {
  if (!text) return [];
  const resolved = resolveCarriageReturns(text);
  const rawLines = resolved.split("\n");

  // Trim trailing empty line if text ended with newline
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  return rawLines.slice(-maxLines);
}
