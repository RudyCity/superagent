/**
 * Safe, pure declarative text layout helper for SuperAgent Studio.
 * Handles explicit newlines (\n) and boundary-constrained word wrapping.
 */

/**
 * Splits text into lines respecting explicit newlines and optional maximum line width.
 * If measureFn is provided (e.g. ctx.measureText(line).width), uses exact measured widths.
 * If maxWidth is provided without measureFn, uses a standard proportional character-width heuristic.
 */
export function splitTextLines(
  text: string,
  maxWidth?: number,
  measureFn?: (line: string) => number,
): string[] {
  if (typeof text !== "string" || text.length === 0) return [""];
  const rawParagraphs = text.split("\n");
  if (!maxWidth || maxWidth <= 0) {
    return rawParagraphs;
  }
  const result: string[] = [];
  const measure = measureFn ?? ((str: string) => str.length * 10);
  for (const paragraph of rawParagraphs) {
    if (!paragraph.trim()) {
      result.push("");
      continue;
    }
    const words = paragraph.split(" ");
    let currentLine = "";
    for (const word of words) {
      if (!currentLine) {
        currentLine = word;
        continue;
      }
      const candidate = `${currentLine} ${word}`;
      if (measure(candidate) <= maxWidth) {
        currentLine = candidate;
      } else {
        result.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) {
      result.push(currentLine);
    }
  }
  return result.length > 0 ? result : [""];
}
