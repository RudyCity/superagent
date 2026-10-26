/**
 * One-shot T-Line connection probe. Never automatically issues a state-changing
 * API call. A desktop/terminal caller owns scheduling and UI state transitions.
 */
import {
  classifyTlineReconnectResponse, isSafeTlineReconnectRequest,
  type TlineReconnectState,
} from "./tlineReconnectPolicy.js";

type RequestFn = typeof fetch;
export interface TlineProbeResult {
  state: TlineReconnectState;
  frontDoorReady: boolean;
  coreReady: boolean;
  sessionVerified: boolean;
  inferencePhase?: "healthy" | "degraded" | "disabled" | "unknown";
  issuedMethods: readonly ["GET"] | readonly ["GET", "GET"];
}
const localBase = (url: string): string => {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" ||
      !u.port || u.username || u.password || u.search || u.hash ||
      u.pathname !== "/") throw new Error("T-Line probe requires a loopback front door URL");
  return u.origin;
};
const payload = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const raw = await response.text();
    if (raw.length > 8192) return {};
    const value: unknown = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ?
      value as Record<string, unknown> : {};
  } catch { return {}; }
};
export async function probeTlineSessionOnce(input: {
  frontDoor: string;
  bearer: string;
  state: TlineReconnectState;
  fetchFn?: RequestFn;
}): Promise<TlineProbeResult> {
  const base = localBase(input.frontDoor);
  const request = input.fetchFn ?? fetch;
  if (!/^[a-f0-9]{48}$/.test(input.bearer)) throw new Error("Invalid local Core bearer");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.state.sessionId)) {
    throw new Error("Invalid reconnect session ID");
  }
  if (!isSafeTlineReconnectRequest("GET", "/_transport/health") ||
      !isSafeTlineReconnectRequest("GET", "/api/status")) throw new Error("Unsafe read-only route");
  let health: Response;
  try {
    health = await request(base + "/_transport/health", {
      method: "GET", signal: AbortSignal.timeout(2500), redirect: "error",
    });
  } catch {
    return { state: classifyTlineReconnectResponse(input.state, 0),
      frontDoorReady: false, coreReady: false, sessionVerified: false, issuedMethods: ["GET"] };
  }
  const status = await payload(health);
  if (health.status !== 200 || status.service !== "superagent-transport-host" ||
      status.backendReady !== true) {
    return { state: classifyTlineReconnectResponse(input.state, 503, "CORE_SUPERVISOR_UNAVAILABLE"),
      frontDoorReady: health.status === 200, coreReady: false, sessionVerified: false,
      issuedMethods: ["GET"] };
  }
  let session: Response;
  try {
    session = await request(base + "/api/status?sessionId=" + encodeURIComponent(input.state.sessionId), {
      method: "GET",
      headers: { Authorization: "Bearer " + input.bearer, "x-client-mode": "tline" },
      signal: AbortSignal.timeout(2500), redirect: "error",
    });
  } catch {
    return { state: classifyTlineReconnectResponse(input.state, 0),
      frontDoorReady: true, coreReady: true, sessionVerified: false,
      issuedMethods: ["GET", "GET"] };
  }
  const body = await payload(session);
  const phase = session.status === 200 && body.sessionId !== input.state.sessionId
    ? { ...input.state, phase: "explicit_resume_required" as const,
      nextRetryAt: undefined, reason: "SESSION_NOT_BOUND_NO_REPLAY" }
    : classifyTlineReconnectResponse(input.state, session.status,
      typeof body.code === "string" ? body.code : undefined);
  const readiness=body.senopatiInference;
  const inferencePhase=readiness && typeof readiness==="object" &&
      !Array.isArray(readiness) &&
      ["healthy","degraded","disabled"].includes(
        String((readiness as Record<string,unknown>).phase)) ?
      (readiness as {phase:"healthy"|"degraded"|"disabled"}).phase : "unknown";
  // The classifier is optional. A degraded model must not turn an authenticated,
  // healthy chat session into a disconnected session or replay any action.
  return { state: phase, frontDoorReady: true, coreReady: true,
    sessionVerified: phase.phase === "connected",inferencePhase,
    issuedMethods: ["GET", "GET"] };
}
