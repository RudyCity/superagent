/**
 * Exact, negation-aware consent parsing for an already pending, materialized plan.
 * Approval MUST be bound to the plan being reviewed and must never rely on substring
 * matches such as "setuju" inside "tidak setuju".
 */
const APPROVAL_PHRASES = new Set([
  "ya", "iya", "yes", "y", "ok", "oke", "okay", "sip", "siap",
  "setuju", "saya setuju", "aku setuju", "saya menyetujui", "approve",
  "approved", "lgtm", "konfirmasi", "confirm", "lanjut",
  "lanjutkan", "silakan lanjut", "silahkan lanjut", "proceed", "go ahead",
  "gas", "boleh", "aku izinkan", "saya izinkan", "lanjut implementasi",
]);
const DENIAL_PHRASES = /\b(?:tidak|tak|bukan|belum|jangan|jgn|ga|gak|nggak|enggak|no|not|never|cancel|batal|stop|hentikan|tanpa|without|only|hanya|cuma|janganlah|belum|ditunda)\b/i;
const CONDITIONAL_PHRASES = /\b(?:kalau|jika|asal|asalkan|tetapi|tapi|namun|except|unless|after|before|sebelum|sesudah|nanti|mungkin|maybe|perhaps)\b/i;

export function normalizeApprovalText(input: string): string {
  return input.normalize("NFKC").toLowerCase().trim()
    .replace(/^[\s.,!?'"()[\]{}]+|[\s.,!?'"()[\]{}]+$/g, "")
    .replace(/\s+/g, " ");
}

/** Only explicit, unconditional approval of a pending real plan counts. */
export function isExplicitPlanApproval(input: string): boolean {
  const message = normalizeApprovalText(input);
  if (!message || DENIAL_PHRASES.test(message) || CONDITIONAL_PHRASES.test(message)) return false;
  return APPROVAL_PHRASES.has(message);
}

/** Used only to recognize a continuation utterance, not to grant consent. */
export function isExactContinuation(input: string): boolean {
  const message = normalizeApprovalText(input);
  return APPROVAL_PHRASES.has(message) || message === "next" || message === "continue" || message === "teruskan";
}
