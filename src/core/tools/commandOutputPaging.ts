/** Bounded command previews with lossless, seekable on-disk command logs. */
import fs from "node:fs/promises";
import path from "node:path";
import { getCommandLogsDir } from "./commandLogger.js";

export const COMMAND_PREVIEW_CHARS = 24_000;

export function rollingCommandOutput(maxChars = COMMAND_PREVIEW_CHARS) {
  let tail = "";
  let totalChars = 0;
  return {
    append(chunk: string): void {
      totalChars += chunk.length;
      tail = (tail + chunk).slice(-maxChars);
    },
    preview(logId: string): string {
      return totalChars > tail.length
        ? "[Output preview: last " + tail.length + " of " + totalChars + " characters. Full output retained as commandId=" + logId + "; read it with offsetBytes/maxBytes.]\n" + tail
        : tail;
    },
    get totalChars(): number { return totalChars; },
    get clipped(): boolean { return totalChars > tail.length; },
  };
}

/** Only logs made by createCommandLog are retrievable. Never accept arbitrary paths. */
export async function readCommandOutputPage(
  commandId: string, authorizedWorkspace: string, offsetBytes = 0, maxBytes = 12_000,
): Promise<{ text: string; totalBytes: number; offsetBytes: number; nextOffsetBytes: number; hasMore: boolean }> {
  if (!/^cmd_\d{10,16}_[a-z0-9]{5}$/.test(commandId)) throw new Error("Invalid commandId.");
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) throw new Error("offsetBytes must be a non-negative integer.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error("maxBytes must be at least 256.");
  const filePath = path.join(getCommandLogsDir(), commandId + ".log");
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Invalid command log.");
  const handle = await fs.open(filePath, "r");
  try {
    // The persisted CWD is server-generated metadata, not a caller-supplied path.
    const header = Buffer.alloc(8192);
    const { bytesRead: headerBytes } = await handle.read(header, 0, header.length, 0);
    const cwd = header.subarray(0, headerBytes).toString("utf8").match(/(?:^|\n)CWD:\s+([^\r\n]+)/)?.[1];
    if (!cwd || !path.isAbsolute(cwd)) throw new Error("Command log has no valid workspace metadata.");
    const [realCwd, realWorkspace] = await Promise.all([fs.realpath(cwd), fs.realpath(authorizedWorkspace)]);
    const relative = path.relative(realWorkspace, realCwd);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Command log is outside the authorized workspace.");

    const totalBytes = (await handle.stat()).size;
    const start = Math.min(offsetBytes, totalBytes);
    const available = Math.min(Math.floor(maxBytes), 32_000, totalBytes - start);
    const buffer = Buffer.alloc(available);
    const { bytesRead } = await handle.read(buffer, 0, available, start);
    let beginning = 0;
    // Skip a partial UTF-8 rune when the caller supplies a non-boundary offset.
    while (beginning < bytesRead && (buffer[beginning] & 0xc0) === 0x80) beginning++;
    let end = bytesRead;
    if (start + bytesRead < totalBytes) {
      while (end > beginning && (buffer[end - 1] & 0xc0) === 0x80) end--;
      if (end > beginning) end--; // Retry the final codepoint on the next page.
    }
    const nextOffsetBytes = start + (end > beginning ? end : bytesRead);
    return {
      text: buffer.subarray(beginning, end > beginning ? end : bytesRead).toString("utf8"),
      totalBytes, offsetBytes: start + beginning, nextOffsetBytes,
      hasMore: nextOffsetBytes < totalBytes,
    };
  } finally {
    await handle.close();
  }
}
