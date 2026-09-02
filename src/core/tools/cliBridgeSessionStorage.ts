/**
 * cliBridgeSessionStorage.ts — Disk persistence for cli_bridge sessions.
 *
 * Saves, loads, and syncs session metadata (sessionId, cliAlias, binary,
 * status, conversationId, cwd, skills, logs) to ~/.superagent-r/cli-bridge/sessions.json
 * so sessions remain persistent and resumable across Superagent restarts.
 */

import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import { getRootConfigDir } from "../config/paths.js";
import type { CliSession } from "./cliBridgeSession.js";

const SESSIONS_SUBDIR = "cli-bridge";
const SESSIONS_FILE = "sessions.json";

function getSessionsPath(): string {
  return path.join(getRootConfigDir(), SESSIONS_SUBDIR, SESSIONS_FILE);
}

function ensureStorageDirSync(): void {
  const dir = path.join(getRootConfigDir(), SESSIONS_SUBDIR);
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort
    }
  }
}

async function ensureStorageDir(): Promise<void> {
  const dir = path.join(getRootConfigDir(), SESSIONS_SUBDIR);
  try {
    await fsPromises.mkdir(dir, { recursive: true });
  } catch {
    // best-effort
  }
}

export type PersistedSessionRecord = Omit<CliSession, "stdoutBuffer" | "stderrBuffer"> & {
  lastUpdated: number;
};

function serializeSession(s: CliSession): PersistedSessionRecord {
  return {
    sessionId: s.sessionId,
    cliAlias: s.cliAlias,
    binary: s.binary,
    pid: s.pid,
    logPath: s.logPath,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    status: s.status,
    exitCode: s.exitCode,
    signalBound: s.signalBound,
    conversationId: s.conversationId,
    skills: s.skills,
    cwd: s.cwd,
    pendingPrompt: s.pendingPrompt,
    profileAlias: s.profileAlias,
    systemPrompt: s.systemPrompt,
    unresolvedSkills: s.unresolvedSkills,
    maxBufferLines: s.maxBufferLines,
    lastOutputAt: s.lastOutputAt,
    idleTimeoutMs: s.idleTimeoutMs,
    autoKilled: s.autoKilled,
    autoSendInitial: s.autoSendInitial,
    pendingInitialMessage: s.pendingInitialMessage,
    detached: s.detached,
    currentStage: s.currentStage,
    lastOutputLine: s.lastOutputLine,
    totalLinesEmitted: s.totalLinesEmitted,
    lastUpdated: Date.now(),
  };
}

function deserializeSession(rec: PersistedSessionRecord): CliSession {
  return {
    ...rec,
    stdoutBuffer: "",
    stderrBuffer: "",
  };
}

/**
 * Load all persisted session records from disk.
 */
export function loadAllSessionRecords(): Map<string, CliSession> {
  const map = new Map<string, CliSession>();
  const filePath = getSessionsPath();
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [id, rec] of Object.entries(parsed)) {
          if (rec && typeof rec === "object") {
            map.set(id, deserializeSession(rec as PersistedSessionRecord));
          }
        }
      }
    }
  } catch {
    // best-effort
  }
  return map;
}

/**
 * Save or update a single session record to disk.
 */
export async function saveSessionRecord(session: CliSession): Promise<void> {
  await ensureStorageDir();
  const filePath = getSessionsPath();
  try {
    const all = loadAllSessionRecords();
    all.set(session.sessionId, deserializeSession(serializeSession(session)));
    const obj: Record<string, PersistedSessionRecord> = {};
    for (const [id, s] of all.entries()) {
      obj[id] = serializeSession(s);
    }
    await fsPromises.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Synchronous save for process exit hooks.
 */
export function saveSessionRecordSync(session: CliSession): void {
  ensureStorageDirSync();
  const filePath = getSessionsPath();
  try {
    const all = loadAllSessionRecords();
    all.set(session.sessionId, deserializeSession(serializeSession(session)));
    const obj: Record<string, PersistedSessionRecord> = {};
    for (const [id, s] of all.entries()) {
      obj[id] = serializeSession(s);
    }
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Save multiple sessions at once.
 */
export async function saveAllSessionRecords(sessions: Iterable<CliSession>): Promise<void> {
  await ensureStorageDir();
  const filePath = getSessionsPath();
  try {
    const all = loadAllSessionRecords();
    for (const s of sessions) {
      all.set(s.sessionId, deserializeSession(serializeSession(s)));
    }
    const obj: Record<string, PersistedSessionRecord> = {};
    for (const [id, s] of all.entries()) {
      obj[id] = serializeSession(s);
    }
    await fsPromises.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Retrieve a persisted session by ID.
 */
export function getPersistedSession(sessionId: string): CliSession | null {
  const all = loadAllSessionRecords();
  return all.get(sessionId) ?? null;
}

/**
 * Delete a session record from disk.
 */
export async function deleteSessionRecord(sessionId: string): Promise<void> {
  const filePath = getSessionsPath();
  try {
    const all = loadAllSessionRecords();
    if (all.delete(sessionId)) {
      const obj: Record<string, PersistedSessionRecord> = {};
      for (const [id, s] of all.entries()) {
        obj[id] = serializeSession(s);
      }
      await fsPromises.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
    }
  } catch {
    // best-effort
  }
}

/**
 * Clear all persisted session records from disk (for tests).
 */
export function clearAllSessionRecords(): void {
  const filePath = getSessionsPath();
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // best-effort
  }
}
