import path from "node:path";

export type PatchOperation =
  | Readonly<{
      kind: "replace_block";
      startLine: number;
      endLine: number;
      expectedSnippet?: string;
      replacement: string;
    }>
  | Readonly<{
      kind: "insert_before";
      line: number;
      expectedLineSnippet?: string;
      content: string;
    }>
  | Readonly<{
      kind: "insert_after";
      line: number;
      expectedLineSnippet?: string;
      content: string;
    }>;

export function detectLineEnding(rawText: string): "\r\n" | "\n" {
  return rawText.includes("\r\n") ? "\r\n" : "\n";
}

export function applyLinePatchOperations(
  rawText: string,
  operations: readonly PatchOperation[],
): string {
  const eol = detectLineEnding(rawText);
  const lines = rawText.replace(/\r\n/g, "\n").split("\n");
  const totalLines = lines.length;

  // Sort descending so earlier line indices remain valid across mutations.
  const indexed = operations.map((op, index) => ({ op, index })).sort((a, b) => {
    const lineA = a.op.kind === "replace_block" ? a.op.startLine : a.op.line;
    const lineB = b.op.kind === "replace_block" ? b.op.startLine : b.op.line;
    if (lineB !== lineA) return lineB - lineA;
    return b.index - a.index;
  });

  for (const { op } of indexed) {
    if (op.kind === "replace_block") {
      if (
        !Number.isInteger(op.startLine) ||
        !Number.isInteger(op.endLine) ||
        op.startLine < 1 ||
        op.endLine < op.startLine ||
        op.endLine > totalLines
      ) {
        throw new Error(`Invalid replace_block range ${op.startLine}..${op.endLine} for ${totalLines} lines.`);
      }
      if (op.expectedSnippet !== undefined) {
        const currentSlice = lines.slice(op.startLine - 1, op.endLine).join("\n");
        if (!currentSlice.includes(op.expectedSnippet.replace(/\r\n/g, "\n"))) {
          throw new Error(`Expected snippet mismatch on lines ${op.startLine}..${op.endLine}.`);
        }
      }
      const replacementLines = op.replacement.replace(/\r\n/g, "\n").split("\n");
      lines.splice(op.startLine - 1, op.endLine - op.startLine + 1, ...replacementLines);
    } else if (op.kind === "insert_before") {
      if (!Number.isInteger(op.line) || op.line < 1 || op.line > totalLines + 1) {
        throw new Error(`Invalid insert_before line ${op.line} for ${totalLines} lines.`);
      }
      if (op.expectedLineSnippet !== undefined && op.line <= totalLines) {
        const currentLine = lines[op.line - 1] ?? "";
        if (!currentLine.includes(op.expectedLineSnippet.replace(/\r\n/g, "\n"))) {
          throw new Error(`Expected line snippet mismatch on line ${op.line}.`);
        }
      }
      const insertLines = op.content.replace(/\r\n/g, "\n").split("\n");
      lines.splice(op.line - 1, 0, ...insertLines);
    } else if (op.kind === "insert_after") {
      if (!Number.isInteger(op.line) || op.line < 0 || op.line > totalLines) {
        throw new Error(`Invalid insert_after line ${op.line} for ${totalLines} lines.`);
      }
      if (op.expectedLineSnippet !== undefined && op.line >= 1) {
        const currentLine = lines[op.line - 1] ?? "";
        if (!currentLine.includes(op.expectedLineSnippet.replace(/\r\n/g, "\n"))) {
          throw new Error(`Expected line snippet mismatch on line ${op.line}.`);
        }
      }
      const insertLines = op.content.replace(/\r\n/g, "\n").split("\n");
      lines.splice(op.line, 0, ...insertLines);
    }
  }

  return lines.join("\n").replace(/\n/g, eol);
}

export function isPatchableTargetFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".py", ".rs", ".toml", ".yaml", ".yml", ".css", ".html"].includes(ext);
}
