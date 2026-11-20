/**
 * Sanitizes structured Delegate browser MCP error strings so safe
 * `DELEGATE_(WEB|CDP|LEASE)_*` codes surface while tokens/URLs stay redacted.
 */
export function sanitizeDelegateBrowserDispatchError(result: string): string {
  return result.match(/\b(DELEGATE_(?:WEB|CDP|LEASE)_[A-Z0-9_]+)\b/)?.[1] || "DELEGATE_MCP_TOOL_FAILED";
}
