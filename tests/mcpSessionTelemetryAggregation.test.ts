import { afterEach, describe, expect, it } from "vitest";
import {
  __resetMcpSessionTelemetryForTests,
  getMcpProcessSessionTelemetry,
  registerMcpSessionTelemetry,
} from "../src/core/mcp/mcpSessionTelemetry.js";
import type { McpSessionRegistryStats } from "../src/core/mcp/mcpSessionRegistry.js";

const sample = (values: Partial<McpSessionRegistryStats> = {}): McpSessionRegistryStats => ({
  activeSessions: 0,
  activePrincipals: 0,
  largestPrincipalSessionCount: 0,
  oldestSessionAgeMs: 0,
  oldestIdleMs: 0,
  maxSessions: 32,
  maxSessionsPerPrincipal: 8,
  createdTotal: 0,
  removedTotal: 0,
  rejectedGlobal: 0,
  rejectedPrincipal: 0,
  removals: {
    client_delete: 0,
    transport_close: 0,
    idle_timeout: 0,
    max_lifetime: 0,
    shutdown: 0,
    internal: 0,
  },
  ...values,
});

describe("MCP process-local session telemetry", () => {
  afterEach(__resetMcpSessionTelemetryForTests);

  it("aggregates registry counts and ages without exposing IDs or credentials", () => {
    const releaseA = registerMcpSessionTelemetry(() => sample({
      activeSessions: 3, activePrincipals: 2, largestPrincipalSessionCount: 2,
      oldestSessionAgeMs: 90_000, oldestIdleMs: 40_000, createdTotal: 7,
      removedTotal: 4, rejectedGlobal: 1, rejectedPrincipal: 2,
    }));
    const releaseB = registerMcpSessionTelemetry(() => sample({
      activeSessions: 1, activePrincipals: 1, largestPrincipalSessionCount: 1,
      oldestSessionAgeMs: 25_000, oldestIdleMs: 10_000, createdTotal: 2,
      removedTotal: 1, rejectedPrincipal: 1,
    }));
    const snapshot = getMcpProcessSessionTelemetry();
    expect(snapshot).toEqual({
      registries: 2, activeSessions: 4, activePrincipals: 3,
      largestPrincipalSessionCount: 2, oldestSessionAgeMs: 90_000,
      oldestIdleMs: 40_000, createdTotal: 9, removedTotal: 5,
      rejectedTotal: 4,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/credential|sessionId|subject|bearer/i);
    releaseA();
    releaseA();
    expect(getMcpProcessSessionTelemetry().registries).toBe(1);
    releaseB();
    expect(getMcpProcessSessionTelemetry().activeSessions).toBe(0);
  });

  it("isolates a failed diagnostic provider rather than breaking health reports", () => {
    const releaseBad = registerMcpSessionTelemetry(() => {
      throw new Error("diagnostic provider unavailable");
    });
    const releaseHealthy = registerMcpSessionTelemetry(() => sample({ activeSessions: 2 }));
    expect(getMcpProcessSessionTelemetry()).toMatchObject({
      registries: 1, activeSessions: 2,
    });
    releaseBad();
    releaseHealthy();
  });
});
