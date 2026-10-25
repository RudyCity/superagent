/**
 * Bounded reconnect controller for a T-Line API transport. Side-effect-free:
 * only GET /_transport/health or GET /api/status may be retried. An existing
 * chat POST, tool call or /api/init resume is never dispatched automatically.
 */
export type TlineReconnectPhase =
  "connected" | "retrying" | "offline" | "auth_required" |
  "explicit_resume_required" | "review_required";
export interface TlineReconnectState {
  phase: TlineReconnectPhase;
  sessionId: string;
  attempt: number;
  nextRetryAt?: number;
  reason?: string;
}
export interface TlineReconnectLimits {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}
export const DEFAULT_TLINE_RECONNECT: Readonly<TlineReconnectLimits> = {
  maxAttempts: 8, baseDelayMs: 350, maxDelayMs: 30_000,
};
function validId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function validate(l: TlineReconnectLimits): void {
  if (!Number.isInteger(l.maxAttempts) || l.maxAttempts < 1 || l.maxAttempts > 20 ||
      !Number.isSafeInteger(l.baseDelayMs) || l.baseDelayMs < 100 ||
      !Number.isSafeInteger(l.maxDelayMs) || l.maxDelayMs < l.baseDelayMs ||
      l.maxDelayMs > 120_000) throw new Error("Unsafe T-Line retry policy");
}
export function newTlineReconnectState(sessionId: string): TlineReconnectState {
  if (!validId(sessionId)) throw new Error("Invalid T-Line sessionId");
  return { phase: "connected", sessionId, attempt: 0 };
}
export const TLINE_RECONNECT_ALLOWED_METHODS = ["GET"] as const;
export function isSafeTlineReconnectRequest(method: string, pathname: string): boolean {
  return method.toUpperCase() === "GET" &&
    (pathname === "/_transport/health" || pathname === "/api/status");
}
export function retryTlineHealthProbe(
  s: TlineReconnectState, now: number, jitter = 0.5,
  limits: TlineReconnectLimits = DEFAULT_TLINE_RECONNECT,
): TlineReconnectState {
  validate(limits);
  if (!Number.isSafeInteger(now) || now < 0 ||
      !Number.isFinite(jitter) || jitter < 0 || jitter > 1) throw new Error("Invalid retry timing");
  if (s.phase === "auth_required" || s.phase === "explicit_resume_required" ||
      s.phase === "review_required") return s;
  if (s.attempt >= limits.maxAttempts) return {
    sessionId: s.sessionId, attempt: s.attempt, phase: "offline",
    reason: "RETRY_BUDGET_EXHAUSTED",
  };
  const attempt = s.attempt + 1;
  const delay = Math.min(limits.maxDelayMs, limits.baseDelayMs * (2 ** (attempt - 1)));
  return { sessionId: s.sessionId, attempt, phase: "retrying",
    nextRetryAt: now + Math.floor(delay * (0.5 + jitter * 0.5)),
    reason: "HEALTH_PROBE_ONLY",
  };
}
export function classifyTlineReconnectResponse(
  s: TlineReconnectState, statusCode: number, errorCode?: string,
): TlineReconnectState {
  if (statusCode === 200) return { sessionId: s.sessionId, phase: "connected", attempt: 0 };
  if (statusCode === 401 || statusCode === 403) return {
    ...s, phase: "auth_required", nextRetryAt: undefined, reason: "REAUTHENTICATE",
  };
  if (statusCode === 409) return {
    ...s, phase: "review_required", nextRetryAt: undefined, reason: "HISTORY_REVIEW",
  };
  if (statusCode === 503 && ["SESSION_OWNER_UNAVAILABLE", "SESSION_WORKER_DEAD"].includes(errorCode || ""))
    return { ...s, phase: "explicit_resume_required", nextRetryAt: undefined,
      reason: "USER_EXPLICIT_RESUME_REQUIRED" };
  if (statusCode >= 500 || statusCode === 0) return {
    ...s, phase: "offline", nextRetryAt: undefined, reason: "HEALTH_PROBE_RETRYABLE",
  };
  return { ...s, phase: "review_required", nextRetryAt: undefined,
    reason: "UNEXPECTED_RESPONSE" };
}
export interface TlineResumeApproval {
  sessionId: string; workspace: string; mode: "single" | "multi";
  approvedByUser: boolean; ambiguousTurns: number;
  durableHistorySavedAt?: number; lastAcceptedTurnAt?: number;
}
export function explicitTlineResumePayload(a: TlineResumeApproval) {
  if (!a.approvedByUser || !validId(a.sessionId) || !a.workspace ||
      a.workspace.length > 4096 || /[\x00-\x1f\x7f]/.test(a.workspace) ||
      !Number.isSafeInteger(a.ambiguousTurns) || a.ambiguousTurns !== 0 ||
      !Number.isSafeInteger(a.durableHistorySavedAt) ||
      a.durableHistorySavedAt! < (a.lastAcceptedTurnAt ?? 0))
    throw new Error("Unverified explicit T-Line resume");
  return { sessionId: a.sessionId, resume: a.sessionId, workspace: a.workspace, mode: a.mode };
}
