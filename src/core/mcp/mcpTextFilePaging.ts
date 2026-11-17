import fs from "node:fs";

export interface McpFilePage {
  rows: Array<{ line: number; text: string }>;
  totalBytes: number;
  scannedBytes: number;
  nextOffsetBytes: number;
  nextStartLine: number;
  hasMore: boolean;
  partialLine: boolean;
}

export interface McpFilePageOptions {
  startLine?: number;
  endLine?: number;
  offsetBytes?: number;
  maxBytes?: number;
  maxLines?: number;
}

const READ_CHUNK_BYTES = 8 * 1024;

/** Byte-cursor paging for MCP text files. Skips large prefixes without buffering them. */
export async function readMcpTextFilePage(filePath: string, opts: McpFilePageOptions = {}): Promise<McpFilePage> {
  const startLine = Number.isFinite(opts.startLine) ? Math.max(1, Math.floor(opts.startLine!)) : 1;
  const endLine = Number.isFinite(opts.endLine) ? Math.max(0, Math.floor(opts.endLine!)) : Infinity;
  const maxLines = Number.isFinite(opts.maxLines) ? Math.max(1, Math.min(200, Math.floor(opts.maxLines!))) : 200;
  const maxBytes = Number.isFinite(opts.maxBytes) ? Math.max(256, Math.min(32_768, Math.floor(opts.maxBytes!))) : 16_384;
  const offsetBytes = Number.isFinite(opts.offsetBytes) ? Math.max(0, Math.floor(opts.offsetBytes!)) : 0;
  const fd = await fs.promises.open(filePath, "r");
  try {
    const { size: totalBytes } = await fd.stat();
    if (offsetBytes > totalBytes) throw new Error("File byte cursor is outside the file");
    const rows: McpFilePage["rows"] = [];
    const parts: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let line = offsetBytes > 0 ? startLine : 1;
    let position = offsetBytes;
    let scannedBytes = 0;
    let outputBytes = 0;
    const makePage = (nextOffsetBytes: number, hasMore: boolean, partialLine: boolean): McpFilePage => ({
      rows, totalBytes, scannedBytes, nextOffsetBytes, nextStartLine: line, hasMore, partialLine,
    });
    if (endLine < startLine) return makePage(position, false, false);
    while (position < totalBytes) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, totalBytes - position), position);
      if (!bytesRead) break;
      scannedBytes += bytesRead;
      let from = 0;
      while (from < bytesRead) {
        const end = buffer.indexOf(10, from);
        const newline = end !== -1 && end < bytesRead;
        const until = newline ? end : bytesRead;
        const segment = buffer.subarray(from, until);
        const selected = line >= startLine && line <= endLine;
        if (selected) {
          const remaining = maxBytes - outputBytes;
          if (segment.length > remaining) {
            const prefix = Buffer.concat([...parts, segment.subarray(0, remaining)]);
            let safeBytes = prefix.length;
            if ((segment[remaining] & 0xc0) === 0x80) {
              while (safeBytes > 0 && (prefix[safeBytes - 1] & 0xc0) === 0x80) safeBytes--;
              if (safeBytes > 0) safeBytes--;
            }
            const removedBytes = prefix.length - safeBytes;
            rows.push({ line, text: prefix.subarray(0, safeBytes).toString("utf8") });
            return makePage(position + from + remaining - removedBytes, true, true);
          }
          if (segment.length) parts.push(Buffer.from(segment));
          outputBytes += segment.length;
        }
        if (!newline) break;
        if (selected) {
          rows.push({ line, text: Buffer.concat(parts).toString("utf8").replace(/\r$/, "") });
          parts.length = 0;
        }
        line++;
        const nextOffset = position + end + 1;
        if (line > endLine) return makePage(nextOffset, false, false);
        if (rows.length >= maxLines) return makePage(nextOffset, nextOffset < totalBytes, false);
        from = end + 1;
      }
      position += bytesRead;
    }
    if (line >= startLine && line <= endLine && rows.length < maxLines) {
      rows.push({ line, text: Buffer.concat(parts).toString("utf8").replace(/\r$/, "") });
    }
    return makePage(position, false, false);
  } finally {
    await fd.close();
  }
}
