/**
 * Allocation-light schema validation for the opt-in compact Senopati V2 candidate.
 * Mirrors the reference shadow constructor's candidate, schema, vector and label
 * invariants without constructing/retaining a second JS object per record.
 * Not a trust or tool authorization decision.
 */
import { SENOPATI_V2_HEADS, type SenopatiV2SparsePayload } from "./senopatiV2Shadow.js";

const HEADS = ["domain", "intent", "action", "risk", "approval"] as const;
const FEATURE_RE = /^[wbpcs]:/;
const MAX_RECORDS = 10_000;
const MAX_FEATURES_PER_RECORD = 600;

/** Throws before compact index construction when an untrusted candidate is invalid. */
export function validateSenopatiV2CompactCandidate(value: unknown): asserts value is SenopatiV2SparsePayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid / unapproved Senopati V2 candidate manifest");
  }
  const candidate = value as Partial<SenopatiV2SparsePayload>;
  if (candidate.format !== "senopati-v2-sparse-baseline" ||
      candidate.deployment !== "candidate-only" ||
      !Array.isArray(candidate.records) ||
      candidate.records.length === 0 || candidate.records.length > MAX_RECORDS) {
    throw new Error("Invalid / unapproved Senopati V2 candidate manifest");
  }
  for (const head of HEADS) {
    const expected = SENOPATI_V2_HEADS[head] as readonly string[];
    const actual = candidate.heads?.[head];
    if (!Array.isArray(actual) || actual.length !== expected.length ||
        actual.some((label, i) => label !== expected[i])) {
      throw new Error("Incompatible Senopati V2 label order: " + head);
    }
  }
  for (const record of candidate.records) {
    if (typeof record !== "object" || record === null ||
        typeof record.features !== "object" || record.features === null ||
        Object.keys(record.features).length > MAX_FEATURES_PER_RECORD) {
      throw new Error("Invalid Senopati V2 vector");
    }
    for (const [key, weight] of Object.entries(record.features)) {
      if (!FEATURE_RE.test(key) || typeof weight !== "number" ||
          !Number.isFinite(weight) || weight < 0 || weight > 10) {
        throw new Error("Invalid Senopati V2 vector weight");
      }
    }
    for (const head of HEADS) {
      if (!(SENOPATI_V2_HEADS[head] as readonly string[]).includes(record[head])) {
        throw new Error("Invalid Senopati V2 training label: " + head);
      }
    }
  }
}
