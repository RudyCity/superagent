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
 * - Bounded: max concurrent sessions, idle timeout, and max lifetime all have
 *   safe defaults and are configurable.
 *
 * Isolation: a session's transport and auth identity are only reachable via
 * its own session ID; the registry never exposes one session to another.
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

export interface McpSessionRegistryOptions {
  /** Max concurrent sessions (default 32). */
  maxSessions?: number;
  /** Close sessions idle longer than this (default 30 min). */
  idleTimeoutMs?: number;
  /** Hard cap on session age (default 4 hours). */
  maxLifetimeMs?: number;
}

export const DEFAULT_MAX_SESSIONS = 32;
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;

export class McpSessionRegistry {
  private sessions = new Map<string, McpSessionEntry>();
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private lifetimeTimers = new Map<string, NodeJS.Timeout>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly maxLifetimeMs: number;

  constructor(opts: McpSessionRegistryOptions = {}) {
    this.maxSessions = opts.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxLifetimeMs = opts.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
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

  /**
   * Register a new session. Throws if the ID is taken or the registry is full.
   * Arms idle + lifetime timers.
   */
  add(entry: McpSessionEntry): void {
    if (!entry.sessionId) throw new Error("sessionId is required");
    if (this.sessions.has(entry.sessionId)) throw new Error("session ID already registered");
    if (this.isFull()) throw new Error("too many concurrent MCP sessions");
    this.sessions.set(entry.sessionId, entry);
    this.armIdleTimer(entry.sessionId);
    const lt = setTimeout(() => {
      void this.remove(entry.sessionId);
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
  async remove(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.clearTimers(sessionId);
    this.sessions.delete(sessionId);
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
      await this.remove(id);
    }
  }

  private armIdleTimer(sessionId: string): void {
    const prev = this.idleTimers.get(sessionId);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      void this.remove(sessionId);
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
