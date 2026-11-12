/**
 * mcpSessionRegistry.ts - Per-session MCP transport registry.
 *
 * Replaces the old singleton transport: every MCP client session gets its own
 * StreamableHTTPServerTransport + MCP server pair, keyed by `mcp-session-id`.
 *
 * Lifecycle:
 * - A session is added after a successful initialize (transport.sessionId set).
 * - Sessions are removed on DELETE, transport close, idle timeout, max
 *   lifetime expiry, or server shutdown.
 * - Bounded globally and per authenticated principal.
 *
 * Isolation: a session's transport and auth identity are only reachable via
 * its own session ID; telemetry exposes aggregate counts only.
 */

import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpIdentity } from "./mcpAuth.js";

export interface McpSessionEntry {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  identity: McpIdentity;
  createdAt: number;
  lastActivityAt: number;
}

export type McpSessionRemovalReason =
  | "client_delete"
  | "transport_close"
  | "idle_timeout"
  | "max_lifetime"
  | "shutdown"
  | "internal";

export interface McpSessionRegistryStats {
  activeSessions: number;
  activePrincipals: number;
  largestPrincipalSessionCount: number;
  oldestSessionAgeMs: number;
  oldestIdleMs: number;
  maxSessions: number;
  maxSessionsPerPrincipal: number;
  createdTotal: number;
  removedTotal: number;
  rejectedGlobal: number;
  rejectedPrincipal: number;
  removals: Record<McpSessionRemovalReason, number>;
}

export interface McpSessionRegistryOptions {
  /** Max concurrent sessions across all principals (default 32). */
  maxSessions?: number;
  /** Max concurrent sessions for one authenticated principal (default 8). */
  maxSessionsPerPrincipal?: number;
  /** Close sessions idle longer than this (default 30 min). */
  idleTimeoutMs?: number;
  /** Hard cap on session age (default 4 hours). */
  maxLifetimeMs?: number;
  /** Notify an outer transport owner after a session leaves this registry. */
  onSessionRemoved?: (sessionId: string, reason: McpSessionRemovalReason) => void;
}

export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = 8;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

const REMOVAL_REASONS: readonly McpSessionRemovalReason[] = [
  "client_delete", "transport_close", "idle_timeout",
  "max_lifetime", "shutdown", "internal",
];

function emptyRemovalCounts(): Record<McpSessionRemovalReason, number> {
  return Object.fromEntries(REMOVAL_REASONS.map((reason) => [reason, 0])) as
    Record<McpSessionRemovalReason, number>;
}

function principalKey(identity: McpIdentity): string {
  // OAuth subject is the authenticated client id. Static bearer uses one
  // shared subject by design. Never expose this key through telemetry.
  return identity.mode + "\0" + identity.subject;
}

export class McpSessionRegistry {
  private sessions = new Map<string, McpSessionEntry>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private lifetimeTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxSessions: number;
  private readonly maxSessionsPerPrincipal: number;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly onSessionRemoved?: (sessionId: string, reason: McpSessionRemovalReason) => void;
  private createdTotal = 0;
  private removedTotal = 0;
  private rejectedGlobal = 0;
  private rejectedPrincipal = 0;
  private removals = emptyRemovalCounts();

  constructor(opts: McpSessionRegistryOptions = {}) {
    this.maxSessions = Math.max(1, Math.floor(opts.maxSessions ?? DEFAULT_MAX_SESSIONS));
    this.maxSessionsPerPrincipal = Math.max(
      1,
      Math.min(this.maxSessions, Math.floor(
        opts.maxSessionsPerPrincipal ?? DEFAULT_MAX_SESSIONS_PER_PRINCIPAL,
      )),
    );
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = opts.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    this.onSessionRemoved = opts.onSessionRemoved;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): McpSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  isFull(): boolean {
    return this.sessions.size >= this.maxSessions;
  }

