import fs from "fs";

/**
 * Read at most the last `maxBytes` of a file without loading it entirely.
 *
 * Useful for log viewers that only need the most recent output: reading a
 * multi-megabyte log synchronously on every keypress blocks the UI thread.
 * When the file is larger than `maxBytes`, the first (likely partial) line of
 * the returned text is dropped. Returns "" when the file cannot be read.
 */
export function readFileTail(filePath: string, maxBytes: number = 16 * 1024): string {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf-8");
    if (start > 0) {
      // Drop the first partial line introduced by the byte offset.
      const firstNewline = text.indexOf("\n");
      if (firstNewline !== -1) {
        text = text.slice(firstNewline + 1);
      }
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors — the read already succeeded or failed above.
      }
    }
  }
}
