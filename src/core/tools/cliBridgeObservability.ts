import crypto from "node:crypto";

/** Never persist raw delegated prompts by default. Only a length and one-way digest. */
export function summarizedPrompt(prompt: string): string {
  return `promptLength=${prompt.length} sha256=${crypto.createHash("sha256").update(prompt).digest("hex")}`;
}

/** Best-effort redaction for common secret formats in untrusted CLI output.
 * Arbitrary user-defined secrets cannot be detected reliably; use protected workspaces.
 */
export function redactCliBridgeOutput(text: string): string {
  return text
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"'<>]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{14,})\b/g, "[REDACTED_API_KEY]")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{16,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[REDACTED_TOKEN]")
    .replace(/((?:API[_-]?KEY|ACCESS[_-]?TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|BOT[_-]?TOKEN)\s*[:=]\s*["']?)[^\s"'<>]+/gi, "$1[REDACTED]");
}

/** Read only a bounded tail instead of materializing an entire multi-GB job log. */
export async function readBoundedLogTail(
  logPath: string, limitLines = 200, maxBytes = 512 * 1024,
): Promise<string> {
  const fs = await import("node:fs/promises");
  const count = Math.max(1, Math.min(2000, Math.floor(limitLines) || 200));
  const handle = await fs.open(logPath, "r");
  try {
    const stats = await handle.stat();
    const bytes = Math.min(stats.size, Math.min(Math.max(4096, maxBytes), 1024 * 1024));
    const position = Math.max(0, stats.size - bytes);
    const buffer = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, position);
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (position > 0) content = content.slice(content.indexOf("\n") + 1);
    return redactCliBridgeOutput(content.split(/\r?\n/).slice(-count).join("\n"));
  } finally {
    await handle.close();
  }
}

/** Page persisted CLI log output without buffering the whole file. Caller must authorize job/session first. */
export async function readCliLogPage(logPath: string, offsetBytes = 0, maxBytes = 12_000): Promise<{
  text: string; totalBytes: number; offsetBytes: number; nextOffsetBytes: number; hasMore: boolean;
}> {
  if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0) throw new Error("offsetBytes must be a non-negative integer.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 256) throw new Error("maxBytes must be at least 256.");
  const fs = await import("node:fs/promises");
  const handle = await fs.open(logPath, "r");
  try {
    const totalBytes = (await handle.stat()).size;
    const start = Math.min(offsetBytes, totalBytes);
    const byteCount = Math.min(32_000, maxBytes, totalBytes - start);
    const buffer = Buffer.alloc(byteCount);
    const { bytesRead } = await handle.read(buffer, 0, byteCount, start);
    let beginning = 0;
    while (beginning < bytesRead && (buffer[beginning] & 0xc0) === 0x80) beginning++;
    let end = bytesRead;
    if (start + bytesRead < totalBytes) {
      while (end > beginning && (buffer[end - 1] & 0xc0) === 0x80) end--;
      if (end > beginning) end--; // Retry last codepoint on next page.
    }
    const count = end > beginning ? end : bytesRead;
    const nextOffsetBytes = start + count;
    return {
      text: redactCliBridgeOutput(buffer.subarray(beginning, count).toString("utf8")),
      totalBytes, offsetBytes: start + beginning, nextOffsetBytes, hasMore: nextOffsetBytes < totalBytes,
    };
  } finally {
    await handle.close();
  }
}
