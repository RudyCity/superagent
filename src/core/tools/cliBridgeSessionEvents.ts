/**
 * v1.5.17: Session event subsystem.
 *
 * Splits out the event emitter, ring buffer, subscribers, and idle-TTL
 * scanner from `cliBridgeSession.ts` so the session module itself stays
 * under the 1000-line project guideline.
 *
 * The split is purely organizational — the session module still owns
 * the `CliSession` record and the subprocess lifecycle; this module
 * only owns the *observation* surface: how callers watch what the
 * session does. Public functions in the session module (subscribeSession,
 * tailEvents, setIdleTimeout, etc.) read/write the maps declared here.
 */

import { EventEmitter } from "node:events";
import type { CliSession, DetectedPrompt } from "./cliBridgeSession.js";

// ─── Public types ───────────────────────────────────────────────────────

export type SessionEventType = "stdout" | "stderr" | "prompt" | "exit" | "status";

export interface SessionEvent {
  /** Monotonically increasing per session, starting at 1. */
  seq: number;
  type: SessionEventType;
  /** Wall-clock timestamp (ms). */
  at: number;
  /** Event payload. */
  data: {
    line?: string;
    isPrompt?: boolean;
    prompt?: DetectedPrompt;
    code?: number | null;
    signal?: string | null;
    status?: CliSession["status"];
  };
}

export type SessionEventListener = (ev: SessionEvent) => void;

export interface SessionSubscription {
  /** Stop receiving events. Safe to call multiple times. */
  unsubscribe(): void;
  /** Buffer of past events received so far (for late subscribers). */
  replay: SessionEvent[];
  /** Last delivered seq (so a fresh subscriber can request `since`). */
  lastSeq: number;
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Default number of events retained per session for replay. */
export const MAX_EVENT_BUFFER = 500;
/** How often the idle scanner runs. */
export const IDLE_SCAN_INTERVAL_MS = 60 * 1000;

// ─── Module state ───────────────────────────────────────────────────────

/** Per-session EventEmitter so cross-session events don't leak. */
export const sessionEmitters = new Map<string, EventEmitter>();
/** Per-session ring buffer of past events. */
export const sessionEventBuffers = new Map<string, SessionEvent[]>();
/** Per-session monotonic seq counter. */
export const sessionSeqCounters = new Map<string, number>();
/** Per-session set of listener callbacks. */
export const sessionSubscribers = new Map<string, Set<SessionEventListener>>();

/** Lazy idle scanner handle. */
export let idleScanHandle: NodeJS.Timeout | null = null;

// ─── Emitter helpers ───────────────────────────────────────────────────

/**
 * Internal: call from the session module's stdout/stderr/status/exit
 * listeners. Bumps the per-session seq counter, appends to the ring
 * buffer, and fans out to any active subscribers. Listener exceptions
 * are swallowed so a buggy subscriber cannot break the session.
 */
export function emitEvent(
  session: CliSession,
  type: SessionEventType,
  data: SessionEvent["data"]
): void {
  const seq = (sessionSeqCounters.get(session.sessionId) ?? 0) + 1;
  sessionSeqCounters.set(session.sessionId, seq);
  const ev: SessionEvent = { seq, type, at: Date.now(), data };

  // Append to ring buffer.
  const buf = sessionEventBuffers.get(session.sessionId) ?? [];
  buf.push(ev);
  if (buf.length > MAX_EVENT_BUFFER) buf.shift();
  sessionEventBuffers.set(session.sessionId, buf);

  // Notify subscribers (if any).
  const subs = sessionSubscribers.get(session.sessionId);
  if (subs && subs.size > 0) {
    for (const fn of subs) {
      try {
        fn(ev);
      } catch {
        // Listener errors must not break other listeners.
      }
    }
  }

  // Also fire the EventEmitter (for any external listeners — mostly tests).
  const em = sessionEmitters.get(session.sessionId);
  if (em) em.emit(type, ev);
}

/** Lazy emitter per session so subscribers don't see cross-session events. */
export function ensureEmitter(sessionId: string): EventEmitter {
  let em = sessionEmitters.get(sessionId);
  if (!em) {
    em = new EventEmitter();
    em.setMaxListeners(50);
    sessionEmitters.set(sessionId, em);
  }
  return em;
}

/** Set the idle scanner handle. Exposed so session module can stop it. */
export function setIdleScanHandle(h: NodeJS.Timeout | null): void {
  if (idleScanHandle && idleScanHandle !== h) {
    clearInterval(idleScanHandle);
  }
  idleScanHandle = h;
}

/** Get the current idle scanner handle. */
export function getIdleScanHandle(): NodeJS.Timeout | null {
  return idleScanHandle;
}

/** Internal — used by `__resetForTests` to wipe all v1.5.17 event state. */
export function __resetEventStateForTests(): void {
  sessionEmitters.forEach((em) => em.removeAllListeners());
  sessionEmitters.clear();
  sessionEventBuffers.clear();
  sessionSeqCounters.clear();
  sessionSubscribers.clear();
  if (idleScanHandle) {
    clearInterval(idleScanHandle);
    idleScanHandle = null;
  }
}
