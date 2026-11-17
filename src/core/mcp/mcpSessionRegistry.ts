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
  inFlight?: number;
}

export type McpSessionRemovalReason =
  | "client_delete"
  | "transport_close"
  | "idle_timeout"
  | "max_lifetime"
  | "shutdown"
  | "capacity_eviction"
  | "internal";

export interface McpSessionRegistryStats {
  activeSessions: number;
  activePrincipals: number;
  largestPrincipalSessionCount: number;
  oldestSessionAgeMs: number;
  oldestIdleMs: number;
  inFlightSessions: number;
  retiringSessions: number;
  maxSessions: number;
  maxSessionsPerPrincipal: number;
  createdTotal: number;
  removedTotal: number;
  rejectedGlobal: number;
  rejectedPrincipal: number;
  removals: Record<McpSessionRemovalReason, number>;
}

function parseEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface McpSessionRegistryOptions {
  /** Max concurrent sessions across all principals (default 64, or SUPERAGENT_MCP_MAX_SESSIONS). */
  maxSessions?: number;
  /** Max concurrent sessions for one authenticated principal (default 16/32, or SUPERAGENT_MCP_MAX_SESSIONS_PER_PRINCIPAL). */
  maxSessionsPerPrincipal?: number;
  /** Close sessions idle longer than this (default 10 min, or SUPERAGENT_MCP_SESSION_IDLE_TIMEOUT_MS). */
  idleTimeoutMs?: number;
  /** Hard cap on session age (default 4 hours, or SUPERAGENT_MCP_SESSION_MAX_LIFETIME_MS). */
  maxLifetimeMs?: number;
  /** Minimum idle duration in ms before an inactive session can be evicted under capacity contention (default 1000ms). */
  minIdleAgeMs?: number;
  /** Notify an outer transport owner after a session leaves this registry. */
  onSessionRemoved?: (sessionId: string, reason: McpSessionRemovalReason) => void;
}

export const DEFAULT_MAX_SESSIONS = parseEnvInt("SUPERAGENT_MCP_MAX_SESSIONS", 64);
export const DEFAULT_MAX_SESSIONS_PER_PRINCIPAL = parseEnvInt("SUPERAGENT_MCP_MAX_SESSIONS_PER_PRINCIPAL", 16);
export const DEFAULT_IDLE_TIMEOUT_MS = parseEnvInt("SUPERAGENT_MCP_SESSION_IDLE_TIMEOUT_MS", 10 * 60 * 1000);
export const DEFAULT_MAX_LIFETIME_MS = parseEnvInt("SUPERAGENT_MCP_SESSION_MAX_LIFETIME_MS", 4 * 60 * 60 * 1000);
export const DEFAULT_MIN_IDLE_AGE_MS = 1000;

