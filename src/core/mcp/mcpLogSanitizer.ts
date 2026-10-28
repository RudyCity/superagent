/**
 * mcpLogSanitizer.ts - Redaction and bounded payloads for MCP audit and diagnostic logging.
 *
 * Rules:
 * - Keys matching sensitive patterns (authorization, token, secret, password,
 *   api key, cookie, credential, private key, bearer, session) are redacted.
 * - Long string values (file contents, command output) are truncated.
 * - Circular structures are handled safely.
 * - Sanitization never throws; failures degrade to a placeholder.
 * - Activity payloads are strictly bounded to prevent multi-megabyte journal spikes.
 */

import crypto from "node:crypto";

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_RE =
  /authorization|token|secret|password|passwd|pwd|api[-_ ]?key|expectedurl|cookie|credential|private[-_ ]?key|bearer|session/i;

const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ITEMS = 50;
const MAX_DEPTH = 10;
const MAX_SUMMARY_LENGTH = 500;

export interface BoundedActivityOutput {
  preview?: string;
  originalBytes: number;
  truncated: boolean;
  sha256: string;
  artifactRef?: string;
}

export const MAX_ACTIVITY_OUTPUT_PREVIEW = 16_384;
export const MAX_ACTIVITY_ERROR_PREVIEW = 16_384;
export const MAX_ACTIVITY_ARGS_PREVIEW = 16_384;
export const MAX_ACTIVITY_RECORD_BYTES = 65_536;

/**
 * Truncate a UTF-8 string so its encoded byte length is <= maxBytes.
 * Guarantees that multi-byte code points are never split, preventing
 * corrupt characters or replacement character bloat.
 */
export function truncateUtf8Bytes(str: string, maxBytes: number): string {
  if (maxBytes <= 0 || !str) return "";
  const buf = Buffer.from(str, "utf8");
  if (buf.byteLength <= maxBytes) return str;

  let end = maxBytes;
  // If buf[end - 1] is a continuation byte (bits 10xxxxxx), walk back to find its lead byte
  while (end > 0 && (buf[end - 1] & 0xc0) === 0x80) {
    end--;
  }

  // Now end is positioned at a boundary or lead byte
  if (end > 0) {
    const lead = buf[end - 1];
    if ((lead & 0x80) !== 0) {
      let charLen = 1;
      if ((lead & 0xe0) === 0xc0) charLen = 2;
      else if ((lead & 0xf0) === 0xe0) charLen = 3;
      else if ((lead & 0xf8) === 0xf0) charLen = 4;

      if (end - 1 + charLen <= maxBytes) {
        end = end - 1 + charLen;
      } else {
        end = end - 1;
      }
    }
  }

  return buf.toString("utf8", 0, end);
}

/**
 * Common base64 media signatures:
 * - PNG: iVBORw0KGgo
 * - JPEG: /9j/
 * - GIF: R0lGOD
 * - PDF: JVBERi0
 * - WebP: UklGR
 * - ZIP: UEsDB
 * - OGG: T2dnUw
 */
