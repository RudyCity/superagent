/**
 * Process-local aggregate of MCP HTTP session registries.
 *
 * Providers expose counts/ages only. No session IDs, OAuth subjects or
 * credential hashes ever enter this telemetry surface.
 */
import type { McpSessionRegistryStats } from "./mcpSessionRegistry.js";

const providers = new Map<number, () => McpSessionRegistryStats>();
let nextProviderId = 1;

export interface McpProcessSessionTelemetry {
  registries: number;
  activeSessions: number;
  activePrincipals: number;
  largestPrincipalSessionCount: number;
  oldestSessionAgeMs: number;
  oldestIdleMs: number;
  createdTotal: number;
  removedTotal: number;
  rejectedTotal: number;
}

export function registerMcpSessionTelemetry(
  provider: () => McpSessionRegistryStats,
): () => void {
  const id = nextProviderId++;
  providers.set(id, provider);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    providers.delete(id);
  };
}

export function getMcpProcessSessionTelemetry(): McpProcessSessionTelemetry {
  const aggregate: McpProcessSessionTelemetry = {
    registries: 0, activeSessions: 0, activePrincipals: 0,
    largestPrincipalSessionCount: 0, oldestSessionAgeMs: 0, oldestIdleMs: 0,
    createdTotal: 0, removedTotal: 0, rejectedTotal: 0,
  };
  for (const provider of providers.values()) {
    try {
      const value = provider();
      aggregate.registries++;
      aggregate.activeSessions += value.activeSessions;
      aggregate.activePrincipals += value.activePrincipals;
      aggregate.largestPrincipalSessionCount = Math.max(
        aggregate.largestPrincipalSessionCount,
        value.largestPrincipalSessionCount,
      );
      aggregate.oldestSessionAgeMs = Math.max(
        aggregate.oldestSessionAgeMs, value.oldestSessionAgeMs,
      );
      aggregate.oldestIdleMs = Math.max(aggregate.oldestIdleMs, value.oldestIdleMs);
      aggregate.createdTotal += value.createdTotal;
      aggregate.removedTotal += value.removedTotal;
      aggregate.rejectedTotal += value.rejectedGlobal + value.rejectedPrincipal;
    } catch {
      // Diagnostics must not affect MCP request handling.
    }
  }
  return aggregate;
}

export function __resetMcpSessionTelemetryForTests(): void {
  providers.clear();
  nextProviderId = 1;
}