const REMOVAL_REASONS: readonly McpSessionRemovalReason[] = [
  "client_delete", "transport_close", "idle_timeout",
  "max_lifetime", "shutdown", "capacity_eviction", "internal",
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
  private retiringSessions = new Map<string, McpSessionRemovalReason>();
  private readonly maxSessions: number;
  private readonly maxSessionsPerPrincipal: number;
  private readonly explicitMaxSessionsPerPrincipal: boolean;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;
  private readonly minIdleAgeMs: number;
  private readonly onSessionRemoved?: (sessionId: string, reason: McpSessionRemovalReason) => void;
  private createdTotal = 0;
  private removedTotal = 0;
  private rejectedGlobal = 0;
  private rejectedPrincipal = 0;
  private removals = emptyRemovalCounts();

  constructor(opts: McpSessionRegistryOptions = {}) {
    this.maxSessions = Math.max(1, Math.floor(opts.maxSessions ?? DEFAULT_MAX_SESSIONS));
    this.explicitMaxSessionsPerPrincipal = opts.maxSessionsPerPrincipal !== undefined;
    this.maxSessionsPerPrincipal = Math.max(
      1,
      Math.min(this.maxSessions, Math.floor(
        opts.maxSessionsPerPrincipal ?? DEFAULT_MAX_SESSIONS_PER_PRINCIPAL,
      )),
    );
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = opts.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
    this.minIdleAgeMs = opts.minIdleAgeMs ?? DEFAULT_MIN_IDLE_AGE_MS;
    this.onSessionRemoved = opts.onSessionRemoved;
  }

  get size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): McpSessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /** Max lifetime elapsed; only already-running requests may finish. */
  isRetiring(sessionId: string): boolean {
    return this.retiringSessions.has(sessionId);
  }

  /** Private worker-to-owner reconciliation only; never expose IDs via status. */
  activeSessionIds(): string[] {
    return [...this.sessions.keys()];
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

  maxSessionsFor(identity: McpIdentity): number {
    if (!this.explicitMaxSessionsPerPrincipal && identity.mode === "static-bearer") {
      // In static-bearer mode, all local subagents and CLI bridge workers share
      // the single bearer subject. Provide a higher ceiling (up to maxSessions)
      // to avoid false-positive principal saturation.
      return Math.max(this.maxSessionsPerPrincipal, Math.min(this.maxSessions, 32));
    }
    return this.maxSessionsPerPrincipal;
  }

  isFullFor(identity: McpIdentity): boolean {
    return this.countForPrincipal(identity) >= this.maxSessionsFor(identity);
  }

  snapshot(now = Date.now()): McpSessionRegistryStats {
    const principalCounts = new Map<string, number>();
    let oldestSessionAgeMs = 0;
    let oldestIdleMs = 0;
    let inFlightSessions = 0;
    for (const session of this.sessions.values()) {
      if ((session.inFlight ?? 0) > 0) inFlightSessions++;
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
      inFlightSessions,
      retiringSessions: this.retiringSessions.size,
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
   * Track request lifecycle for in-flight safety so active sessions are never
   * prematurely evicted while executing an MCP call.
   */
  beginRequest(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.inFlight = (s.inFlight ?? 0) + 1;
    s.lastActivityAt = Date.now();
    this.armIdleTimer(sessionId);
  }

  endRequest(sessionId: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.inFlight = Math.max(0, (s.inFlight ?? 1) - 1);
    const pendingRemoval = this.retiringSessions.get(sessionId);
    if (s.inFlight === 0 && pendingRemoval) {
      void this.remove(sessionId, pendingRemoval);
      return;
    }
    s.lastActivityAt = Date.now();
    this.armIdleTimer(sessionId);
  }

  /**
   * Proactively evicts the oldest idle session (not currently in-flight)
   * if its idle duration exceeds minIdleAgeMs (default: this.minIdleAgeMs).
   *
   * If identity is provided, evicts the oldest idle session for that principal.
   * If identity is omitted, evicts the oldest idle session globally.
   *
   * Returns true if an idle session was evicted, false otherwise.
   */
  evictOldestIdle(
    identity?: McpIdentity,
    minIdleAgeMs = this.minIdleAgeMs,
    now = Date.now(),
  ): boolean {
    let candidate: McpSessionEntry | undefined;

    if (identity) {
      const targetKey = principalKey(identity);
      for (const session of this.sessions.values()) {
        if (principalKey(session.identity) !== targetKey) continue;
        if ((session.inFlight ?? 0) > 0) continue;
        if (now - session.lastActivityAt < minIdleAgeMs) continue;
        if (!candidate || session.lastActivityAt < candidate.lastActivityAt) {
          candidate = session;
        }
      }
    } else {
      for (const session of this.sessions.values()) {
        if ((session.inFlight ?? 0) > 0) continue;
        if (now - session.lastActivityAt < minIdleAgeMs) continue;
        if (!candidate || session.lastActivityAt < candidate.lastActivityAt) {
          candidate = session;
        }
      }
    }

    if (!candidate) return false;
    void this.remove(candidate.sessionId, "capacity_eviction");
    return true;
  }

  /**
   * Register a new session. Throws if the ID is taken or capacity is exhausted.
   * Proactively reaps idle sessions under capacity contention.
   * Arms idle + lifetime timers.
   */
  add(
    entry: McpSessionEntry,
    options: { allowEviction?: boolean; minIdleAgeMs?: number } = {},
  ): void {
    if (!entry.sessionId) throw new Error("sessionId is required");
    if (this.sessions.has(entry.sessionId)) throw new Error("session ID already registered");

    const allowEviction = options.allowEviction ?? true;
    const minIdleAgeMs = options.minIdleAgeMs ?? this.minIdleAgeMs;

    if (this.isFull()) {
      if (!allowEviction || !this.evictOldestIdle(undefined, minIdleAgeMs)) {
        this.rejectedGlobal++;
        throw new Error("too many concurrent MCP sessions");
      }
    }
    if (this.isFullFor(entry.identity)) {
      if (!allowEviction || !this.evictOldestIdle(entry.identity, minIdleAgeMs)) {
        this.rejectedPrincipal++;
        throw new Error("too many concurrent MCP sessions for principal");
      }
    }
    this.sessions.set(entry.sessionId, entry);
    this.createdTotal++;
    this.armIdleTimer(entry.sessionId);
    const lt = setTimeout(() => {
      const current = this.sessions.get(entry.sessionId);
      if (!current) return;
      if ((current.inFlight ?? 0) > 0) {
        // Existing work/SSE must complete; do not accept new requests.
        this.retiringSessions.set(entry.sessionId, "max_lifetime");
        return;
      }
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
   * Close a session, deferring client DELETE and transport-close until all
   * already-accepted requests finish. New requests are rejected while retiring.
   * Returns true if removed or scheduled for removal. Never throws.
   */
  async remove(
    sessionId: string,
    reason: McpSessionRemovalReason = "internal",
  ): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    if ((reason === "client_delete" || reason === "transport_close") &&
        (s.inFlight ?? 0) > 0) {
      if (!this.retiringSessions.has(sessionId)) this.retiringSessions.set(sessionId, reason);
      return true;
    }
    this.clearTimers(sessionId);
    this.retiringSessions.delete(sessionId);
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
      const current = this.sessions.get(sessionId);
      // A live request or SSE response is not an idle session. endRequest
      // starts a fresh idle period after the response actually closes.
      if (current && (current.inFlight ?? 0) === 0) {
        void this.remove(sessionId, "idle_timeout");
      }
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
