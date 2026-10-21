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
