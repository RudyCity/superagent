/**
 * Opaque, trusted agent/transport-scoped CLI Bridge admission context.
 *
 * Only MCP dispatch creates this context from verified transport identity.
 * Untrusted tool parameters (agentId, clientInfo, role) never set ownerId.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const scope = new AsyncLocalStorage<string>();
const OWNER = /^mcp:[a-f0-9]{64}$/;

export function runWithTrustedCliBridgeAgent<T>(
  ownerId: string,
  action: () => T,
): T {
  if (!OWNER.test(ownerId)) throw new Error("Invalid trusted MCP owner admission context.");
  return scope.run(ownerId, action);
}

export function getTrustedCliBridgeAgent(): string | null {
  return scope.getStore() ?? null;
}
