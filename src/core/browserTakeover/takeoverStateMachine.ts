/**
 * Takeover State Machine (Milestone M3)
 *
 * Implements authoritative state transitions, session persistence,
 * and audit logging for Human-in-the-Loop browser takeover sessions.
 *
 * Invariants:
 * 1. Plaintext tokens, passwords, or cookies are NEVER written to disk.
 * 2. URL parameters/fragments are stripped from metadata before saving.
 * 3. Transitions must strictly follow the allowed state graph.
 * 4. Persistence uses atomic temporary file writes + rename.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  type TakeoverState,
  type TakeoverSession,
  type TakeoverAuditEntry,
} from "./types.js";

const VALID_TRANSITIONS: Record<TakeoverState, readonly TakeoverState[]> = {
  AGENT_ACTIVE: ["HUMAN_REQUESTED", "CANCELLED"],
  HUMAN_REQUESTED: ["HUMAN_READY", "CANCELLED", "EXPIRED"],
  HUMAN_READY: ["HUMAN_ACTIVE", "CANCELLED", "EXPIRED"],
  HUMAN_ACTIVE: ["RETURN_REQUESTED", "CANCELLED", "EXPIRED"],
  RETURN_REQUESTED: ["VERIFYING", "CANCELLED", "EXPIRED"],
  VERIFYING: ["AGENT_ACTIVE", "PAUSED_NEEDS_REVIEW", "CANCELLED"],
  PAUSED_NEEDS_REVIEW: ["VERIFYING", "AGENT_ACTIVE", "CANCELLED"],
  CANCELLED: [],
  EXPIRED: ["PAUSED_NEEDS_REVIEW", "CANCELLED"],
};

/**
 * Returns default root directory for takeover session files.
 */
export function getTakeoverSessionsDir(customDir?: string): string {
  if (customDir) return customDir;
  return path.join(os.homedir(), ".superagent-r", "browser-takeover", "sessions");
}

/**
 * Strips sensitive search parameters and fragments from URLs before metadata recording.
 */
export function sanitizeUrlForAudit(rawUrl?: string): string | undefined {
  if (!rawUrl || typeof rawUrl !== "string") return undefined;
  try {
    const parsed = new URL(rawUrl);
    // Keep protocol, hostname, port, and pathname only. Strip search and hash!
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    // If not a valid URL, truncate and strip query/hash tokens
    return rawUrl.split("?")[0]?.split("#")[0]?.slice(0, 256);
  }
}

/**
 * Checks whether a state transition is permitted.
 */
export function canTransition(from: TakeoverState, to: TakeoverState): boolean {
  if (from === to) return true; // Idempotent self-transitions allowed
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Validates a state transition and throws if invalid.
 */
export function assertValidTransition(from: TakeoverState, to: TakeoverState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid takeover state transition: cannot transition from '${from}' to '${to}'.`);
  }
}

/**
 * Applies a state transition to a session, appending to the audit trail.
 */
export function transitionSession(
  session: TakeoverSession,
  nextState: TakeoverState,
  actor = "system",
  details?: string
): TakeoverSession {
  assertValidTransition(session.state, nextState);

  const now = Date.now();
  const auditEntry: TakeoverAuditEntry = {
    timestamp: now,
    from: session.state,
    to: nextState,
    actor,
    details,
  };

  const updated: TakeoverSession = {
    ...session,
    state: nextState,
    updatedAt: now,
    auditTrail: [...session.auditTrail, auditEntry],
  };

  if (nextState === "HUMAN_ACTIVE" && !updated.humanActiveAt) {
    updated.humanActiveAt = now;
  } else if (nextState === "RETURN_REQUESTED" && !updated.returnedAt) {
    updated.returnedAt = now;
  } else if (nextState === "AGENT_ACTIVE" && !updated.verifiedAt) {
    updated.verifiedAt = now;
    updated.resolution = "verified";
  } else if (nextState === "PAUSED_NEEDS_REVIEW") {
    updated.resolution = "needs_review";
  } else if (nextState === "CANCELLED") {
    updated.resolution = "cancelled";
  } else if (nextState === "EXPIRED") {
    updated.resolution = "expired";
  }

  return updated;
}

/**
 * Persists a takeover session to disk atomically.
 */
export async function saveTakeoverSession(
  session: TakeoverSession,
  customDir?: string
): Promise<void> {
  const dir = getTakeoverSessionsDir(customDir);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

  const filePath = path.join(dir, `${session.sessionId}.json`);
  const tempPath = path.join(dir, `${session.sessionId}.${randomUUID()}.tmp`);

  // Ensure targetUrl is sanitized before writing
  const safeSession: TakeoverSession = {
    ...session,
    targetUrl: sanitizeUrlForAudit(session.targetUrl),
  };

  const payload = JSON.stringify(safeSession, null, 2);

  try {
    await fsp.writeFile(tempPath, payload, { mode: 0o600, flag: "wx" });
    await fsp.rename(tempPath, filePath);
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        await fsp.unlink(tempPath);
      }
    } catch {}
  }
}

/**
 * Loads a takeover session from disk.
 */
export async function loadTakeoverSession(
  sessionId: string,
  customDir?: string
): Promise<TakeoverSession | null> {
  if (!/^[a-f0-9-]{36}$/.test(sessionId)) {
    return null;
  }

  const dir = getTakeoverSessionsDir(customDir);
  const filePath = path.join(dir, `${sessionId}.json`);

  try {
    const raw = await fsp.readFile(filePath, "utf8");
    if (raw.length > 64 * 1024) {
      // Reject oversized session files
      return null;
    }
    const parsed = JSON.parse(raw) as TakeoverSession;
    if (parsed.sessionId !== sessionId || typeof parsed.state !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Lists all active and recent takeover sessions.
 */
export async function listTakeoverSessions(customDir?: string): Promise<TakeoverSession[]> {
  const dir = getTakeoverSessionsDir(customDir);
  if (!fs.existsSync(dir)) return [];

  const files = await fsp.readdir(dir);
  const sessions: TakeoverSession[] = [];

  for (const file of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f)).slice(0, 100)) {
    const id = file.slice(0, -5);
    const session = await loadTakeoverSession(id, customDir);
    if (session) {
      sessions.push(session);
    }
  }

  return sessions.sort((a, b) => b.createdAt - a.createdAt);
}
