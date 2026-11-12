import type { MemoryTrendAssessment } from "./memoryTrend.js";

export type McpMemoryRecoveryDecision =
  | { recover: true; reason: "sustained_memory_growth" }
  | { recover: false; reason:
      "trend_normal" | "backend_not_current" | "backend_not_alive" |
      "owner_busy" | "sessions_active" | "requests_in_flight" |
      "oauth_not_persistent" | "rate_limited" };

export function decideMcpMemoryRecovery(input: {
  trend: MemoryTrendAssessment;
  backendCurrent: boolean;
  backendAlive: boolean;
  ownerBusy: boolean;
  ownerSessions: number;
  backendSessions: number | null;
  inFlight: number;
  inFlightToolCalls: number;
  oauthPersistent: boolean;
  attemptsLastHour: number;
  maxAttemptsPerHour: number;
}): McpMemoryRecoveryDecision {
  if (!input.trend.suspicious) return { recover:false, reason:"trend_normal" };
  if (!input.backendCurrent) return { recover:false, reason:"backend_not_current" };
  if (!input.backendAlive) return { recover:false, reason:"backend_not_alive" };
  if (input.ownerBusy) return { recover:false, reason:"owner_busy" };
  if (input.ownerSessions > 0 || (input.backendSessions ?? 0) > 0)
    return { recover:false, reason:"sessions_active" };
  if (input.inFlight > 0 || input.inFlightToolCalls > 0)
    return { recover:false, reason:"requests_in_flight" };
  if (!input.oauthPersistent) return { recover:false, reason:"oauth_not_persistent" };
  if (input.attemptsLastHour >= input.maxAttemptsPerHour)
    return { recover:false, reason:"rate_limited" };
  return { recover:true, reason:"sustained_memory_growth" };
}