const KNOWN_BASE64_MEDIA_PREFIXES = [
  "iVBORw0KGgo",
  "/9j/",
  "R0lGOD",
  "JVBERi0",
  "UklGR",
  "UEsDB",
  "T2dnUw",
];

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
    // Tool payloads are commonly JSON encoded inside a string, so an ordinary
    // object-key redactor otherwise misses embedded sessionToken credentials.
    const trimmed = value.trim();
    if (trimmed.length <= 64_000 && (trimmed.startsWith("{") || trimmed.startsWith("["))) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          return JSON.stringify(sanitizeInner(parsed, depth + 1, seen));
        }
      } catch { /* arbitrary text, not a JSON tool payload */ }
    }
    const safe = value
      .replace(/(Bearer\s+)[a-zA-Z0-9._~+\/-]+/gi, "$1[REDACTED]")
      .replace(/((?:sessionToken|api[_-]?key|authorization|password)\s*[:=]\s*["']?)[^\s"'&,}]+/gi, "$1[REDACTED]");
    return safe.length > MAX_STRING_LENGTH
      ? safe.slice(0, 200) + `...[truncated ${safe.length} chars]`
      : safe;
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
export function summarizeArgs(args: unknown, maxBytes = MAX_SUMMARY_LENGTH): string {
  try {
    const sanitized = sanitizeValue(args);
    const s = JSON.stringify(sanitized) ?? "<undefined>";
    if (Buffer.byteLength(s, "utf8") <= maxBytes) {
      return s;
    }
    const suffix = "...(truncated)";
    const suffixBytes = Buffer.byteLength(suffix, "utf8");
    const targetBytes = Math.max(0, maxBytes - suffixBytes);
    return truncateUtf8Bytes(s, targetBytes) + suffix;
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

/**
 * Detect base64 data URI or raw base64 media payload.
 */
export function detectBase64Media(text: string): { isMedia: boolean; mimeType?: string; sizeEstimate?: number } {
  if (typeof text !== "string") return { isMedia: false };
  const trimmed = text.trim();
  const dataUriMatch = trimmed.match(/^data:([a-zA-Z0-9\/+.-]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (dataUriMatch) {
    const mime = dataUriMatch[1];
    const b64Data = dataUriMatch[2].replace(/\s+/g, "");
    const size = Math.floor((b64Data.length * 3) / 4);
    return { isMedia: true, mimeType: mime, sizeEstimate: size };
  }

  // Check known base64 media prefixes for standalone binary payloads >= 512 chars
  if (trimmed.length >= 512) {
    for (const prefix of KNOWN_BASE64_MEDIA_PREFIXES) {
      if (trimmed.startsWith(prefix) && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed)) {
        const clean = trimmed.replace(/\s+/g, "");
        const size = Math.floor((clean.length * 3) / 4);
        return { isMedia: true, sizeEstimate: size };
      }
    }
  }

  return { isMedia: false };
}

/**
 * Sanitize and bound an MCP tool output for activity logging.
 * Returns a bounded string preview and metadata (original byte size, sha256, truncation flag).
 * Raw base64 / media blobs are never retained in full.
 * Truncation is UTF-8 byte-safe: preview byte length is guaranteed <= MAX_ACTIVITY_OUTPUT_PREVIEW.
 */
export function sanitizeActivityOutput(
  output: unknown,
  artifactRef?: string,
  options?: { throttled?: boolean }
): { preview: string; meta: BoundedActivityOutput } {
  if (output === null || output === undefined) {
    return {
      preview: "",
      meta: {
        preview: "",
        originalBytes: 0,
        truncated: false,
        sha256: crypto.createHash("sha256").update("").digest("hex"),
        ...(artifactRef ? { artifactRef } : {}),
      },
    };
  }

  const str = typeof output === "string" ? output : JSON.stringify(output) ?? String(output);
  const originalBytes = Buffer.byteLength(str, "utf8");

  // Optional M8 memory-pressure guardrail: skip expensive SHA-256 calculation and large preview
  if (options?.throttled) {
    const preview = `[observability throttled under memory pressure: ${originalBytes} bytes]`;
    return {
      preview,
      meta: {
        preview,
        originalBytes,
        truncated: true,
        sha256: "throttled",
        ...(artifactRef ? { artifactRef } : {}),
      },
    };
  }

  const sha256 = crypto.createHash("sha256").update(str).digest("hex");

  const mediaCheck = detectBase64Media(str);
  if (mediaCheck.isMedia) {
    const mime = mediaCheck.mimeType ? `, mime=${mediaCheck.mimeType}` : "";
    const preview = `[base64 media: ${originalBytes} bytes${mime}, sha256: ${sha256.slice(0, 16)}...]`;
    return {
      preview,
      meta: {
        preview,
        originalBytes,
        truncated: true,
        sha256,
        ...(artifactRef ? { artifactRef } : {}),
      },
    };
  }

  if (originalBytes <= MAX_ACTIVITY_OUTPUT_PREVIEW) {
    return {
      preview: str,
      meta: {
        preview: str,
        originalBytes,
        truncated: false,
        sha256,
        ...(artifactRef ? { artifactRef } : {}),
      },
    };
  }

  // UTF-8 byte-safe truncation ensuring total preview bytes <= MAX_ACTIVITY_OUTPUT_PREVIEW
  const omittedBytes = originalBytes - MAX_ACTIVITY_OUTPUT_PREVIEW;
  const suffix = `\n...[output truncated: ${omittedBytes} bytes omitted]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const targetBytes = Math.max(0, MAX_ACTIVITY_OUTPUT_PREVIEW - suffixBytes);
  const truncatedPreview = truncateUtf8Bytes(str, targetBytes) + suffix;

  return {
    preview: truncatedPreview,
    meta: {
      preview: truncatedPreview,
      originalBytes,
      truncated: true,
      sha256,
      ...(artifactRef ? { artifactRef } : {}),
    },
  };
}

/**
 * Sanitize and bound an MCP error message for activity logging.
 * Byte-safe: error preview bytes are guaranteed <= MAX_ACTIVITY_ERROR_PREVIEW.
 */
export function sanitizeActivityError(error: unknown): string {
  if (error === null || error === undefined) return "";
  const str = typeof error === "string" ? error : (error as any)?.message ? String((error as any).message) : String(error);
  if (Buffer.byteLength(str, "utf8") <= MAX_ACTIVITY_ERROR_PREVIEW) {
    return str;
  }
  const suffix = "\n...[error truncated]";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const targetBytes = Math.max(0, MAX_ACTIVITY_ERROR_PREVIEW - suffixBytes);
  return truncateUtf8Bytes(str, targetBytes) + suffix;
}

/**
 * Sanitize and bound MCP arguments for activity logging.
 */
export function sanitizeActivityArgs(args: unknown): unknown {
  if (args === null || args === undefined) return args;
  try {
    const sanitized = sanitizeValue(args);
    const jsonStr = JSON.stringify(sanitized);
    if (jsonStr && Buffer.byteLength(jsonStr, "utf8") > MAX_ACTIVITY_ARGS_PREVIEW) {
      // Keep summary within max bytes, reserving space for the wrapper JSON object
      const maxSummaryBytes = Math.max(100, MAX_ACTIVITY_ARGS_PREVIEW - 64);
      return { _truncated: true, summary: summarizeArgs(args, maxSummaryBytes) };
    }
    return sanitized;
  } catch {
    return "[unserializable args]";
  }
}

function pruneStringsAndArrays(obj: unknown, maxStringBytes: number, maxArrayLength: number, depth = 0): unknown {
  if (depth > 8) return "[nested]";
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    if (Buffer.byteLength(obj, "utf8") > maxStringBytes) {
      return truncateUtf8Bytes(obj, maxStringBytes) + "...[truncated]";
    }
    return obj;
  }
  if (typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    return obj.slice(0, maxArrayLength).map(item => pruneStringsAndArrays(item, maxStringBytes, maxArrayLength, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    result[k] = pruneStringsAndArrays(v, maxStringBytes, maxArrayLength, depth + 1);
  }
  return result;
}

/**
 * Serialize an entry to JSONL with hard byte cap enforcement.
 * Guarantees that the returned JSON line is ALWAYS <= maxBytes (default 64 KB),
 * even when given arbitrary huge unknown metadata, oversized workspace, args, or previews.
 */
export function serializeBoundedJournalEntry(
  entry: Record<string, any>,
  maxBytes = MAX_ACTIVITY_RECORD_BYTES
): string {
  try {
    let serialized = JSON.stringify(entry);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      return serialized;
    }

    // Pass 1: truncate known large fields
    const pass1: Record<string, any> = { ...entry };
    if (pass1.event && typeof pass1.event === "object") {
      pass1.event = { ...pass1.event };
      if (typeof pass1.event.output === "string") {
        pass1.event.output = truncateUtf8Bytes(pass1.event.output, 512) + "...[truncated]";
      }
      if (typeof pass1.event.error === "string") {
        pass1.event.error = truncateUtf8Bytes(pass1.event.error, 512) + "...[truncated]";
      }
      if (pass1.event.outputMeta && typeof pass1.event.outputMeta === "object") {
        pass1.event.outputMeta = {
          ...pass1.event.outputMeta,
          preview: typeof pass1.event.outputMeta.preview === "string"
            ? truncateUtf8Bytes(pass1.event.outputMeta.preview, 512) + "...[truncated]"
            : pass1.event.outputMeta.preview,
        };
      }
      if (pass1.event.args !== undefined) {
        const sArgs = JSON.stringify(pass1.event.args);
        if (sArgs && Buffer.byteLength(sArgs, "utf8") > 1024) {
          pass1.event.args = "[oversized args omitted]";
        }
      }
    }
    if (typeof pass1.chatLine === "string") {
      pass1.chatLine = truncateUtf8Bytes(pass1.chatLine, 512) + "...[truncated]";
    }
    if (typeof pass1.workspace === "string" && Buffer.byteLength(pass1.workspace, "utf8") > 512) {
      pass1.workspace = truncateUtf8Bytes(pass1.workspace, 512) + "...[truncated]";
    }

    serialized = JSON.stringify(pass1);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      return serialized;
    }

    // Pass 2: Prune all strings across the entire object to <= 256 bytes, arrays <= 20
    const pass2 = pruneStringsAndArrays(pass1, 256, 20) as Record<string, any>;
    serialized = JSON.stringify(pass2);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      return serialized;
    }

    // Pass 3: Prune all strings to <= 64 bytes, arrays <= 5
    const pass3 = pruneStringsAndArrays(pass2, 64, 5) as Record<string, any>;
    serialized = JSON.stringify(pass3);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      return serialized;
    }

    // Pass 4: Retain minimal standard identity schema only (drops arbitrary huge unknown metadata)
    const pass4: Record<string, any> = {
      ts: entry.ts ?? entry.timestamp ?? Date.now(),
      pid: typeof entry.pid === "number" ? entry.pid : process.pid,
      workspace: typeof entry.workspace === "string" ? truncateUtf8Bytes(entry.workspace, 128) : undefined,
      chatLine: typeof entry.chatLine === "string" ? truncateUtf8Bytes(entry.chatLine, 256) : undefined,
      _truncatedForCap: true,
    };
    if (entry.event && typeof entry.event === "object") {
      pass4.event = {
        type: entry.event.type,
        tool: entry.event.tool ?? entry.event.toolName,
        ok: entry.event.ok,
        durationMs: entry.event.durationMs,
        output: typeof entry.event.output === "string" ? truncateUtf8Bytes(entry.event.output, 256) : undefined,
        error: typeof entry.event.error === "string" ? truncateUtf8Bytes(entry.event.error, 256) : undefined,
        _truncated: true,
      };
    }
    serialized = JSON.stringify(pass4);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      return serialized;
    }

    // Pass 5: Absolute emergency fallback guaranteed to be < 120 bytes
    return JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      type: "activity_record_oversized",
      _truncatedForCap: true,
    });
  } catch {
    return JSON.stringify({
      ts: Date.now(),
      pid: process.pid,
      type: "activity_record_error",
      _truncatedForCap: true,
    });
  }
}
