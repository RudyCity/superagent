/**
 * Supervisor-owned session affinity. No agent history, tokens or permissions
 * are stored here; only the origin worker for a successfully initialized ID.
 * The backend remains responsible for workspace/client-mode authorization.
 */
export interface CoreOwner {
  pid: number;
  port: number;
  since: number;
}

export interface CoreSessionRequest {
  sessionId?: string;
  pathname: string;
  isSessionRegistration: boolean;
  parseBody: boolean;
}

const BODY_SESSION_PATHS = new Set(["/api/init", "/api/chat", "/api/switch-workspace"]);
const REGISTRATION_PATHS = new Set(["/api/init", "/api/switch-workspace"]);
export const CORE_ROUTING_BODY_LIMIT = 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TRACKED_SESSIONS = 20_000;

export function validCoreSessionId(candidate: unknown): string | undefined {
  if (typeof candidate !== "string") return undefined;
  // Reject control characters BEFORE trimming, so CRLF prefixes never become
  // valid routing IDs after normalization.
  if (/[\x00-\x1f\x7f]/.test(candidate)) return undefined;
  const value = candidate.trim();
  return value && value.length <= MAX_SESSION_ID_LENGTH
    ? value
    : undefined;
}

function firstValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = validCoreSessionId(value);
    if (result) return result;
  }
  return undefined;
}

export function inspectCoreSessionRequest(
  rawUrl: string | undefined,
  method: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  jsonBody?: string,
): CoreSessionRequest {
  const url = new URL(rawUrl || "/", "http://127.0.0.1");
  const pathname = url.pathname;
  const isPost = method?.toUpperCase() === "POST";
  const parseBody = Boolean(isPost && BODY_SESSION_PATHS.has(pathname));
  let body: Record<string, unknown> = {};
  if (parseBody && jsonBody) {
    try {
      const parsed: unknown = JSON.parse(jsonBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {}
  }
  const headerId = headers["x-superagent-session-id"];
  const sessionId = firstValue(
    Array.isArray(headerId) ? headerId[0] : headerId,
    url.searchParams.get("sessionId"),
    pathname === "/api/history" ? url.searchParams.get("id") : undefined,
    body.sessionId,
    pathname === "/api/init" ? body.resume : undefined,
    pathname === "/api/switch-workspace" ? body.id : undefined,
  );
  return {
    sessionId,
    pathname,
    isSessionRegistration: Boolean(isPost && REGISTRATION_PATHS.has(pathname)),
    parseBody,
  };
}

export class CoreSessionAffinity {
  private readonly sessions = new Map<string, CoreOwner>();

  get count(): number { return this.sessions.size; }

  countForOwner(owner: CoreOwner): number {
    let count = 0;
    for (const assigned of this.sessions.values()) {
      if (assigned.pid === owner.pid && assigned.port === owner.port) count++;
    }
    return count;
  }

  resolve(sessionId: string | undefined, fallback: CoreOwner): CoreOwner {
    return sessionId && this.sessions.get(sessionId) || fallback;
  }

  isKnown(sessionId: string | undefined): boolean {
    return Boolean(sessionId && this.sessions.has(sessionId));
  }

  /** Only register successful, server-authorized session init responses. */
  registerFromResponse(statusCode: number, rawBody: string, owner: CoreOwner, expectedId?: string): string | undefined {
    if (statusCode < 200 || statusCode >= 300 || rawBody.length > 16 * 1024) return;
    let payload: unknown;
    try { payload = JSON.parse(rawBody); }
    catch { return; }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const response = payload as Record<string, unknown>;
    if (response.success !== true) return;
    const sessionId = validCoreSessionId(response.sessionId);
    if (!sessionId || expectedId && expectedId !== sessionId) return;
    const existing = this.sessions.get(sessionId);
    if (existing && existing.pid !== owner.pid) return; // never silently hijack a running session
    if (!existing && this.sessions.size >= MAX_TRACKED_SESSIONS) return;
    this.sessions.set(sessionId, owner);
    return sessionId;
  }
}
