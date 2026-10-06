/**
 * mcpLogSanitizer.ts - Redaction for MCP audit and diagnostic logging.
 *
 * Rules:
 * - Keys matching sensitive patterns (authorization, token, secret, password,
 *   api key, cookie, credential, private key, bearer, session) are redacted.
 * - Long string values (file contents, command output) are truncated.
 * - Circular structures are handled safely.
 * - Sanitization never throws; failures degrade to a placeholder.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE =
  /authorization|token|secret|password|passwd|pwd|api[-_ ]?key|cookie|credential|private[-_ ]?key|bearer|session/i;

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 10;
const MAX_SUMMARY_LENGTH = 500;

/**
 * Recursively redact sensitive keys and truncate long values.
 * Never throws; returns a placeholder on unexpected failure.
 */
export function sanitizeValue(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  try {
    return sanitizeInner(value, depth, seen);
  } catch {
    return REDACTED;
  }
}

function sanitizeInner(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? value.slice(0, 200) + `...[truncated ${value.length} chars]`
      : value;
  }
  if (typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return REDACTED;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeInner(v, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : sanitizeInner(v, depth + 1, seen);
  }
  return out;
}

/**
 * Bounded, sanitized one-line summary of tool arguments for audit logs.
 * Includes a shape hint (top-level keys) without sensitive values.
 */
export function summarizeArgs(args: unknown, maxLength = MAX_SUMMARY_LENGTH): string {
  try {
    const sanitized = sanitizeValue(args);
    const s = JSON.stringify(sanitized) ?? "<undefined>";
    return s.length > maxLength ? s.slice(0, maxLength) + "...(truncated)" : s;
  } catch {
    return "<unserializable>";
  }
}

/**
 * Shape of arguments: top-level key names with value types, no values.
 * Useful for observability without leaking payloads.
 */
export function argShape(args: unknown): string {
  try {
    if (args === null || args === undefined) return String(args);
    if (typeof args !== "object") return typeof args;
    if (Array.isArray(args)) return `array[${args.length}]`;
    const parts = Object.entries(args as Record<string, unknown>).map(
      ([k, v]) => `${k}:${Array.isArray(v) ? "array" : typeof v}`
    );
    return `{${parts.join(", ")}}`;
  } catch {
    return "<unknown>";
  }
}
