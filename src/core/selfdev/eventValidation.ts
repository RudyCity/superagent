import { randomUUID } from "node:crypto";
import { SELFDEV_EVENT_KINDS, SELFDEV_LIMITS as L, type SelfDevEvent, type SelfDevEventKind } from "./types.js";

export class SelfDevValidationError extends Error {
  constructor() { super("Invalid self-development evidence input"); this.name = "SelfDevValidationError"; }
}
export function invalid(): never { throw new SelfDevValidationError(); }

/** Inspect own data only: no getters, custom prototypes, symbol keys, or hidden data. */
export function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) return invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return invalid();
  }
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return invalid();
  return value;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
export function kind(value: unknown): SelfDevEventKind {
  if (typeof value !== "string" || !SELFDEV_EVENT_KINDS.includes(value as SelfDevEventKind)) return invalid();
  return value as SelfDevEventKind;
}
export function stringList(value: unknown, count: number, length: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > count) return invalid();
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !("value" in d)) return invalid();
    result.push(text(d.value, length));
  }
  return [...new Set(result)];
}
const MASK = "[REDACTED]";
const secretPatterns = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z]+ )?PRIVATE KEY-----|$)/g,
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]+/gi,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie|client[_-]?secret)\b["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
];
function redactor() {
  let count = 0;
  return {
    redact(value: string): string {
      for (const pattern of secretPatterns) value = value.replace(pattern, () => { count++; return MASK; });
      return value;
    },
    mask(): string { count++; return MASK; },
    count(): number { return count; },
  };
}
export function identity(value: unknown, max = L.MAX_CONTEXT_ID_LENGTH): string {
  const result = text(value, max);
  if (redactor().redact(result) !== result) invalid();
  return result;
}
function sensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(?:secret|password|passwd|token|apikey|authorization|cookie|credential|privatekey)/.test(normalized)
    || /^(?:transcript|rawtranscript|messages|conversation|prompt|rawprompt|completion|stdout|stderr|rawoutput|rawinput|command|commandline|input|output|body|content)$/.test(normalized);
}

/** Bounded walk rejects non-JSON values even beneath fields that will be masked. */
export function validateEvent(input: unknown, workspace: string): SelfDevEvent {
  const data = dataRecord(input);
  fields(data, ["id", "ts", "sessionId", "workspace", "kind", "summary", "evidence", "tags", "payload"]);
  if (identity(data.workspace) !== workspace) invalid();
  const id = data.id === undefined ? randomUUID() : identity(data.id, L.MAX_EVIDENCE_ID_LENGTH);
  const sessionId = identity(data.sessionId);
  const ts = data.ts === undefined ? Date.now() : integer(data.ts);
  const eventKind = kind(data.kind);
  const summary = text(data.summary, L.MAX_SUMMARY_LENGTH);
  const evidence = stringList(data.evidence, L.MAX_EVIDENCE_ITEMS, L.MAX_EVIDENCE_ID_LENGTH);
  const tags = stringList(data.tags, L.MAX_TAGS, L.MAX_TAG_LENGTH);
  const redact = redactor();
  const ancestors = new Set<object>();
  let budget = 0;
  let nodes = 0;
  const charge = (amount: number): void => { budget += amount; if (budget > L.MAX_PAYLOAD_JSON_LENGTH) invalid(); };
  const walk = (value: unknown, depth: number): unknown => {
    if (++nodes > 2048 || depth > 8) return invalid();
    if (value === null || typeof value === "boolean") { charge(5); return value; }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return invalid();
      charge(String(value).length + 1); return value;
    }
    if (typeof value === "string") { charge(value.length + 2); return redact.redact(value); }
    if (!value || typeof value !== "object" || ancestors.has(value)) return invalid();
    ancestors.add(value);
    charge(2);
    let result: unknown;
    if (Array.isArray(value)) {
      if (value.length > 2048 || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
      const array: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !("value" in d)) return invalid();
        charge(1); array.push(walk(d.value, depth + 1));
      }
      result = array;
    } else {
      const object = dataRecord(value);
      const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, child] of Object.entries(object)) {
        charge(key.length + 4);
        const sanitized = walk(child, depth + 1);
        const cleanKey = redact.redact(key);
        if (Object.hasOwn(clean, cleanKey)) return invalid();
        clean[cleanKey] = sensitiveKey(key) ? redact.mask() : sanitized;
      }
      result = clean;
    }
    ancestors.delete(value);
    return result;
  };
  let payload: Record<string, unknown> | undefined;
  if (data.payload !== undefined) {
    dataRecord(data.payload);
    payload = walk(data.payload, 0) as Record<string, unknown>;
    if (JSON.stringify(payload).length > L.MAX_PAYLOAD_JSON_LENGTH) invalid();
  }
  const event: SelfDevEvent = {
    id, ts, sessionId, workspace, kind: eventKind, summary: redact.redact(summary),
    evidence: evidence.map(value => redact.redact(value)), tags: tags.map(value => redact.redact(value)),
    ...(payload === undefined ? {} : { payload }), redactionCount: redact.count(),
  };
  // Replacement text must not push otherwise-valid fields beyond shared limits.
  text(event.summary, L.MAX_SUMMARY_LENGTH);
  stringList(event.evidence, L.MAX_EVIDENCE_ITEMS, L.MAX_EVIDENCE_ID_LENGTH);
  stringList(event.tags, L.MAX_TAGS, L.MAX_TAG_LENGTH);
  return event;
}
