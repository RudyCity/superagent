import fs from "node:fs";

const LOG_TAIL_BYTES = 64 * 1024;
const LOG_READ_CHUNK_BYTES = 8 * 1024;

/** Read only the tail of an owned log file, never materialize unbounded files in MCP. */
export function readBoundedLogTail(filePath: string, requestedLines: number): {
  text: string;
  clippedByBytes: boolean;
  readBytes: number;
  totalBytes: number;
} {
  const maxLines = Number.isFinite(requestedLines)
    ? Math.max(1, Math.min(200, Math.floor(requestedLines))) : 50;
  const fd = fs.openSync(filePath, "r");
  try {
    const totalBytes = fs.fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let position = totalBytes;
    let readBytes = 0;
    let newlines = 0;
    while (position > 0 && readBytes < LOG_TAIL_BYTES && newlines <= maxLines) {
      const amount = Math.min(position, LOG_READ_CHUNK_BYTES, LOG_TAIL_BYTES - readBytes);
      const chunk = Buffer.allocUnsafe(amount);
      const bytesRead = fs.readSync(fd, chunk, 0, amount, position - amount);
      if (bytesRead === 0) break;
      const part = chunk.subarray(0, bytesRead);
      chunks.push(part);
      for (const byte of part) if (byte === 10) newlines++;
      position -= bytesRead;
      readBytes += bytesRead;
    }
    const content = Buffer.concat(chunks.reverse()).toString("utf8");
    const lines = content.split(/\r?\n/);
    return {
      text: lines.slice(-maxLines).join("\n"),
      clippedByBytes: position > 0 && newlines <= maxLines,
      readBytes,
      totalBytes,
    };
  } finally {
    fs.closeSync(fd);
  }
}