  countForPrincipal(identity: McpIdentity): number {
    const key = principalKey(identity);
    let count = 0;
    for (const session of this.sessions.values()) {
      if (principalKey(session.identity) === key) count++;
    }
    return count;
  }

  isFullFor(identity: McpIdentity): boolean {
    return this.countForPrincipal(identity) >= this.maxSessionsPerPrincipal;
  }

  snapshot(now = Date.now()): McpSessionRegistryStats {
    const principalCounts = new Map<string, number>();
    let oldestSessionAgeMs = 0;
    let oldestIdleMs = 0;
    for (const session of this.sessions.values()) {
      const key = principalKey(session.identity);
      principalCounts.set(key, (principalCounts.get(key) ?? 0) + 1);
      oldestSessionAgeMs = Math.max(oldestSessionAgeMs, Math.max(0, now - session.createdAt));
      oldestIdleMs = Math.max(oldestIdleMs, Math.max(0, now - session.lastActivityAt));
    }
    return {
      activeSessions: this.sessions.size,
      activePrincipals: principalCounts.size,
      largestPrincipalSessionCount: Math.max(0, ...principalCounts.values()),
      oldestSessionAgeMs,
      oldestIdleMs,
      maxSessions: this.maxSessions,
      maxSessionsPerPrincipal: this.maxSessionsPerPrincipal,
      createdTotal: this.createdTotal,
      removedTotal: this.removedTotal,
      rejectedGlobal: this.rejectedGlobal,
      rejectedPrincipal: this.rejectedPrincipal,
      removals: { ...this.removals },
    };
  }

  /**
   * Register a new session. Throws if the ID is taken or capacity is exhausted.
   * Arms idle + lifetime timers.
   */
  add(entry: McpSessionEntry): void {
    if (!entry.sessionId) throw new Error("sessionId is required");
    if (this.sessions.has(entry.sessionId)) throw new Error("session ID already registered");
    if (this.isFull()) {
      this.rejectedGlobal++;
      throw new Error("too many concurrent MCP sessions");
    }
    if (this.isFullFor(entry.identity)) {
      this.rejectedPrincipal++;
      throw new Error("too many concurrent MCP sessions for principal");
    }
    this.sessions.set(entry.sessionId, entry);
    this.createdTotal++;
    this.armIdleTimer(entry.sessionId);
    const lt = setTimeout(() => {
      void this.remove(entry.sessionId, "max_lifetime");
    }, this.maxLifetimeMs);
    lt.unref?.();
    this.lifetimeTimers.set(entry.sessionId, lt);
  }

  /** Mark activity; resets the idle timer. */
  touch(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.lastActivityAt = Date.now();
    this.armIdleTimer(sessionId);
  }

  /**
   * Close and remove a session. Returns true if a session was removed.
   * Never throws.
   */
  async remove(
    sessionId: string,
    reason: McpSessionRemovalReason = "internal",
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.clearTimers(sessionId);
    this.sessions.delete(sessionId);
    this.removedTotal++;
    this.removals[reason]++;
    try {
      this.onSessionRemoved?.(sessionId, reason);
    } catch {
      /* registry cleanup must not depend on an observer */
    }
    try {
      await s.transport.close();
    } catch {
      /* ignore close errors */
    }
    return true;
  }

  /** Close and remove all sessions (server shutdown). Never throws. */
  async closeAll(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.remove(id, "shutdown");
    }
  }

  private armIdleTimer(sessionId: string): void {
    const prev = this.idleTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      void this.remove(sessionId, "idle_timeout");
    }, this.idleTimeoutMs);
    t.unref?.();
    this.idleTimers.set(sessionId, t);
  }

  private clearTimers(sessionId: string): void {
    const i = this.idleTimers.get(sessionId);
    if (i) {
      clearTimeout(i);
      this.idleTimers.delete(sessionId);
    }
    const l = this.lifetimeTimers.get(sessionId);
    if (l) {
      clearTimeout(l);
      this.lifetimeTimers.delete(sessionId);
    }
  }
}
